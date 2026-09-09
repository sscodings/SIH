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

export function EngineModel({ telemetry }) {
  // Load model from public folder
  const { scene, nodes } = useGLTF('/rotax914.glb');
  const loggedNodesRef = useRef(false);

  // 1. Log node names once on load to verify part names in the browser console
  useEffect(() => {
    if (!loggedNodesRef.current && nodes) {
      const keys = Object.keys(nodes);
      console.log('[EngineModel] Loaded GLTF nodes object keys (' + keys.length + ' parts):', keys);
      loggedNodesRef.current = true;
    }
  }, [nodes]);

  // 2. Identify the 4 cylinder meshes
  const cylinderMeshes = useMemo(() => {
    if (!nodes) return [null, null, null, null];

    const cylList = [null, null, null, null];
    const candidateAliases = [
      ['Cylindr 1', 'cylinder_1', 'Cylindr_1', 'cyl1'],
      ['Cylindr 2', 'cylinder_2', 'Cylindr_2', 'cyl2'],
      ['Cylindr 1.001', 'cylinder_3', 'Cylindr_1_001', 'Cylindr 3', 'cyl3'],
      ['Cylindr 2.001', 'cylinder_4', 'Cylindr_2_001', 'Cylindr 4', 'cyl4'],
    ];

    candidateAliases.forEach((aliases, i) => {
      for (const name of aliases) {
        if (nodes[name]) {
          cylList[i] = nodes[name];
          break;
        }
      }
    });

    // Fallback search across all node names containing 'cyl'
    if (cylList.some((c) => !c)) {
      const allCyls = Object.keys(nodes).filter((k) => k.toLowerCase().includes('cyl'));
      allCyls.forEach((k, idx) => {
        if (idx < 4 && !cylList[idx]) {
          cylList[idx] = nodes[k];
        }
      });
    }

    // Clone materials so coloring one cylinder does not color all cylinders
    cylList.forEach((mesh) => {
      if (mesh && mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map((m) => m.clone());
        } else {
          mesh.material = mesh.material.clone();
        }
      }
    });

    return cylList;
  }, [nodes]);

  // 3. PBR material enhancements & shadow configuration
  useEffect(() => {
    if (!scene) return;
    scene.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;

        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((mat) => {
          if (mat) {
            // Give CAD parts an authentic aero cast-aluminum finish
            mat.metalness = 0.65;
            mat.roughness = 0.35;
            mat.needsUpdate = true;
          }
        });
      }
    });
  }, [scene]);

  // 4. Per-frame dynamic cylinder coloring
  useFrame((state) => {
    if (!telemetry) return;

    const chtList = telemetry.cht_c || [150, 150, 150, 150];
    const mlDiag = telemetry.diagnostics?.ml_diagnostics || {};
    const isAnomaly = Boolean(mlDiag.anomaly_detected || mlDiag.layer3_anomaly_detected);

    // Find cylinder with maximum delta CHT to ambient
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

    // Color each cylinder
    cylinderMeshes.forEach((mesh, idx) => {
      if (!mesh || !mesh.material) return;

      let targetColor;
      if (isAnomaly && idx === highestDeltaIdx) {
        // Force bright pulsing red regardless of raw temp
        const pulse = 0.85 + 0.15 * Math.sin(state.clock.elapsedTime * 6.0);
        targetColor = new THREE.Color(pulse, 0.05, 0.05);
      } else {
        targetColor = computeChtColor(chtList[idx] || 150);
      }

      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((mat) => {
        if (mat && mat.color) {
          mat.color.copy(targetColor);
        }
      });
    });
  });

  return <primitive object={scene} />;
}

// Preload glb model
useGLTF.preload('/rotax914.glb');
