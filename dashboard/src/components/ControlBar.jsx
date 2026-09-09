import React, { useState } from 'react';

export function ControlBar({ telemetry, isConnected, sendCommand }) {
  const [selectedFault, setSelectedFault] = useState('misfire');
  const isRunning = telemetry?.is_running ?? true;
  const activeFaultsCount = telemetry?.active_faults_count ?? 0;

  const handleStart = () => {
    sendCommand({ command: 'resume' });
  };

  const handlePause = () => {
    sendCommand({ command: 'pause' });
  };

  const handleReset = () => {
    sendCommand({ command: 'reset' });
  };

  const handleInjectFault = () => {
    sendCommand({
      command: 'inject_fault',
      kind: selectedFault,
      severity: 0.85,
      cylinder: 0,
      ramp_s: 1.5,
      start_in_s: 0.0,
    });
  };

  const handleClearFaults = () => {
    sendCommand({ command: 'clear_faults' });
  };

  return (
    <div className="control-bar">
      {/* Primary Simulation Controls */}
      <div className="control-group-left">
        <button
          type="button"
          onClick={handleStart}
          disabled={!isConnected || isRunning}
          className="control-btn btn-start"
        >
          Start
        </button>

        <button
          type="button"
          onClick={handlePause}
          disabled={!isConnected || !isRunning}
          className="control-btn btn-pause"
        >
          Pause
        </button>

        <button
          type="button"
          onClick={handleReset}
          disabled={!isConnected}
          className="control-btn btn-reset"
        >
          Reset
        </button>

        {/* Running / Paused State Display */}
        <div className="status-indicator-box">
          <span
            className={`status-dot ${
              !isConnected ? 'disconnected' : isRunning ? 'running' : 'paused'
            }`}
          />
          <span style={{ fontWeight: 600, color: '#E2E8F0' }}>
            {!isConnected ? 'DISCONNECTED' : isRunning ? 'RUNNING' : 'PAUSED'}
          </span>
          {telemetry?.t !== undefined && (
            <span style={{ color: 'var(--text-dim)' }}>
              (T: {telemetry.t.toFixed(1)}s)
            </span>
          )}
        </div>
      </div>

      {/* Demo Fault Injection Tools */}
      <div className="control-group-right">
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
          Inject Fault:
        </span>
        <select
          value={selectedFault}
          onChange={(e) => setSelectedFault(e.target.value)}
          className="fault-select"
        >
          <option value="misfire">1. Misfire (Cylinder 1)</option>
          <option value="injector_abnormalities">2. Injector Mismatch (Bank 1)</option>
          <option value="cooling_degradation">3. Cooling Heat Loss</option>
          <option value="lubrication_issues">4. Lubrication Deficit (Oil Leak)</option>
          <option value="sensor_drift">5. Sensor Drift (CHT Cyl 1)</option>
          <option value="combustion_instability">6. Combustion Instability</option>
          <option value="overheating_trends">7. Overheating Trend</option>
          <option value="abnormal_vibration">8. 1x Shaft Unbalance Vibration</option>
        </select>

        <button
          type="button"
          onClick={handleInjectFault}
          disabled={!isConnected}
          className="btn-inject"
        >
          Inject
        </button>

        <button
          type="button"
          onClick={handleClearFaults}
          disabled={!isConnected || activeFaultsCount === 0}
          className="btn-clear"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
