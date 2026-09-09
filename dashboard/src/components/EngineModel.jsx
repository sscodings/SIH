import React, { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Realistic Rotax 914F Cylinder Head Temperature (CHT) Color Interpolation
// Rotax 914 operating range: 80°C - 110°C, Caution: 110°C - 135°C, Redline: 135°C
function computeChtColor(temp) {
  const t = Number(temp) || 85;
  if (t <= 75) {
    return new THREE.Color(0.52, 0.55, 0.60); // Cold / warmup metal grey
  } else if (t < 105) {
    // Normal operating temperature (75°C - 105°C): Healthy warm metallic sheen
    const factor = (t - 75) / 30.0;
    const cold = new THREE.Color(0.52, 0.55, 0.60);
    const warm = new THREE.Color(0.68, 0.66, 0.58);
    return cold.lerp(warm, factor);
  } else if (t < 120) {
    // Elevated warming (105°C - 120°C): Visible amber warming
    const factor = (t - 105) / 15.0;
    const warm = new THREE.Color(0.68, 0.66, 0.58);
    const amber = new THREE.Color(0.98, 0.62, 0.10);
    return warm.lerp(amber, factor);
  } else if (t < 135) {
    // High warning (120°C - 135°C): Hot orange to warning red
    const factor = (t - 120) / 15.0;
    const amber = new THREE.Color(0.98, 0.62, 0.10);
    const hotRed = new THREE.Color(0.95, 0.18, 0.12);
    return amber.lerp(hotRed, factor);
  } else {
    // Critical overheat (> 135°C Rotax redline): Pure critical red
    return new THREE.Color(0.98, 0.08, 0.08);
  }
}

// Canonical mapping of 0-indexed engine cylinders to 3D CAD mesh nodes in rotax914.glb
// In Three.js GLTFLoader, node names are sanitized (spaces become underscores, dots stripped).
// Rotax 914 horizontally opposed boxer layout:
// - Cylinder 1 (index 0): Front Right -> 'Cylindr_1' (+ head 'Rotax_914001')
// - Cylinder 2 (index 1): Front Left  -> 'Cylindr_2001'
// - Cylinder 3 (index 2): Rear Right  -> 'Cylindr_1001' (+ head 'Rotax_914004')
// - Cylinder 4 (index 3): Rear Left   -> 'Cylindr_2'
export const CYLINDER_NODE_MAP = [
  'Cylindr_1',      // Cylinder 1 (index 0) - Front Right
  'Cylindr_2001',   // Cylinder 2 (index 1) - Front Left
  'Cylindr_1001',   // Cylinder 3 (index 2) - Rear Right
  'Cylindr_2',      // Cylinder 4 (index 3) - Rear Left
];

// Helper to look up nodes regardless of raw vs sanitized Three.js naming
export function findMeshNode(nodes, name) {
  if (!nodes || !name) return null;
  if (nodes[name]) return nodes[name];
  const sanitized = name.replace(/\s+/g, '_').replace(/\./g, '');
  if (nodes[sanitized]) return nodes[sanitized];
  const withUnderscore = name.replace(/\s+/g, '_');
  if (nodes[withUnderscore]) return nodes[withUnderscore];
  const lower = name.toLowerCase().replace(/[\s\._]/g, '');
  for (const [k, v] of Object.entries(nodes)) {
    if (k.toLowerCase().replace(/[\s\._]/g, '') === lower) {
      return v;
    }
  }
  return null;
}

// Associated secondary meshes per cylinder (e.g. cylinder heads in rotax914.glb)
export const CYLINDER_COMPONENTS_MAP = [
  ['Cylindr_1', 'Rotax_914001'],
  ['Cylindr_2001'],
  ['Cylindr_1001', 'Rotax_914004'],
  ['Cylindr_2'],
];

// Map subsystem faults to CAD component node names
const FAULT_SUBSYSTEM_MAP = {
  lubrication_issues: ['Korpus_maslo', 'Filtr', 'Bachek', 'Datchik'],
  lubrication_issue: ['Korpus_maslo', 'Filtr', 'Bachek', 'Datchik'],
  cooling_degradation: [
    'Patrubok_voda_1', 'Patrubok_voda_2', 'Patrubok_voda_3', 'Patrubok_voda_4',
    'Patrubok_voda_niz_1m3d', 'Patrubok_voda_niz_2', 'Patrubok_voda_niz_3', 'Patrubok_voda_niz_4',
  ],
  abnormal_vibration: ['Korpus_reduktora', 'Flanec_1', 'Flanec_2', 'Flanec_vala_1', 'Levyi_karter_1', 'Pravyi_karter_1'],
  combustion_instability: ['Cylindr_1', 'Cylindr_2', 'Cylindr_1001', 'Cylindr_2001', 'Vhodnoy_kollektor'],
  overheating_trends: ['Turbina_1', 'Summator_vyhlopa', 'Truba_vyhlopnaya', 'Korpus_maslo'],
  overheating_trend: ['Turbina_1', 'Summator_vyhlopa', 'Truba_vyhlopnaya', 'Korpus_maslo'],
  injector_abnormalities: ['Vhodnoy_kollektor', 'Patrubok_vhodnoy'],
  injector_abnormal: ['Vhodnoy_kollektor', 'Patrubok_vhodnoy'],
  sensor_drift: ['Datchik'],
};

export function EngineModel({ telemetry }) {
  // Load model from public folder
  const { scene } = useGLTF('/rotax914.glb');
  const loggedNodesRef = useRef(false);
  const meshMapRef = useRef({});

  // 1. Initial PBR styling & deep-clone materials for EVERY mesh in the scene so styling NEVER leaks
  useEffect(() => {
    if (!scene) return;
    const map = {};

    scene.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;

        // Ensure each mesh has its own distinct, isolated material instance
        if (Array.isArray(child.material)) {
          child.material = child.material.map((m) => {
            const clone = m ? m.clone() : new THREE.MeshStandardMaterial();
            clone.metalness = 0.65;
            clone.roughness = 0.35;
            return clone;
          });
        } else if (child.material) {
          const clone = child.material.clone();
          clone.metalness = 0.65;
          clone.roughness = 0.35;
          child.material = clone;
        }

        // Register in mesh map by raw name and sanitized aliases
        const rawName = child.name || '';
        if (rawName) {
          map[rawName] = child;
          const sanitized = rawName.replace(/\s+/g, '_').replace(/\./g, '');
          map[sanitized] = child;
          const withUnderscore = rawName.replace(/\s+/g, '_');
          map[withUnderscore] = child;
          const lower = rawName.toLowerCase().replace(/[\s\._]/g, '');
          map[lower] = child;
        }
      }
    });

    meshMapRef.current = map;

    if (!loggedNodesRef.current) {
      console.log('[EngineModel] Initialized ' + Object.keys(map).length + ' isolated mesh references');
      loggedNodesRef.current = true;
    }
  }, [scene]);

  // 2. Per-frame dynamic highlighting of faulted parts + individual CHT heat coloring
  useFrame((state) => {
    if (!telemetry || !scene) return;
    const meshMap = meshMapRef.current;
    if (!meshMap || Object.keys(meshMap).length === 0) return;

    const isRunning = telemetry.is_running !== false && (telemetry.rpm > 300 || telemetry.t > 1.0);
    const chtList = isRunning ? (telemetry.cht_c || [85, 85, 85, 85]) : [20, 20, 20, 20];
    const mlDiag = telemetry.diagnostics?.ml_diagnostics || {};
    const activeFaults = telemetry.active_faults || [];

    // Track active developing progress (0.05 to 1.0) for every faulted component
    const highlightedProgressMap = {};

    // 1. Process all active injected faults (supports 1st, 2nd, and multiple simultaneous faults)
    if (isRunning && activeFaults.length > 0) {
      activeFaults.forEach((fault) => {
        const kind = fault.kind;
        const cyl = fault.cylinder;

        // Progressive ramp developing factor s (0.05 to 1.0)
        let progress = 1.0;
        if (typeof fault.progress === 'number') {
          progress = Math.max(0.05, Math.min(1.0, fault.progress));
        } else if (typeof fault.start_t === 'number' && typeof fault.ramp_s === 'number' && fault.ramp_s > 0) {
          const elapsed = Math.max(0.0, (telemetry.t || 0) - fault.start_t);
          progress = Math.max(0.05, Math.min(1.0, elapsed / fault.ramp_s));
        }

        const partList = [];
        if (kind === 'misfire') {
          const cIdx = (typeof cyl === 'number' && cyl >= 0 && cyl < 4) ? cyl : 0;
          CYLINDER_COMPONENTS_MAP[cIdx]?.forEach((p) => partList.push(p));
        } else if (kind === 'sensor_drift') {
          const cIdx = (typeof cyl === 'number' && cyl >= 0 && cyl < 4) ? cyl : 0;
          CYLINDER_COMPONENTS_MAP[cIdx]?.forEach((p) => partList.push(p));
          partList.push('Datchik');
        } else if (kind === 'injector_abnormalities' || kind === 'injector_abnormal') {
          partList.push('Vhodnoy_kollektor', 'Patrubok_vhodnoy');
          if (typeof cyl === 'number' && cyl >= 0 && cyl < 4) {
            CYLINDER_COMPONENTS_MAP[cyl]?.forEach((p) => partList.push(p));
          }
        } else if (FAULT_SUBSYSTEM_MAP[kind]) {
          FAULT_SUBSYSTEM_MAP[kind].forEach((p) => partList.push(p));
        } else if (kind === 'catastrophic_failure') {
          CYLINDER_COMPONENTS_MAP.flat().forEach((p) => partList.push(p));
          partList.push('Korpus_maslo', 'Levyi_karter_1', 'Pravyi_karter_1');
        }

        partList.forEach((pName) => {
          highlightedProgressMap[pName] = Math.max(highlightedProgressMap[pName] || 0, progress);
        });
      });
    } else if (isRunning && mlDiag.anomaly_detected && mlDiag.fault_type && mlDiag.fault_type !== 'none') {
      // Autonomous ML alert (no injected record)
      const kind = mlDiag.fault_type;
      const cyl = mlDiag.diagnosed_cylinder;
      const partList = [];
      if (kind === 'misfire') {
        const cIdx = (typeof cyl === 'number' && cyl >= 0 && cyl < 4) ? cyl : 0;
        CYLINDER_COMPONENTS_MAP[cIdx]?.forEach((p) => partList.push(p));
      } else if (FAULT_SUBSYSTEM_MAP[kind]) {
        FAULT_SUBSYSTEM_MAP[kind].forEach((p) => partList.push(p));
      }
      partList.forEach((pName) => {
        highlightedProgressMap[pName] = 1.0;
      });
    }

    const pulse = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 3.0);
    const baseColor = new THREE.Color(0.72, 0.76, 0.82);   // Brushed aluminum metallic
    const amberColor = new THREE.Color(0.98, 0.62, 0.10);  // Caution warming amber
    const redColor = new THREE.Color(0.95, 0.12, 0.15);    // Warning red

    // Helper to compute progressive color & emissive from progress factor (0.05 to 1.0)
    function computeProgressiveStyle(progress) {
      let matColor;
      if (progress < 0.5) {
        const t = progress / 0.5;
        matColor = baseColor.clone().lerp(amberColor, t);
      } else {
        const t = (progress - 0.5) / 0.5;
        matColor = amberColor.clone().lerp(redColor, t);
      }
      const emissiveColor = new THREE.Color(
        0.85 * pulse * progress,
        0.03 * progress,
        0.05 * progress
      );
      const intensity = progress * (0.3 + 0.7 * pulse);
      return { matColor, emissiveColor, intensity };
    }

    // 1. Color each of the 4 individual cylinders and their heads based on actual CHT
    CYLINDER_COMPONENTS_MAP.forEach((partNames, idx) => {
      const temp = Number(chtList[idx]) || 85;
      const chtColor = computeChtColor(temp);

      partNames.forEach((partName) => {
        const mesh = meshMap[partName];
        if (!mesh || !mesh.material) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

        if (highlightedProgressMap[partName] !== undefined) {
          // Eventual progressive colour increase (amber -> red)
          const { matColor, emissiveColor, intensity } = computeProgressiveStyle(highlightedProgressMap[partName]);
          mats.forEach((mat) => {
            mat.color.copy(matColor);
            if (mat.emissive) {
              mat.emissive.copy(emissiveColor);
              mat.emissiveIntensity = intensity;
            }
          });
        } else {
          // Individual cylinder temperature coloring
          mats.forEach((mat) => {
            mat.color.copy(chtColor);
            if (mat.emissive) {
              if (isRunning && temp >= 135) {
                mat.emissive.setRGB(0.7 * pulse, 0.05, 0.05);
                mat.emissiveIntensity = 0.6 * pulse;
              } else {
                mat.emissive.setRGB(0, 0, 0);
                mat.emissiveIntensity = 0;
              }
            }
          });
        }
      });
    });

    // 2. Color all non-cylinder tracked subsystem meshes
    const allCylParts = new Set(CYLINDER_COMPONENTS_MAP.flat());
    const allTrackedSubsystems = new Set();
    Object.values(FAULT_SUBSYSTEM_MAP).forEach((parts) => {
      parts.forEach((p) => allTrackedSubsystems.add(p));
    });

    allTrackedSubsystems.forEach((partName) => {
      if (allCylParts.has(partName)) return;
      const mesh = meshMap[partName];
      if (!mesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

      if (isRunning && highlightedProgressMap[partName] !== undefined) {
        const { matColor, emissiveColor, intensity } = computeProgressiveStyle(highlightedProgressMap[partName]);
        mats.forEach((mat) => {
          mat.color.copy(matColor);
          if (mat.emissive) {
            mat.emissive.copy(emissiveColor);
            mat.emissiveIntensity = intensity;
          }
        });
      } else {
        mats.forEach((mat) => {
          if (mat.emissive) {
            mat.emissive.setRGB(0, 0, 0);
            mat.emissiveIntensity = 0;
          }
          mat.color.setRGB(0.72, 0.76, 0.82);
        });
      }
    });
  });

  return <primitive object={scene} />;
}

// Preload glb model
useGLTF.preload('/rotax914.glb');
