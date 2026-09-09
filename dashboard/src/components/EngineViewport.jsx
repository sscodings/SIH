import React, { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import { EngineModel } from './EngineModel';

function LoadingIndicator() {
  return (
    <mesh position={[0, 0, 0]}>
      <boxGeometry args={[0.3, 0.3, 0.3]} />
      <meshStandardMaterial color="#00E5FF" wireframe />
    </mesh>
  );
}

export function EngineViewport({ telemetry }) {
  return (
    <div className="engine-viewport-container">
      {/* HUD Overlay Info Badge */}
      <div className="viewport-hud-badge">
        <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--accent-cyan)' }} />
        <span>Rotax 914F Digital Twin 3D Viewport</span>
      </div>

      {/* Orbit Controls Guide */}
      <div className="viewport-instructions">
        Left-click: Orbit | Right-click: Pan | Scroll: Zoom
      </div>

      <Canvas
        shadows
        camera={{ position: [0.95, 0.65, 1.05], fov: 42, near: 0.05, far: 50 }}
        style={{ width: '100%', height: '100%' }}
      >
        {/* Warehouse Environment for metallic aero reflections */}
        <Environment preset="warehouse" />

        {/* Tactical Key, Fill, and Rim Lights */}
        <ambientLight intensity={0.45} />
        <directionalLight
          position={[3, 5, 3]}
          intensity={1.2}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
          shadow-bias={-0.0001}
        />
        <directionalLight position={[-3, 2, -2]} intensity={0.35} color="#94A3B8" />

        {/* Anchored static group at [0, 0, 0] with zero drift */}
        <Suspense fallback={<LoadingIndicator />}>
          <group position={[0, 0, 0]}>
            <EngineModel telemetry={telemetry} />
          </group>
        </Suspense>

        {/* Contact Shadow Plane directly below the engine base */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.36, 0]} receiveShadow>
          <planeGeometry args={[6, 6]} />
          <shadowMaterial opacity={0.3} />
        </mesh>
        <gridHelper args={[4, 16, '#00E5FF', '#1E2D4A']} position={[0, -0.359, 0]} />

        {/* Fixed-target OrbitControls anchored to the engine center */}
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.06}
          minDistance={0.3}
          maxDistance={5}
          target={[0, 0, 0]}
        />
      </Canvas>
    </div>
  );
}
