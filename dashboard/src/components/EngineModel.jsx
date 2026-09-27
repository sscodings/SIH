import React, { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const HEAT_COLD = new THREE.Color(0.52, 0.55, 0.60);  // cold / warm-up metal grey
const HEAT_WARM = new THREE.Color(0.68, 0.66, 0.58);  // hot running metal

// Cylinder metal tint from CHT (75°C cold -> 135°C Rotax redline). Deliberately never amber or red:
// those colours are reserved for faults the diagnosis has actually detected.
function computeChtColor(temp) {
  const t = Number(temp);
  const factor = Number.isFinite(t) ? Math.min(1, Math.max(0, (t - 75) / 60)) : 0;
  return HEAT_COLD.clone().lerp(HEAT_WARM, factor);
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

const ALL_CYLINDERS = [0, 1, 2, 3];

/** Cylinders to mark for a detected (not injected) misfire. The recorded misfire moves between
 *  cylinders row to row, so replay marks every cylinder blamed during the current misfire issue
 *  instead of hopping to each new row's cylinder. */
function detectedMisfireCylinders(telemetry, mlDiag) {
  const issue = telemetry.flight_summary?.issues?.find((i) => i.fault_type === 'misfire' && i.active);
  if (issue?.cylinders?.length) return issue.cylinders.map((c) => c - 1);
  const cyl = mlDiag.diagnosed_cylinder;
  return typeof cyl === 'number' && cyl >= 0 && cyl < 4 ? [cyl] : ALL_CYLINDERS;
}

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
  useFrame(() => {
    if (!telemetry || !scene) return;
    const meshMap = meshMapRef.current;
    if (!meshMap || Object.keys(meshMap).length === 0) return;

    const isRunning = telemetry.is_running !== false && (telemetry.rpm > 300 || telemetry.t > 1.0);
    const chtList = isRunning ? (telemetry.cht_c || [85, 85, 85, 85]) : [20, 20, 20, 20];
    const mlDiag = telemetry.diagnostics?.ml_diagnostics || {};
    const activeFaults = telemetry.active_faults || [];

    // Track active developing progress (0.05 to 1.0) for every faulted component
    const highlightedProgressMap = {};

    // 1. Injected faults are highlighted only once the twin has actually detected them
    if (isRunning && activeFaults.length > 0 && mlDiag.anomaly_detected) {
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
      const partList = [];
      if (kind === 'misfire') {
        detectedMisfireCylinders(telemetry, mlDiag).forEach((c) => CYLINDER_COMPONENTS_MAP[c]?.forEach((p) => partList.push(p)));
      } else if (FAULT_SUBSYSTEM_MAP[kind]) {
        FAULT_SUBSYSTEM_MAP[kind].forEach((p) => partList.push(p));
      }
      partList.forEach((pName) => {
        highlightedProgressMap[pName] = 1.0;
      });
    }

    const baseColor = new THREE.Color(0.72, 0.76, 0.82);   // Brushed aluminum metallic
    const amberColor = new THREE.Color(0.98, 0.62, 0.10);  // Caution warming amber
    const redColor = new THREE.Color(0.95, 0.12, 0.15);    // Warning red

    // Steady progressive colour & glow from the fault's development (0.05 to 1.0): amber -> red, no blinking.
    function computeProgressiveStyle(progress) {
      let matColor;
      if (progress < 0.5) {
        const t = progress / 0.5;
        matColor = baseColor.clone().lerp(amberColor, t);
      } else {
        const t = (progress - 0.5) / 0.5;
        matColor = amberColor.clone().lerp(redColor, t);
      }
      const emissiveColor = new THREE.Color(0.85 * progress, 0.03 * progress, 0.05 * progress);
      const intensity = 0.65 * progress;
      return { matColor, emissiveColor, intensity };
    }

    // 1. Color each of the 4 individual cylinders and their heads based on actual CHT
    CYLINDER_COMPONENTS_MAP.forEach((partNames, idx) => {
      const chtColor = computeChtColor(chtList[idx]);

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
          // Individual cylinder temperature tint (no fault on this cylinder)
          mats.forEach((mat) => {
            mat.color.copy(chtColor);
            if (mat.emissive) {
              mat.emissive.setRGB(0, 0, 0);
              mat.emissiveIntensity = 0;
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
