import React from 'react';
import { ControlBar } from './ControlBar';
import { FaultBanner } from './FaultBanner';
import { EngineViewport } from './EngineViewport';
import { StatusReadout } from './StatusReadout';

export function ScreenEngine3DSimulation({ telemetry, wsTelemetry, isConnected, sendCommand }) {
  const activeTelemetry = wsTelemetry || telemetry;

  return (
    <div className="dashboard-app" style={{ maxWidth: '100%', padding: '0 8px 16px 8px' }}>
      {/* Simulation Controls from VikhyatV2 */}
      <ControlBar
        telemetry={activeTelemetry}
        isConnected={isConnected}
        sendCommand={sendCommand}
      />

      {/* 3-Layer AI/ML Fault Detection Banner */}
      <FaultBanner telemetry={activeTelemetry} />

      {/* 3D Engine Model Viewport and Parameter Readouts side-by-side */}
      <div className="main-content-grid">
        <div className="viewport-column">
          <EngineViewport telemetry={activeTelemetry} />
        </div>

        <StatusReadout telemetry={activeTelemetry} />
      </div>
    </div>
  );
}
