import React, { useState } from 'react';
import { EngineViewport } from './EngineViewport';

export function ScreenEngine3DSimulation({ telemetry, wsTelemetry, isConnected, sendCommand, onBack }) {
  const [selectedFault, setSelectedFault] = useState('misfire');
  const [throttleVal, setThrottleVal] = useState(65);
  const [manualOverride, setManualOverride] = useState(false);

  // Active state flags
  const isRunning = wsTelemetry?.is_running ?? true;
  const simTime = wsTelemetry?.t !== undefined ? wsTelemetry.t.toFixed(1) : telemetry.utcTime;

  // ML Diagnostics from real-time stream or calibrated model
  const mlDiag = wsTelemetry?.diagnostics?.ml_diagnostics || {};
  const l1Detected = Boolean(mlDiag.anomaly_detected);
  const l1Fault = mlDiag.fault_type || 'none';
  const l1Msg = mlDiag.message || 'Nominal physics thermodynamic envelope';

  const l2Fault = mlDiag.layer2_predicted_fault || 'none';
  const l2Conf = mlDiag.layer2_confidence !== undefined ? (mlDiag.layer2_confidence * 100).toFixed(1) : '94.2';
  const l2Active = l2Fault !== 'none' && l2Fault !== 'healthy';

  const l3Detected = Boolean(mlDiag.layer3_anomaly_detected);
  const l3Error = mlDiag.layer3_reconstruction_error !== undefined ? Number(mlDiag.layer3_reconstruction_error).toFixed(4) : '0.0142';

  const healthIndexVal = mlDiag.health_index !== undefined ? Number(mlDiag.health_index) : 0.985;
  const healthPercent = Math.max(0, Math.min(100, healthIndexVal * 100));

  // 4-Cylinder temperatures
  const cht = wsTelemetry?.cht_c || [telemetry.cht, telemetry.cht - 1.2, telemetry.cht - 0.8, telemetry.cht + 1.4];
  const egt = wsTelemetry?.egt_c || [telemetry.egt, telemetry.egt - 3.5, telemetry.egt + 2.1, telemetry.egt - 1.0];
  const deltaCht = wsTelemetry?.diagnostics?.delta_cht_ambient || [37.2, 36.8, 37.5, 38.1];

  const handleStart = () => {
    if (sendCommand) sendCommand({ command: 'resume' });
  };

  const handlePause = () => {
    if (sendCommand) sendCommand({ command: 'pause' });
  };

  const handleReset = () => {
    if (sendCommand) sendCommand({ command: 'reset' });
  };

  const handleThrottleChange = (e) => {
    const val = Number(e.target.value);
    setThrottleVal(val);
    if (sendCommand) {
      sendCommand({
        command: 'set_throttle',
        value: val / 100.0,
      });
    }
  };

  const handleInjectFault = () => {
    if (sendCommand) {
      sendCommand({
        command: 'inject_fault',
        kind: selectedFault,
        severity: 0.85,
        cylinder: 0,
        ramp_s: 1.5,
        start_in_s: 0.0,
      });
    }
  };

  const handleClearFaults = () => {
    if (sendCommand) sendCommand({ command: 'clear_faults' });
  };

  return (
    <div className="s-3d-wrapper">
      {/* Top Action Bar with Back Button & Flight Info */}
      <div className="s-3d-top-nav-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button
            type="button"
            className="hud-btn-back"
            onClick={onBack}
            title="Return to Telemetry Monitor"
          >
            ← BACK TO TELEMETRY MONITOR
          </button>

          <div className="s-3d-title-group">
            <h2 className="s-3d-main-title">ROTAX 914F 3D DIGITAL TWIN</h2>
            <span className="s-3d-main-sub">IAI HERON / MALE UAV ENGINE SIMULATOR</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span className={`uav-badge ${isConnected ? 'uav-badge-green' : 'uav-badge-orange'}`}>
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: isConnected ? 'var(--status-green)' : 'var(--status-orange)' }} />
            {isConnected ? 'LIVE WEBSOCKET STREAM' : 'LOCAL SIMULATION MODE'}
          </span>
          <span className="uav-badge uav-badge-cyan">4-CYL TURBOCHARGED</span>
        </div>
      </div>

      {/* Tactical HUD Control Bar */}
      <div className="s-3d-control-bar">
        {/* Left: Simulation State Buttons */}
        <div className="s-3d-btn-group">
          <button
            type="button"
            className="hud-ctrl-btn start"
            onClick={handleStart}
            disabled={isRunning}
          >
            ▶ RESUME
          </button>

          <button
            type="button"
            className="hud-ctrl-btn pause"
            onClick={handlePause}
            disabled={!isRunning}
          >
            ⏸ PAUSE
          </button>

          <button
            type="button"
            className="hud-ctrl-btn reset"
            onClick={handleReset}
          >
            ↺ RESET
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', marginLeft: '8px' }}>
            <span style={{ color: 'var(--text-muted)' }}>STATUS:</span>
            <span style={{ color: isRunning ? 'var(--status-green)' : 'var(--status-orange)', fontWeight: 700 }}>
              {isRunning ? 'RUNNING' : 'PAUSED'}
            </span>
            <span style={{ color: 'var(--text-dim)' }}>(T: {simTime}s)</span>
          </div>
        </div>

        {/* Center: Dynamic Throttle Slider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>
            THROTTLE:
          </span>
          <input
            type="range"
            min="0"
            max="100"
            value={throttleVal}
            onChange={handleThrottleChange}
            style={{ width: '120px', accentColor: 'var(--accent-cyan)', cursor: 'pointer' }}
          />
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--accent-cyan)', minWidth: '42px', fontFamily: 'var(--font-mono)' }}>
            {throttleVal}%
          </span>
        </div>

        {/* Right: Dynamic Fault Injection */}
        <div className="s-3d-btn-group">
          <span style={{ fontSize: '11px', color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>
            FAULT INJECTOR:
          </span>
          <select
            value={selectedFault}
            onChange={(e) => setSelectedFault(e.target.value)}
            className="hud-select"
          >
            <option value="misfire">1. Misfire (Cylinder 1 EGT Drop)</option>
            <option value="injector_abnormalities">2. Injector Mismatch (Bank A/B)</option>
            <option value="cooling_degradation">3. Cooling Heat Rejection Loss</option>
            <option value="lubrication_issues">4. Lubrication Pressure Deficit</option>
            <option value="sensor_drift">5. Sensor Inconsistency Drift</option>
            <option value="combustion_instability">6. Combustion Cyclic Jitter</option>
            <option value="overheating_trends">7. Extreme Overheating Thermal Spike</option>
            <option value="abnormal_vibration">8. 1x Bearing / Shaft Vibration Spike</option>
          </select>

          <button
            type="button"
            className="hud-ctrl-btn pause"
            onClick={handleInjectFault}
          >
            INJECT
          </button>

          <button
            type="button"
            className="hud-ctrl-btn reset"
            onClick={handleClearFaults}
          >
            CLEAR
          </button>
        </div>
      </div>

      {/* Main Grid: 3D CAD Viewport on Left, Diagnostics & Cylinders on Right */}
      <div className="s-3d-content-grid">
        {/* Left Column: 3D Engine CAD Viewport */}
        <div className="s-3d-viewport-card">
          <div className="hud-corner-tl" />
          <div className="hud-corner-tr" />
          <div className="hud-corner-bl" />
          <div className="hud-corner-br" />

          {/* HUD Overlay Badge */}
          <div className="s-3d-viewport-overlay">
            <span className="uav-dot-pulse" style={{ width: 6, height: 6 }} />
            <span>3D INTERACTIVE DIGITAL TWIN // ROTAX 914F</span>
          </div>

          {/* Controls Guide */}
          <div className="s-3d-viewport-controls-guide">
            LEFT DRAG: ORBIT | RIGHT DRAG: PAN | SCROLL: ZOOM
          </div>

          {/* Three.js Engine Viewport Canvas */}
          <EngineViewport telemetry={wsTelemetry || telemetry} />
        </div>

        {/* Right Column: AI Diagnostics & Engine Telemetry Breakdown */}
        <div className="s-3d-sidebar-col">
          {/* Dynamic Health Index / RUL Card */}
          <div className="s-3d-panel">
            <div className="s-3d-panel-header">
              <span>DYNAMIC HEALTH INDEX (RUL PROXY)</span>
              <span className="uav-badge uav-badge-green" style={{ fontSize: '9px' }}>
                {healthPercent.toFixed(1)}% RUL
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
              <span style={{ fontSize: '24px', fontWeight: 800, color: 'var(--status-green)', fontFamily: 'var(--font-mono)' }}>
                {healthIndexVal.toFixed(3)}
              </span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                / 1.000 NOMINAL
              </span>
            </div>
            <div className="s1-progress-track">
              <div
                className="s1-progress-fill"
                style={{
                  width: `${healthPercent}%`,
                  background: healthIndexVal < 0.8 ? 'var(--status-orange)' : 'linear-gradient(90deg, #2ee6a6, #22d3ee)'
                }}
              />
            </div>
          </div>

          {/* 3-Layer Hybrid AI/ML Diagnostics Strip */}
          <div className="s-3d-panel">
            <div className="s-3d-panel-header">
              <span>3-LAYER HYBRID AI/ML DIAGNOSTICS</span>
            </div>

            <div className="s-3d-ai-strip">
              {/* Layer 1 */}
              <div className={`s-3d-ai-card ${l1Detected ? 'alert' : ''}`}>
                <div className="s-3d-ai-card-top">
                  <span className="s-3d-ai-name">L1 // PHYSICS RULES</span>
                  <span className={`uav-badge ${l1Detected ? 'uav-badge-orange' : 'uav-badge-green'}`} style={{ fontSize: '9px' }}>
                    {l1Detected ? 'ALERT' : 'NOMINAL'}
                  </span>
                </div>
                <div className="s-3d-ai-desc">
                  {l1Detected ? `Fault: ${l1Fault.toUpperCase()} - ${l1Msg}` : 'Thermodynamic & oil pressure physics nominal'}
                </div>
              </div>

              {/* Layer 2 */}
              <div className={`s-3d-ai-card ${l2Active ? 'alert' : ''}`}>
                <div className="s-3d-ai-card-top">
                  <span className="s-3d-ai-name">L2 // 8-FAULT CLASSIFIER</span>
                  <span className={`uav-badge ${l2Active ? 'uav-badge-orange' : 'uav-badge-green'}`} style={{ fontSize: '9px' }}>
                    {l2Active ? 'FAULT DETECTED' : 'HEALTHY'}
                  </span>
                </div>
                <div className="s-3d-ai-desc">
                  {l2Active ? `Prediction: ${l2Fault.toUpperCase()} (${l2Conf}% confidence)` : 'Supervised neural classifier: Nominal baseline'}
                </div>
              </div>

              {/* Layer 3 */}
              <div className={`s-3d-ai-card ${l3Detected ? 'alert' : ''}`}>
                <div className="s-3d-ai-card-top">
                  <span className="s-3d-ai-name">L3 // AUTOENCODER NOVELTY</span>
                  <span className={`uav-badge ${l3Detected ? 'uav-badge-orange' : 'uav-badge-green'}`} style={{ fontSize: '9px' }}>
                    {l3Detected ? 'NOVEL ANOMALY' : 'NORMAL'}
                  </span>
                </div>
                <div className="s-3d-ai-desc">
                  Reconstruction Error MSE: <strong style={{ color: '#fff' }}>{l3Error}</strong> (Threshold: 0.0631)
                </div>
              </div>
            </div>
          </div>

          {/* 4-Cylinder Thermal Breakdown Table */}
          <div className="s-3d-panel">
            <div className="s-3d-panel-header">
              <span>CYLINDER HEAD & EXHAUST GAS TEMPS</span>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>4 CYLINDERS</span>
            </div>

            <div className="s-3d-cyl-table">
              {[0, 1, 2, 3].map((idx) => {
                const c = Number(cht[idx] || 178).toFixed(1);
                const e = Number(egt[idx] || 642).toFixed(0);
                const d = Number(deltaCht[idx] || 37).toFixed(1);
                const isHot = Number(c) > 200;

                return (
                  <div key={idx} className={`s-3d-cyl-box ${isHot ? 'hot' : ''}`}>
                    <div className="s-3d-cyl-title">CYL #{idx + 1}</div>
                    <div className="s-3d-cyl-temps">
                      <div style={{ color: isHot ? 'var(--status-orange)' : 'var(--text-primary)', fontWeight: 700 }}>
                        {c} °C <span style={{ fontSize: '9.5px', color: 'var(--text-muted)' }}>CHT</span>
                      </div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>
                        {e} °C <span style={{ fontSize: '9px', color: 'var(--text-dim)' }}>EGT</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Oil & Vibration Core Parameters */}
          <div className="s-3d-panel">
            <div className="s-3d-panel-header">
              <span>CORE MECHANICAL READOUTS</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '11px' }}>
              <div className="s4-spec-card" style={{ padding: '8px 10px' }}>
                <span className="s4-spec-desc">OIL PRESS</span>
                <span className="s4-spec-val" style={{ fontSize: '13px' }}>
                  {wsTelemetry?.oil_pressure_bar?.toFixed(2) || telemetry.oilPressureBar} bar
                </span>
              </div>
              <div className="s4-spec-card" style={{ padding: '8px 10px' }}>
                <span className="s4-spec-desc">OIL TEMP</span>
                <span className="s4-spec-val" style={{ fontSize: '13px' }}>
                  {wsTelemetry?.oil_temp_c?.toFixed(1) || telemetry.oilTempC} °C
                </span>
              </div>
              <div className="s4-spec-card" style={{ padding: '8px 10px' }}>
                <span className="s4-spec-desc">VIBRATION</span>
                <span className="s4-spec-val" style={{ fontSize: '13px', color: 'var(--status-green)' }}>
                  {wsTelemetry?.vibration_rms_g?.toFixed(3) || telemetry.vibrationRmsG} g
                </span>
              </div>
              <div className="s4-spec-card" style={{ padding: '8px 10px' }}>
                <span className="s4-spec-desc">FUEL FLOW</span>
                <span className="s4-spec-val" style={{ fontSize: '13px', color: 'var(--accent-cyan)' }}>
                  {telemetry.fuelFlowLh} L/h
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
