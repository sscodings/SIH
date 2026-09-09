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

// Map fault taxonomy to CAD component node names
const FAULT_SUBSYSTEM_MAP = {
  lubrication_issues: ['Korpus maslo', 'Filtr', 'Bachek'],
  lubrication_issue: ['Korpus maslo', 'Filtr', 'Bachek'],
  misfire: ['Cylindr 1'],
  sensor_drift: ['Cylindr 1', 'Datchik'],
  injector_abnormalities: ['Vhodnoy kollektor', 'Patrubok vhodnoy', 'Cylindr 1', 'Cylindr 1.001'],
  injector_abnormal: ['Vhodnoy kollektor', 'Patrubok vhodnoy', 'Cylindr 1', 'Cylindr 1.001'],
  cooling_degradation: [
    'Patrubok voda 1', 'Patrubok voda 2', 'Patrubok voda 3', 'Patrubok voda 4',
    'Patrubok voda niz 1.m3d', 'Patrubok voda niz 2', 'Patrubok voda niz 3', 'Patrubok voda niz 4',
  ],
  abnormal_vibration: ['Korpus reduktora', 'Flanec 1', 'Flanec 2', 'Flanec vala 1', 'Levyi karter 1', 'Pravyi karter 1'],
  combustion_instability: ['Cylindr 1', 'Cylindr 2', 'Cylindr 1.001', 'Cylindr 2.001'],
  overheating_trends: ['Cylindr 1', 'Cylindr 2', 'Cylindr 1.001', 'Cylindr 2.001', 'Korpus maslo'],
  overheating_trend: ['Cylindr 1', 'Cylindr 2', 'Cylindr 1.001', 'Cylindr 2.001', 'Korpus maslo'],
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

  // 2. Identify the 4 cylinder meshes
  const cylinderMeshes = useMemo(() => {
    if (!nodes) return [null, null, null, null];
    const candidateAliases = [
      ['Cylindr 1', 'cylinder_1', 'Cylindr_1', 'cyl1'],
      ['Cylindr 2', 'cylinder_2', 'Cylindr_2', 'cyl2'],
      ['Cylindr 1.001', 'cylinder_3', 'Cylindr_1_001', 'Cylindr 3', 'cyl3'],
      ['Cylindr 2.001', 'cylinder_4', 'Cylindr_2_001', 'Cylindr 4', 'cyl4'],
    ];

    const cylList = candidateAliases.map((aliases) => {
      for (const name of aliases) {
        if (nodes[name]) return nodes[name];
      }
      return null;
    });

    return cylList;
  }, [nodes]);

  // 3. Clone materials for all candidate subsystem meshes so styling does not leak
  const trackedMeshes = useMemo(() => {
    if (!nodes) return {};
    const map = {};

    // Collect all candidate node names from map plus cylinders
    const allNames = new Set([
      'Cylindr 1', 'Cylindr 2', 'Cylindr 1.001', 'Cylindr 2.001',
      'Korpus maslo', 'Filtr', 'Bachek', 'Datchik',
      'Vhodnoy kollektor', 'Patrubok vhodnoy',
      'Patrubok voda 1', 'Patrubok voda 2', 'Patrubok voda 3', 'Patrubok voda 4',
      'Patrubok voda niz 1.m3d', 'Patrubok voda niz 2', 'Patrubok voda niz 3', 'Patrubok voda niz 4',
      'Korpus reduktora', 'Flanec 1', 'Flanec 2', 'Flanec vala 1', 'Levyi karter 1', 'Pravyi karter 1',
      'Turbina 1', 'Summator vyhlopa', 'Truba vyhlopnaya',
    ]);

    allNames.forEach((name) => {
      const mesh = nodes[name];
      if (mesh && mesh.isMesh) {
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map((m) => m.clone());
        } else if (mesh.material) {
          mesh.material = mesh.material.clone();
        }
        map[name] = mesh;
      }
    });

    return map;
  }, [nodes]);

  // 4. Initial PBR styling
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

  // 5. Per-frame dynamic highlighting of faulted parts + CHT heat coloring
  useFrame((state) => {
    if (!telemetry) return;

    const chtList = telemetry.cht_c || [150, 150, 150, 150];
    const mlDiag = telemetry.diagnostics?.ml_diagnostics || {};
    const classifierFault = mlDiag.layer2_predicted_fault || 'none';
    const physicsFault = mlDiag.fault_type || 'none';

    // Collect ALL active faults (supports single or multiple simultaneous injected faults)
    const activeFaultsSet = new Set();
    if (Array.isArray(telemetry.active_faults)) {
      telemetry.active_faults.forEach((f) => {
        if (f && f !== 'none') activeFaultsSet.add(f);
      });
    }
    if (classifierFault && classifierFault !== 'none') {
      activeFaultsSet.add(classifierFault);
    }
    if (physicsFault && physicsFault !== 'none') {
      activeFaultsSet.add(physicsFault);
    }

    // Determine which meshes should be highlighted red across ALL active faults
    const highlightedNames = new Set();
    activeFaultsSet.forEach((fault) => {
      const parts = FAULT_SUBSYSTEM_MAP[fault];
      if (parts) {
        parts.forEach((p) => highlightedNames.add(p));
      }
    });

    // Fallback: if an anomaly is flagged without a specific fault mapping, highlight the highest delta CHT cylinder
    const hasUnmappedAnomaly = (highlightedNames.size === 0) && Boolean(
      mlDiag.layer3_anomaly_detected || mlDiag.anomaly_detected || (telemetry.active_faults_count > 0)
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
      const cylNames = ['Cylindr 1', 'Cylindr 2', 'Cylindr 1.001', 'Cylindr 2.001'];
      highlightedNames.add(cylNames[highestDeltaIdx]);
    }

    const pulse = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 8.0);
    const highlightColor = new THREE.Color(0.98, 0.10, 0.15); // Neon warning red
    const highlightEmissive = new THREE.Color(0.85 * pulse, 0.02, 0.05);

    // Update all tracked subsystem meshes
    Object.entries(trackedMeshes).forEach(([name, mesh]) => {
      if (!mesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

      if (highlightedNames.has(name)) {
        // Highlighting active fault component
        mats.forEach((mat) => {
          mat.color.copy(highlightColor);
          if (mat.emissive) {
            mat.emissive.copy(highlightEmissive);
            mat.emissiveIntensity = 0.7 + 0.5 * pulse;
          }
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
        const cylIdx = ['Cylindr 1', 'Cylindr 2', 'Cylindr 1.001', 'Cylindr 2.001'].indexOf(name);
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
