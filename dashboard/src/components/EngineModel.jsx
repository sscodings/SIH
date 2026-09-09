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

function cleanKey(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Candidate alias dictionary covering original Blender exports, sanitizations, and common aliases
const SUBSYSTEM_PART_ALIASES = {
  // Cylinders
  cyl1: ['Cylindr 1', 'Cylindr_1', 'cylinder_1', 'cyl1', 'cylinder 1'],
  cyl2: ['Cylindr 2', 'Cylindr_2', 'cylinder_2', 'cyl2', 'cylinder 2'],
  cyl3: ['Cylindr 1.001', 'Cylindr_1001', 'Cylindr_1_001', 'cylinder_3', 'cyl3', 'cylinder 3'],
  cyl4: ['Cylindr 2.001', 'Cylindr_2001', 'Cylindr_2_001', 'cylinder_4', 'cyl4', 'cylinder 4'],

  // Lubrication system
  oil_pan: ['Korpus maslo', 'Korpus_maslo', 'oil_pan', 'oil_case', 'oil_sump'],
  oil_filter: ['Filtr', 'filtr', 'oil_filter', 'filter'],
  oil_tank: ['Bachek', 'bachek', 'oil_reservoir', 'oil_tank', 'tank'],

  // Sensor
  sensor: ['Datchik', 'datchik', 'sensor', 'cht_sensor'],

  // Fuel metering / intake system
  intake_manifold: ['Vhodnoy kollektor', 'Vhodnoy_kollektor', 'intake_manifold', 'manifold'],
  intake_pipe: ['Patrubok vhodnoy', 'Patrubok_vhodnoy', 'intake_pipe', 'intake_runner'],

  // Cooling system (radiator hoses, water lines, coolant manifolds)
  water_pipe_1: ['Patrubok voda 1', 'Patrubok_voda_1', 'water_pipe_1'],
  water_pipe_2: ['Patrubok voda 2', 'Patrubok_voda_2', 'water_pipe_2'],
  water_pipe_3: ['Patrubok voda 3', 'Patrubok_voda_3', 'water_pipe_3'],
  water_pipe_4: ['Patrubok voda 4', 'Patrubok_voda_4', 'water_pipe_4'],
  water_low_1: ['Patrubok voda niz 1.m3d', 'Patrubok_voda_niz_1m3d', 'Patrubok_voda_niz_1'],
  water_low_2: ['Patrubok voda niz 2', 'Patrubok_voda_niz_2'],
  water_low_3: ['Patrubok voda niz 3', 'Patrubok_voda_niz_3'],
  water_low_4: ['Patrubok voda niz 4', 'Patrubok_voda_niz_4'],
  coolant_manifold: [
    'COMPOUND', 'COMPOUND.001', 'COMPOUND001', 'COMPOUND.002', 'COMPOUND002',
    'COMPOUND.003', 'COMPOUND003', 'COMPOUND.004', 'COMPOUND004'
  ],
  coolant_hose_84: ['914-8-4', '914_8_4', '91484'],
  coolant_hose_85: ['914-8-5', '914_8_5', '91485'],

  // Vibration / Mechanical Gearbox / Bearings / Mounts
  gearbox: ['Korpus reduktora', 'Korpus_reduktora', 'reduction_gearbox', 'gearbox'],
  flange_1: ['Flanec 1', 'Flanec_1', 'Flanec 1.001', 'Flanec_1001', 'flange_1'],
  flange_2: ['Flanec 2', 'Flanec_2', 'flange_2'],
  flange_shaft: ['Flanec vala 1', 'Flanec_vala_1', 'shaft_flange'],
  crankcase_l: ['Levyi karter 1', 'Levyi_karter_1', 'crankcase_left'],
  crankcase_r: ['Pravyi karter 1', 'Pravyi_karter_1', 'crankcase_right'],
};

// Logical subsystem mapping for each of the 8 fault modes
const FAULT_LOGICAL_MAP = {
  misfire: ['cyl1'],
  injector_abnormalities: ['intake_manifold', 'intake_pipe', 'cyl1', 'cyl3'],
  injector_abnormal: ['intake_manifold', 'intake_pipe', 'cyl1', 'cyl3'],
  cooling_degradation: [
    'water_pipe_1', 'water_pipe_2', 'water_pipe_3', 'water_pipe_4',
    'water_low_1', 'water_low_2', 'water_low_3', 'water_low_4',
    'coolant_manifold', 'coolant_hose_84', 'coolant_hose_85'
  ],
  lubrication_issues: ['oil_pan', 'oil_filter', 'oil_tank'],
  lubrication_issue: ['oil_pan', 'oil_filter', 'oil_tank'],
  sensor_drift: ['sensor', 'cyl1'],
  combustion_instability: ['cyl1', 'cyl2', 'cyl3', 'cyl4'],
  overheating_trends: ['cyl1', 'cyl2', 'cyl3', 'cyl4', 'oil_pan'],
  overheating_trend: ['cyl1', 'cyl2', 'cyl3', 'cyl4', 'oil_pan'],
  abnormal_vibration: ['gearbox', 'flange_1', 'flange_2', 'flange_shaft', 'crankcase_l', 'crankcase_r'],
};

export function EngineModel({ telemetry }) {
  // Load model from public folder
  const { scene, nodes } = useGLTF('/rotax914.glb');
  const loggedNodesRef = useRef(false);

  // 1. Log node names once on load for verification
  useEffect(() => {
    if (!loggedNodesRef.current && nodes) {
      const keys = Object.keys(nodes);
      console.log('[EngineModel] Loaded GLTF nodes (' + keys.length + ' parts):', keys);
      loggedNodesRef.current = true;
    }
  }, [nodes]);

  // 2. Resolve all logical parts using multi-alias fallback pattern
  const { logicalMeshes, allTrackedMeshes, baseColorMap } = useMemo(() => {
    if (!nodes) return { logicalMeshes: {}, allTrackedMeshes: [], baseColorMap: {} };

    // Clean lookup map
    const cleanLookup = {};
    Object.entries(nodes).forEach(([rawName, obj]) => {
      if (obj && obj.isMesh) {
        cleanLookup[cleanKey(rawName)] = obj;
      }
    });

    const resolved = {};
    const baseColors = {};
    const allMeshesSet = new Set();

    Object.entries(SUBSYSTEM_PART_ALIASES).forEach(([partKey, aliases]) => {
      const meshesForPart = [];
      aliases.forEach((alias) => {
        const directMesh = nodes[alias];
        if (directMesh && directMesh.isMesh && !meshesForPart.includes(directMesh)) {
          meshesForPart.push(directMesh);
        }
        const cleanedMesh = cleanLookup[cleanKey(alias)];
        if (cleanedMesh && cleanedMesh.isMesh && !meshesForPart.includes(cleanedMesh)) {
          meshesForPart.push(cleanedMesh);
        }
      });

      // Clone materials and register base colors
      meshesForPart.forEach((mesh) => {
        allMeshesSet.add(mesh);
        const mKey = cleanKey(mesh.name || partKey);
        if (!baseColors[mKey]) {
          if (Array.isArray(mesh.material)) {
            mesh.material = mesh.material.map((m) => m.clone());
            baseColors[mKey] = mesh.material[0]?.color?.clone() || new THREE.Color(0.72, 0.76, 0.82);
          } else if (mesh.material) {
            mesh.material = mesh.material.clone();
            baseColors[mKey] = mesh.material.color?.clone() || new THREE.Color(0.72, 0.76, 0.82);
          }
        }
      });

      resolved[partKey] = meshesForPart;
    });

    return {
      logicalMeshes: resolved,
      allTrackedMeshes: Array.from(allMeshesSet),
      baseColorMap: baseColors
    };
  }, [nodes]);

  // 3. Initial PBR styling
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

    // Dynamic engine mechanical vibration response (proportional to live vibration_rms_g & instability)
    const mlPipeline = telemetry.ml_pipeline || {};
    const isDetected = Boolean(mlPipeline.is_detected);
    const affectedComponent = mlPipeline.affected_component || 'none';
    const detectedFault = mlPipeline.detected_fault || 'none';
    const physicsFault = mlDiag.fault_type || 'none';
    const isPhysicsAlert = Boolean(mlDiag.anomaly_detected && physicsFault !== 'none');

    if (scene) {
      const vibRms = Number(telemetry.vibration_rms_g) || 0.8;
      const instability = (mlPipeline.propagation_pct || 0) / 100.0;
      const vibAmp = Math.max(0, vibRms - 0.75) * 0.0018 + instability * 0.0012;
      const tSec = state.clock.elapsedTime * 48.0;
      scene.position.x = Math.sin(tSec) * vibAmp;
      scene.position.y = Math.cos(tSec * 1.3) * vibAmp * 0.6;
      scene.position.z = Math.sin(tSec * 0.8) * vibAmp * 0.5;
    }

    // ONLY highlight in glowing red if the ML detection threshold has been crossed (or active physics rule triggered)
    const activeFaultsSet = new Set();
    if (isDetected && detectedFault !== 'none') {
      activeFaultsSet.add(String(detectedFault).toLowerCase());
    } else if (Array.isArray(telemetry.active_faults) && telemetry.active_faults.length > 0 && isDetected) {
      telemetry.active_faults.forEach((f) => {
        if (f && f !== 'none') activeFaultsSet.add(String(f).toLowerCase());
      });
    }

    // Determine which logical parts should be red
    const highlightedParts = new Set();
    if (isDetected && affectedComponent !== 'none') {
      highlightedParts.add(affectedComponent);
    }
    if (activeFaultsSet.size > 0) {
      activeFaultsSet.forEach((fault) => {
        const parts = FAULT_LOGICAL_MAP[fault];
        if (parts) {
          parts.forEach((p) => highlightedParts.add(p));
        }
      });
    }

    // Determine all meshes that should be red
    const meshesToHighlight = new Set();
    highlightedParts.forEach((partKey) => {
      const meshes = logicalMeshes[partKey] || [];
      meshes.forEach((m) => meshesToHighlight.add(m));
    });

    // Fallback: only if a fault is actually detected by ML or active physics alert
    if (meshesToHighlight.size === 0 && (isDetected || isPhysicsAlert)) {
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
      const cylKey = ['cyl1', 'cyl2', 'cyl3', 'cyl4'][highestDeltaIdx] || 'cyl1';
      const fallbackMeshes = logicalMeshes[cylKey] || [];
      fallbackMeshes.forEach((m) => meshesToHighlight.add(m));
    }

    const pulse = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 8.0);
    const highlightColor = new THREE.Color(1.0, 0.08, 0.12); // Vivid glowing red
    const highlightEmissive = new THREE.Color(0.95 * pulse, 0.02, 0.04);

    // Map cylinder meshes for CHT coloring
    const cylPartKeys = ['cyl1', 'cyl2', 'cyl3', 'cyl4'];
    const cylMeshToIdx = new Map();
    cylPartKeys.forEach((pKey, cIdx) => {
      const meshes = logicalMeshes[pKey] || [];
      meshes.forEach((m) => cylMeshToIdx.set(m, cIdx));
    });

    // Update all tracked meshes
    allTrackedMeshes.forEach((mesh) => {
      if (!mesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const isRed = meshesToHighlight.has(mesh);

      if (isRed) {
        // Highlighting active fault component with glowing neon red
        mats.forEach((mat) => {
          mat.color.copy(highlightColor);
          if (mat.emissive) {
            mat.emissive.copy(highlightEmissive);
            mat.emissiveIntensity = 0.85 + 0.65 * pulse;
          }
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
        if (cylMeshToIdx.has(mesh)) {
          const cIdx = cylMeshToIdx.get(mesh);
          const chtColor = computeChtColor(chtList[cIdx] || 150);
          mats.forEach((mat) => mat.color.copy(chtColor));
        } else {
          const mKey = cleanKey(mesh.name);
          if (baseColorMap[mKey]) {
            mats.forEach((mat) => mat.color.copy(baseColorMap[mKey]));
          } else {
            mats.forEach((mat) => mat.color.setRGB(0.72, 0.76, 0.82));
          }
        }
      }
    });
  });

  return <primitive object={scene} />;
}

// Preload glb model
useGLTF.preload('/rotax914.glb');
