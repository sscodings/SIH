import React, { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Color interpolation for CHT gradient
// Grey below 200°C, Orange at 240°C, Red above 260°C
function computeChtColor(temp) {
  const t = Number(temp) || 150;
  if (t <= 200) {
    return new THREE.Color(0.52, 0.55, 0.60); // Cold / nominal metal grey
  } else if (t < 240) {
    const factor = (t - 200) / 40.0;
    const grey = new THREE.Color(0.52, 0.55, 0.60);
    const orange = new THREE.Color(0.98, 0.55, 0.08); // Warning amber
    return grey.lerp(orange, factor);
  } else if (t < 260) {
    const factor = (t - 240) / 20.0;
    const orange = new THREE.Color(0.98, 0.55, 0.08);
    const red = new THREE.Color(0.95, 0.15, 0.15); // Critical red
    return orange.lerp(red, factor);
  } else {
    return new THREE.Color(0.95, 0.12, 0.12);
  }
}

// 4 Cylinders: Each cylinder has both a finned barrel ('Cylindr X') and an outer cylinder head cover ('Rotax 914.00X')
const CYLINDER_SUBSYSTEMS = [
  ['Cylindr 1', 'Rotax 914.001'],     // Cyl #1
  ['Cylindr 2', 'Rotax 914.002'],     // Cyl #2
  ['Cylindr 1.001', 'Rotax 914.003'], // Cyl #3
  ['Cylindr 2.001', 'Rotax 914.004'], // Cyl #4
];

// Map fault taxonomy to CAD component node names (SIH-main source of truth + visual head covers)
const FAULT_SUBSYSTEM_MAP = {
  lubrication_issues: ['Korpus maslo', 'Filtr', 'Bachek'],
  lubrication_issue: ['Korpus maslo', 'Filtr', 'Bachek'],
  misfire: ['Cylindr 1', 'Rotax 914.001'],
  sensor_drift: ['Cylindr 1', 'Rotax 914.001', 'Datchik'],
  injector_abnormalities: ['Vhodnoy kollektor', 'Patrubok vhodnoy', 'Cylindr 1', 'Rotax 914.001'],
  injector_abnormal: ['Vhodnoy kollektor', 'Patrubok vhodnoy', 'Cylindr 1', 'Rotax 914.001'],
  cooling_degradation: [
    'Patrubok voda 1', 'Patrubok voda 2', 'Patrubok voda 3', 'Patrubok voda 4',
    'Patrubok voda niz 1.m3d', 'Patrubok voda niz 2', 'Patrubok voda niz 3', 'Patrubok voda niz 4',
  ],
  abnormal_vibration: ['Korpus reduktora', 'Flanec 1', 'Flanec 2', 'Flanec vala 1', 'Levyi karter 1', 'Pravyi karter 1'],
  combustion_instability: [
    'Cylindr 1', 'Rotax 914.001', 'Cylindr 2', 'Rotax 914.002',
    'Cylindr 1.001', 'Rotax 914.003', 'Cylindr 2.001', 'Rotax 914.004'
  ],
  overheating_trends: [
    'Cylindr 1', 'Rotax 914.001', 'Cylindr 2', 'Rotax 914.002',
    'Cylindr 1.001', 'Rotax 914.003', 'Cylindr 2.001', 'Rotax 914.004', 'Korpus maslo'
  ],
  overheating_trend: [
    'Cylindr 1', 'Rotax 914.001', 'Cylindr 2', 'Rotax 914.002',
    'Cylindr 1.001', 'Rotax 914.003', 'Cylindr 2.001', 'Rotax 914.004', 'Korpus maslo'
  ],
};

export function EngineModel({ telemetry }) {
  // Load model from public folder
  const { scene, nodes } = useGLTF('/rotax914.glb');
  const loggedNodesRef = useRef(false);

  // 1. Log node names once on load
  useEffect(() => {
    if (!loggedNodesRef.current && nodes) {
      const keys = Object.keys(nodes);
      console.log('[EngineModel] Loaded GLTF nodes (' + keys.length + ' parts)');
      loggedNodesRef.current = true;
    }
  }, [nodes]);

  // 2. Clone materials for every mesh in the model so highlighting and styling never leaks
  const trackedMeshes = useMemo(() => {
    if (!scene) return {};
    const map = {};

    scene.traverse((child) => {
      if (child.isMesh && child.name) {
        if (Array.isArray(child.material)) {
          child.material = child.material.map((m) => m.clone());
        } else if (child.material) {
          child.material = child.material.clone();
        }
        map[child.name] = child;
      }
    });

    return map;
  }, [scene]);

  // 3. Initial PBR metallic styling
  useEffect(() => {
    if (!scene) return;
    scene.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((mat) => {
          if (mat) {
            mat.metalness = 0.65;
            mat.roughness = 0.35;
            mat.needsUpdate = true;
          }
        });
      }
    });
  }, [scene]);

  // 4. Per-frame dynamic highlighting of faulted parts + CHT heat coloring
  useFrame((state) => {
    if (!telemetry) return;

    const chtList = telemetry.cht_c || [150, 150, 150, 150];
    const mlDiag = telemetry.diagnostics?.ml_diagnostics || {};
    const classifierFault = mlDiag.layer2_predicted_fault || 'none';
    const physicsFault = mlDiag.fault_type || 'none';
    const isPhysicsDetected = Boolean(mlDiag.anomaly_detected);

    // Collect ALL active detected faults
    const activeFaultsSet = new Set();
    if (Array.isArray(telemetry.active_faults)) {
      telemetry.active_faults.forEach((f) => {
        if (f && f !== 'none') activeFaultsSet.add(f);
      });
    }
    if (isPhysicsDetected && classifierFault && classifierFault !== 'none' && classifierFault !== 'healthy') {
      activeFaultsSet.add(classifierFault);
    }
    if (isPhysicsDetected && physicsFault && physicsFault !== 'none') {
      activeFaultsSet.add(physicsFault);
    }

    // Determine which meshes should be highlighted red across ALL active faults
    const highlightedNames = new Set();

    // Specific targeted cylinder for misfire (highlights both barrel and outer cylinder head cover)
    if (activeFaultsSet.has('misfire')) {
      const targetCylIdx = Number(telemetry.injected_fault?.cylinder ?? 0);
      const parts = CYLINDER_SUBSYSTEMS[targetCylIdx] || CYLINDER_SUBSYSTEMS[0];
      parts.forEach((p) => highlightedNames.add(p));
    }

    // Map all other detected faults to their 3D CAD subsystems
    activeFaultsSet.forEach((fault) => {
      if (fault === 'misfire') return;
      const parts = FAULT_SUBSYSTEM_MAP[fault];
      if (parts) {
        parts.forEach((p) => highlightedNames.add(p));
      }
    });

    // Fallback: if an anomaly is flagged without a specific fault mapping, highlight highest delta CHT cylinder
    const hasUnmappedAnomaly = (highlightedNames.size === 0) && Boolean(
      mlDiag.layer3_anomaly_detected || (isPhysicsDetected && mlDiag.anomaly_detected) || (telemetry.active_faults_count > 0)
    );
    if (hasUnmappedAnomaly) {
      let highestDeltaIdx = 0;
      const deltaList = telemetry.diagnostics?.delta_cht_ambient || chtList;
      if (deltaList && deltaList.length > 0) {
        let maxDelta = -Infinity;
        deltaList.forEach((val, idx) => {
          if (Number(val) > maxDelta) {
            maxDelta = Number(val);
            highestDeltaIdx = idx;
          }
        });
      }
      const parts = CYLINDER_SUBSYSTEMS[highestDeltaIdx] || CYLINDER_SUBSYSTEMS[0];
      parts.forEach((p) => highlightedNames.add(p));
    }

    // Highlighting visual parameters: Glowing neon red with dynamic pulse
    const pulse = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 8.0);
    const highlightColor = new THREE.Color(1.0, 0.05, 0.08); // Vivid saturated red
    const highlightEmissive = new THREE.Color(1.0, 0.06, 0.08); // Glowing neon red

    // Subtle vibration shudder if engine is running
    if (scene && telemetry.is_running) {
      const vibRms = Number(telemetry.vibration_rms_g) || 0.8;
      const vibAmp = Math.max(0, vibRms - 0.75) * 0.0015;
      const tSec = state.clock.elapsedTime * 48.0;
      scene.position.x = Math.sin(tSec) * vibAmp;
      scene.position.y = Math.cos(tSec * 1.3) * vibAmp * 0.5;
      scene.position.z = Math.sin(tSec * 0.8) * vibAmp * 0.4;
    }

    // Update all tracked subsystem meshes in the scene
    Object.entries(trackedMeshes).forEach(([name, mesh]) => {
      if (!mesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const isHighlighted = highlightedNames.has(name);

      if (isHighlighted) {
        // Highlight active component with glowing neon red
        mats.forEach((mat) => {
          mat.color.copy(highlightColor);
          if (mat.emissive) {
            mat.emissive.copy(highlightEmissive);
            mat.emissiveIntensity = 1.2 + 0.8 * pulse;
          }
          mat.roughness = 0.2;
          mat.needsUpdate = true;
        });
      } else {
        // Reset emissive
        mats.forEach((mat) => {
          if (mat.emissive) {
            mat.emissive.setRGB(0, 0, 0);
            mat.emissiveIntensity = 0;
          }
        });

        // If it's a cylinder, apply natural CHT thermal heat color
        const cylIdx = [0, 1, 2, 3].findIndex((i) => CYLINDER_SUBSYSTEMS[i].includes(name));
        if (cylIdx >= 0) {
          const chtColor = computeChtColor(chtList[cylIdx] || 150);
          mats.forEach((mat) => mat.color.copy(chtColor));
        } else {
          // Other parts: restore baseline metallic grey
          mats.forEach((mat) => mat.color.setRGB(0.72, 0.76, 0.82));
        }
      }
    });
  });

  return <primitive object={scene} />;
}

// Preload glb model
useGLTF.preload('/rotax914.glb');
