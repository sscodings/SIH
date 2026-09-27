import React from 'react';
import { ControlBar } from './ControlBar';
import { EngineViewport } from './EngineViewport';
import { LiveDataPanel } from './LiveDataPanel';
import { EnvironmentPanel } from './EnvironmentPanel';
import { isNum } from '../utils/format';

function FlightAlert({ telemetry }) {
  if (telemetry?.craft_crashed) {
    return (
      <div className="flight-alert flight-alert-crash">
        AIRCRAFT CRASHED — TOTAL LOSS OF ENGINE POWER & GROUND IMPACT (0 m ALTITUDE, 0 RPM)
      </div>
    );
  }
  if (isNum(telemetry?.health_index) && telemetry.health_index <= 0.25) {
    return (
      <div className="flight-alert flight-alert-warning">
        CRITICAL: ENGINE SEIZURE / POWER LOSS — EMERGENCY DESCENT IN PROGRESS
      </div>
    );
  }
  return null;
}

export function ScreenEngine3DSimulation({ telemetry, wsTelemetry, isConnected, sendCommand }) {
  const activeTelemetry = wsTelemetry || telemetry;

  return (
    <div className="dashboard-app" style={{ maxWidth: '100%', padding: '0 8px 16px 8px' }}>
      <ControlBar
        telemetry={activeTelemetry}
        isConnected={isConnected}
        sendCommand={sendCommand}
      />

      <FlightAlert telemetry={activeTelemetry} />

      <div className="main-content-grid">
        <div className="viewport-column">
          <EngineViewport telemetry={activeTelemetry} />
          <EnvironmentPanel telemetry={activeTelemetry} />
        </div>

        <div className="readout-column">
          <LiveDataPanel telemetry={activeTelemetry} />
        </div>
      </div>
    </div>
  );
}
