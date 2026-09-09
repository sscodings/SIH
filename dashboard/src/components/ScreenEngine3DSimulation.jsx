import React, { useState } from 'react';
import { EngineViewport } from './EngineViewport';

const FAULT_OPTIONS = [
  { value: 'misfire', label: '1. Misfire (Cylinder Combustion Drop)' },
  { value: 'injector_abnormalities', label: '2. Injector Mismatch (Dual-Bank Fuel Deficit)' },
  { value: 'cooling_degradation', label: '3. Cooling Heat Rejection Loss' },
  { value: 'lubrication_issues', label: '4. Lubrication Pressure Deficit' },
  { value: 'sensor_drift', label: '5. CHT Sensor Drift Inconsistency' },
  { value: 'combustion_instability', label: '6. Combustion Cyclic Jitter' },
  { value: 'overheating_trends', label: '7. Overheating Thermal Runaway' },
  { value: 'abnormal_vibration', label: '8. Gearbox 1x / Camshaft Vibration Spike' },
];

const getAffectedComponentName = (fault, cylIdx) => {
  const cNum = (cylIdx !== undefined && cylIdx !== null ? cylIdx : 0) + 1;
  if (fault === 'misfire') return `Cylinder #${cNum} (Combustion Chamber)`;
  if (fault === 'injector_abnormalities' || fault === 'injector_abnormal') return 'Intake Manifold / Dual-Bank Fuel Rails';
  if (fault === 'cooling_degradation') return 'Coolant Lines & Radiator Assembly';
  if (fault === 'lubrication_issues' || fault === 'lubrication_issue') return 'Oil Sump, Pump & Lubrication Circuit';
  if (fault === 'sensor_drift') return `CHT Sensor #${cNum}`;
  if (fault === 'combustion_instability') return `Cylinder #${cNum} Combustion / Spark Rail`;
  if (fault === 'overheating_trends' || fault === 'overheating_trend') return 'Cylinder Head Thermal Jacket';
  if (fault === 'abnormal_vibration') return 'Propeller Gearbox & Reduction Drive';
  return 'Propulsion Assembly';
};

export function ScreenEngine3DSimulation({ telemetry, wsTelemetry, isConnected, sendCommand, onBack }) {
  // Configurable Simulation Controls
  const [selectedFault, setSelectedFault] = useState('misfire');
  const [severityVal, setSeverityVal] = useState(0.75); // 0.50 Low, 0.75 Med, 0.90 High
  const [simSpeed, setSimSpeed] = useState(1);         // 1x, 2x, 4x
  const [rampDuration, setRampDuration] = useState(3.5); // 2.0s, 3.5s, 6.0s (ODE progression rate)
  const [targetCylinder, setTargetCylinder] = useState(0); // Cyl 1-4
  const [throttleVal, setThrottleVal] = useState(65);

  // Active Simulation State
  const isRunning = wsTelemetry?.is_running ?? false;
  const simTime = wsTelemetry?.t !== undefined ? wsTelemetry.t.toFixed(1) : (telemetry.utcTime || '0.0');

  // Primary Critical Live Parameters
  const rtm = wsTelemetry?.rtm_percent !== undefined ? Number(wsTelemetry.rtm_percent).toFixed(1) : (isRunning ? '98.4' : '100.0');
  const engineLoad = wsTelemetry?.engine_load_pct !== undefined ? Number(wsTelemetry.engine_load_pct).toFixed(1) : (isRunning ? '77.2' : '0.0');
  const rpm = wsTelemetry?.rpm !== undefined ? Math.round(wsTelemetry.rpm) : (isRunning ? (telemetry.rpm || 4500) : 0);
  const healthIndexVal = wsTelemetry?.health_index !== undefined ? Number(wsTelemetry.health_index) : 1.0;
  const healthPercent = Math.max(0, Math.min(100, healthIndexVal * 100));

  // Dynamic RTM Status Styling
  const rtmNum = Number(rtm);
  const rtmStatus = rtmNum >= 90 ? 'OPTIMAL' : (rtmNum >= 75 ? 'DEGRADED' : 'CRITICAL');
  const rtmColor = rtmNum >= 90 ? 'var(--status-green)' : (rtmNum >= 75 ? 'var(--status-orange)' : '#ef4444');

  // Injected Fault & Detection State (Decoupled Fault Progression)
  const injectedFault = wsTelemetry?.injected_fault || {
    is_injected: false,
    kind: 'none',
    cylinder: 0,
    severity: 0.0,
    ramp_s: 3.5,
    elapsed_s: 0.0,
    is_detected: false,
  };

  const activeFaults = Array.isArray(wsTelemetry?.active_faults) ? wsTelemetry.active_faults.filter(f => f && f !== 'none') : [];
  const mlDiag = wsTelemetry?.diagnostics?.ml_diagnostics || {};
  const isDetected = activeFaults.length > 0 || Boolean(mlDiag.anomaly_detected);
  const detectedFault = (activeFaults[0] || mlDiag.fault_type || 'none').toLowerCase();
  const ruleMsg = mlDiag.message || wsTelemetry?.ml_pipeline?.engine_response || 'Nominal operation';
  const recommendation = wsTelemetry?.ml_pipeline?.recommendation || 'Continuous parameter monitoring active.';

  // 4-Cylinder Head & Exhaust Gas Temperatures
  const cht = wsTelemetry?.cht_c || [telemetry.cht || 178, (telemetry.cht || 178) - 1.2, (telemetry.cht || 178) - 0.8, (telemetry.cht || 178) + 1.4];
  const egt = wsTelemetry?.egt_c || [telemetry.egt || 642, (telemetry.egt || 642) - 3.5, (telemetry.egt || 642) + 2.1, (telemetry.egt || 642) - 1.0];
  const deltaChtAmbient = wsTelemetry?.diagnostics?.delta_cht_ambient || [37.2, 36.8, 37.5, 38.1];

  // Secondary Engine Parameters
  const oilPress = wsTelemetry?.oil_pressure_bar !== undefined ? wsTelemetry.oil_pressure_bar.toFixed(2) : (telemetry.oilPressureBar || '4.12');
  const oilTemp = wsTelemetry?.oil_temp_c !== undefined ? wsTelemetry.oil_temp_c.toFixed(1) : (telemetry.oilTempC || '84.8');
  const fuelPress = wsTelemetry?.fuel_pressure_bar !== undefined ? wsTelemetry.fuel_pressure_bar.toFixed(2) : '1.36';
  const fuelFlowLh = wsTelemetry?.fuel_flow_l_h !== undefined ? wsTelemetry.fuel_flow_l_h.toFixed(1) : (telemetry.fuelFlowLh || 19.6);
  const mapHpa = wsTelemetry?.map_hpa !== undefined ? wsTelemetry.map_hpa.toFixed(0) : '1013';
  const mapInhg = wsTelemetry?.map_inhg !== undefined ? wsTelemetry.map_inhg.toFixed(2) : '29.92';
  const afrActual = wsTelemetry?.afr_actual !== undefined ? wsTelemetry.afr_actual.toFixed(2) : '14.70';
  const lambdaRatio = wsTelemetry?.lambda_ratio !== undefined ? wsTelemetry.lambda_ratio.toFixed(3) : '1.000';
  const vibRms = wsTelemetry?.vibration_rms_g !== undefined ? wsTelemetry.vibration_rms_g.toFixed(3) : (telemetry.vibrationRmsG || 0.824);
  const vibOrders = wsTelemetry?.vibration_orders || { amp_1x_g: 0.051, amp_cam_g: 0.031, amp_fire_g: 0.081 };
  const alternatorV = wsTelemetry?.alternator_v !== undefined ? wsTelemetry.alternator_v.toFixed(2) : '28.20';
  const ambientC = wsTelemetry?.ambient_c !== undefined ? wsTelemetry.ambient_c.toFixed(1) : '15.0';
  const altitudeM = wsTelemetry?.altitude_m !== undefined ? Math.round(wsTelemetry.altitude_m) : '1200';

  const deltaEgtMax = wsTelemetry?.delta_egt_max !== undefined ? Number(wsTelemetry.delta_egt_max).toFixed(1) : (Math.max(...egt) - Math.min(...egt)).toFixed(1);
  const deltaChtMax = wsTelemetry?.delta_cht_max !== undefined ? Number(wsTelemetry.delta_cht_max).toFixed(1) : (Math.max(...cht) - Math.min(...cht)).toFixed(1);
  const vibCam = vibOrders.amp_cam_g !== undefined ? Number(vibOrders.amp_cam_g).toFixed(3) : '0.031';
  const vib1x = vibOrders.amp_1x_g !== undefined ? Number(vibOrders.amp_1x_g).toFixed(3) : '0.051';
  const vibFire = vibOrders.amp_fire_g !== undefined ? Number(vibOrders.amp_fire_g).toFixed(3) : '0.081';

  // Ramp progress calculation
  const rampTotal = Number(injectedFault.ramp_s) || 3.5;
  const rampElapsed = Number(injectedFault.elapsed_s) || 0.0;
  const rampProgressPct = Math.min(100, Math.max(0, (rampElapsed / rampTotal) * 100));

  // Interactive Control Handlers
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

  const handleSimSpeedChange = (speed) => {
    setSimSpeed(speed);
    if (sendCommand) {
      sendCommand({
        command: 'set_sim_speed',
        speed: speed,
      });
    }
  };

  const handleInjectFault = () => {
    if (sendCommand) {
      sendCommand({
        command: 'inject_fault',
        kind: selectedFault,
        severity: severityVal,
        cylinder: targetCylinder,
        ramp_s: rampDuration,
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
            <span className="s-3d-main-sub">IAI HERON / MALE UAV ENGINE SIMULATOR & PARAMETER-BASED DETECTION CORE</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span className={`uav-badge ${isConnected ? 'uav-badge-green' : 'uav-badge-orange'}`}>
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: isConnected ? 'var(--status-green)' : 'var(--status-orange)' }} />
            {isConnected ? 'LIVE WEBSOCKET STREAM' : 'LOCAL SIMULATION MODE'}
          </span>
          <span className="uav-badge uav-badge-cyan">4-CYL TURBOCHARGED</span>
          <span className="uav-badge uav-badge-cyan" style={{ background: 'rgba(46, 230, 166, 0.12)', borderColor: 'rgba(46, 230, 166, 0.4)' }}>
            PHYSICS-BASED RULE ENGINE
          </span>
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
              {isRunning ? 'RUNNING' : 'STANDBY / OFF'}
            </span>
            <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>(T: {simTime}s)</span>
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
            style={{ width: '110px', accentColor: 'var(--accent-cyan)', cursor: 'pointer' }}
          />
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--accent-cyan)', minWidth: '38px', fontFamily: 'var(--font-mono)' }}>
            {throttleVal}%
          </span>
        </div>

        {/* Right: Simulation Speed Multiplier */}
        <div className="s-3d-btn-group">
          <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
            SIM SPEED:
          </span>
          {[1, 2, 4].map((spd) => (
            <button
              key={spd}
              type="button"
              className={`sim-pill-btn ${simSpeed === spd ? 'active' : ''}`}
              onClick={() => handleSimSpeedChange(spd)}
            >
              {spd}x
            </button>
          ))}
        </div>
      </div>

      {/* Configurable Simulation Control Panel */}
      <div className="s-3d-sim-control-panel">
        <div className="sim-ctrl-row">
          {/* Fault Selector */}
          <div className="sim-ctrl-group">
            <span className="sim-ctrl-label">FAULT MODE:</span>
            <select
              value={selectedFault}
              onChange={(e) => setSelectedFault(e.target.value)}
              className="hud-select"
              style={{ minWidth: '240px' }}
            >
              {FAULT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Target Cylinder */}
          <div className="sim-ctrl-group">
            <span className="sim-ctrl-label">TARGET CYL:</span>
            {[0, 1, 2, 3].map((cylIdx) => (
              <button
                key={cylIdx}
                type="button"
                className={`sim-pill-btn ${targetCylinder === cylIdx ? 'active' : ''}`}
                onClick={() => setTargetCylinder(cylIdx)}
              >
                CYL #{cylIdx + 1}
              </button>
            ))}
          </div>

          {/* Fault Severity */}
          <div className="sim-ctrl-group">
            <span className="sim-ctrl-label">SEVERITY:</span>
            {[
              { label: 'LOW 50%', val: 0.50 },
              { label: 'MED 75%', val: 0.75 },
              { label: 'HIGH 90%', val: 0.90 }
            ].map((s) => (
              <button
                key={s.label}
                type="button"
                className={`sim-pill-btn ${Math.abs(severityVal - s.val) < 0.05 ? 'active' : ''}`}
                onClick={() => setSeverityVal(s.val)}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* Ramp Duration (Controls ODE Progression Rate) */}
          <div className="sim-ctrl-group">
            <span className="sim-ctrl-label" title="Controls how quickly physical fault effect develops in engine differential equations">
              RAMP TIME:
            </span>
            {[
              { label: '2.0s', val: 2.0 },
              { label: '3.5s', val: 3.5 },
              { label: '6.0s', val: 6.0 }
            ].map((r) => (
              <button
                key={r.label}
                type="button"
                className={`sim-pill-btn ${Math.abs(rampDuration - r.val) < 0.1 ? 'active' : ''}`}
                onClick={() => setRampDuration(r.val)}
                title={`Physical ODE progression ramp: ${r.val} seconds`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="sim-ctrl-row" style={{ borderTop: '1px solid rgba(255, 255, 255, 0.06)', paddingTop: '8px' }}>
          {/* Scientific Physics-Grounded Banner */}
          <div style={{ flex: '1', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
            <span style={{ color: 'var(--accent-cyan)', fontWeight: 700 }}>🔬 PHYSICS-DRIVEN DETECTION:</span>
            <span>
              Fault injection initiates physical progression in engine ODEs. Detection occurs emergently when live parameters satisfy SIH-main PhysicsRuleEngine thresholds.
            </span>
          </div>

          {/* Action Trigger Buttons */}
          <div className="s-3d-btn-group">
            <button
              type="button"
              className="hud-ctrl-btn pause"
              onClick={handleInjectFault}
              style={{
                background: isDetected ? 'rgba(239, 68, 68, 0.2)' : 'rgba(0, 229, 255, 0.15)',
                borderColor: isDetected ? '#ef4444' : 'var(--accent-cyan)',
                color: '#ffffff',
                fontWeight: 800,
                padding: '6px 14px'
              }}
            >
              ▶ INJECT FAULT
            </button>

            <button
              type="button"
              className="hud-ctrl-btn reset"
              onClick={handleClearFaults}
              style={{ padding: '6px 14px' }}
            >
              ✕ CLEAR FAULT
            </button>
          </div>
        </div>
      </div>

      {/* Main Grid: 3D CAD Viewport on Left, Diagnostics & Telemetry on Right */}
      <div className="s-3d-content-grid">
        {/* Left Column: 3D Engine CAD Viewport */}
        <div className="s-3d-viewport-card">
          <div className="hud-corner-tl" />
          <div className="hud-corner-tr" />
          <div className="hud-corner-bl" />
          <div className="hud-corner-br" />

          {/* Three.js Engine Viewport Canvas */}
          <EngineViewport telemetry={wsTelemetry || telemetry} />
        </div>

        {/* Right Column: Physics Diagnostics & Engine Telemetry Breakdown */}
        <div className="s-3d-sidebar-col">
          {/* PRIMARY CRITICAL METRIC 1: Live RTM (Running / Real-Time Monitoring Index) */}
          <div className={`rtm-hero-card ${rtmNum < 75 ? 'critical' : (rtmNum < 90 ? 'warning' : '')}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.08em', color: '#ffffff' }}>
                  RTM // RUNNING MARGIN INDEX
                </span>
                <span className="uav-badge" style={{ fontSize: '9px', background: 'rgba(255, 255, 255, 0.05)', color: rtmColor, borderColor: rtmColor }}>
                  {rtmStatus}
                </span>
              </div>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                DYNAMIC ENGINE STATE
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                <span style={{ fontSize: '32px', fontWeight: 900, color: rtmColor, fontFamily: 'var(--font-mono)', lineHeight: 1 }}>
                  {rtm}%
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                  THERMAL & COMBUSTION HEADROOM
                </span>
              </div>
              <div style={{ textAlign: 'right', fontSize: '11px', color: 'var(--text-secondary)' }}>
                LOAD: <strong style={{ color: '#fff', fontFamily: 'var(--font-mono)' }}>{engineLoad}%</strong>
              </div>
            </div>

            {/* Responsive RTM Progress Bar */}
            <div className="s1-progress-track" style={{ height: '6px' }}>
              <div
                className="s1-progress-fill"
                style={{
                  width: `${Math.min(100, Math.max(0, rtmNum))}%`,
                  background: rtmNum < 75
                    ? '#ef4444'
                    : (rtmNum < 90 ? 'linear-gradient(90deg, #f59e0b, #ef4444)' : 'linear-gradient(90deg, #2ee6a6, #00e5ff)'),
                  boxShadow: rtmNum < 75 ? '0 0 10px rgba(239, 68, 68, 0.6)' : 'none'
                }}
              />
            </div>
          </div>

          {/* PRIMARY CRITICAL METRIC 2: Dynamic Health Index (RUL) & Engine RPM */}
          <div className="s-3d-panel">
            <div className="s-3d-panel-header">
              <span>CRITICAL PROPULSION OPERATING STATE</span>
              <span className="uav-badge uav-badge-green" style={{ fontSize: '9px' }}>
                {healthPercent.toFixed(1)}% RUL
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '8px' }}>
              <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '6px 8px', borderRadius: '3px', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>CRANKSHAFT SPEED</span>
                <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
                  {rpm} <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>RPM</span>
                </div>
              </div>
              <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '6px 8px', borderRadius: '3px', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>HEALTH INDEX</span>
                <div style={{ fontSize: '20px', fontWeight: 800, color: healthIndexVal < 0.8 ? 'var(--status-orange)' : 'var(--status-green)', fontFamily: 'var(--font-mono)' }}>
                  {healthIndexVal.toFixed(3)} <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>/ 1.0</span>
                </div>
              </div>
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

          {/* AUTHENTIC PARAMETER-BASED FAULT DETECTION & DIAGNOSTICS CARD (SIH-main SOURCE OF TRUTH) */}
          <div
            className="s-3d-panel"
            style={{
              borderLeft: isDetected
                ? '3px solid #ef4444'
                : '3px solid var(--accent-cyan)',
              background: isDetected ? 'rgba(239, 68, 68, 0.04)' : 'var(--bg-panel)'
            }}
          >
            <div className="s-3d-panel-header">
              <span>PHYSICS RULE ENGINE // FAULT DIAGNOSTICS</span>
              <span
                className={`uav-badge ${
                  isDetected
                    ? 'uav-badge-orange'
                    : (!isRunning ? 'uav-badge-gray' : 'uav-badge-green')
                }`}
                style={{
                  fontSize: '9px',
                  borderColor: isDetected ? '#ef4444' : undefined,
                  color: isDetected ? '#ef4444' : undefined
                }}
              >
                {!isRunning
                  ? 'ENGINE STANDBY'
                  : (isDetected ? 'RULE TRIGGERED' : 'NOMINAL')}
              </span>
            </div>

            {/* STATE 1: Engine is Cold / Standby (Not Running) */}
            {!isRunning && (
              <div style={{ background: 'rgba(0, 0, 0, 0.25)', border: '1px solid rgba(255, 255, 255, 0.06)', borderRadius: '3px', padding: '10px' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  PROPULSION SYSTEM INACTIVE (STANDBY)
                </div>
                <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                  Engine ignition is OFF. Telemetry is idle at 0 RPM and 0.0 bar oil pressure. Press <strong style={{ color: 'var(--status-green)' }}>▶ RESUME</strong> to initiate engine rotation, fuel delivery, and thermodynamic physics simulation.
                </div>
              </div>
            )}

            {/* STATE 2: Engine Running (No fault detected yet) */}
            {isRunning && !isDetected && (
              <div style={{ background: 'rgba(0, 0, 0, 0.25)', border: '1px solid rgba(255, 255, 255, 0.06)', borderRadius: '3px', padding: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--status-green)', boxShadow: '0 0 8px rgba(46, 230, 166, 0.6)' }} />
                  <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--status-green)' }}>
                    ALL PHYSICAL PARAMETERS NOMINAL
                  </span>
                </div>
                <div style={{ fontSize: '10.5px', color: 'var(--text-secondary)', lineHeight: '1.4', marginBottom: '8px' }}>
                  Thermodynamic, lubrication, and vibration parameters are within Rotax 914 certified flight tolerances.
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-dim)', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '6px' }}>
                  PhysicsRuleEngine actively evaluating: Misfire (ΔEGT, Vib_cam), Injector Balance, Cooling, Lubrication, Sensor Drift, and Harmonics.
                </div>
              </div>
            )}

            {/* STATE 4: Fault Detected by PhysicsRuleEngine */}
            {isDetected && (
              <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: '3px', padding: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 900, color: '#ef4444', letterSpacing: '0.04em' }}>
                    ⚠ PHYSICAL FAULT DETECTED: {detectedFault.toUpperCase().replace('_', ' ')}
                  </span>
                  <span className="uav-badge" style={{ fontSize: '9px', background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444', borderColor: '#ef4444' }}>
                    RULE TRIGGERED
                  </span>
                </div>

                {/* Trigger Message directly from SIH-main PhysicsRuleEngine */}
                <div style={{ background: 'rgba(0, 0, 0, 0.35)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: '3px', padding: '6px 8px', marginBottom: '8px' }}>
                  <span style={{ fontSize: '9.5px', color: 'var(--text-muted)', display: 'block', marginBottom: '2px' }}>
                    PHYSICSRULEENGINE DETERMINISTIC TRIGGER:
                  </span>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#ffaaaa', fontFamily: 'var(--font-mono)' }}>
                    {ruleMsg}
                  </span>
                </div>

                {/* Actual Parameter Readouts at Detection */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', marginBottom: '8px', fontSize: '9.5px', fontFamily: 'var(--font-mono)' }}>
                  <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '4px', borderRadius: '2px' }}>
                    <span style={{ color: 'var(--text-muted)', display: 'block' }}>ΔEGT CROSS</span>
                    <strong style={{ color: '#ef4444', fontSize: '11px' }}>{deltaEgtMax} °C</strong>
                  </div>
                  <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '4px', borderRadius: '2px' }}>
                    <span style={{ color: 'var(--text-muted)', display: 'block' }}>CAM VIB</span>
                    <strong style={{ color: '#ef4444', fontSize: '11px' }}>{vibCam} g</strong>
                  </div>
                  <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '4px', borderRadius: '2px' }}>
                    <span style={{ color: 'var(--text-muted)', display: 'block' }}>TOTAL RMS</span>
                    <strong style={{ color: '#fff', fontSize: '11px' }}>{vibRms} g</strong>
                  </div>
                </div>

                {/* 3D Component Target */}
                <div style={{ fontSize: '10.5px', color: '#ffffff', marginBottom: '6px' }}>
                  3D COMPONENT HIGHLIGHTED: <strong style={{ color: '#ff7777' }}>{getAffectedComponentName(detectedFault, injectedFault.cylinder || targetCylinder)}</strong>
                </div>

                {/* Actionable Maintenance Recommendation */}
                <div style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '3px', padding: '6px 8px' }}>
                  <div style={{ fontSize: '9.5px', fontWeight: 800, color: '#ff8888', letterSpacing: '0.04em' }}>
                    RECOMMENDED MAINTENANCE ACTION:
                  </div>
                  <div style={{ fontSize: '10.5px', color: '#ffffff' }}>
                    {recommendation}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 4-Cylinder Thermal Breakdown Table */}
          <div className="s-3d-panel">
            <div className="s-3d-panel-header">
              <span>CYLINDER HEAD & EXHAUST GAS TEMPS</span>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>4 CYLINDERS</span>
            </div>

            <div className="s-3d-cyl-table">
              {[0, 1, 2, 3].map((idx) => {
                const c = Number(cht[idx] || (isRunning ? 178 : 22)).toFixed(1);
                const e = Number(egt[idx] || (isRunning ? 642 : 22)).toFixed(0);
                const isHot = Number(c) > 200;
                const isEgtDropped = isDetected && detectedFault === 'misfire' && idx === (injectedFault.cylinder ?? targetCylinder);

                return (
                  <div key={idx} className={`s-3d-cyl-box ${isHot ? 'hot' : ''}`} style={isEgtDropped ? { borderColor: '#ef4444', background: 'rgba(239, 68, 68, 0.08)' } : {}}>
                    <div className="s-3d-cyl-title">
                      CYL #{idx + 1}
                      {isEgtDropped && <span style={{ color: '#ef4444', fontSize: '9px', display: 'block' }}>MISFIRE</span>}
                    </div>
                    <div className="s-3d-cyl-temps">
                      <div style={{ color: isHot ? 'var(--status-orange)' : 'var(--text-primary)', fontWeight: 700 }}>
                        {c} °C <span style={{ fontSize: '9.5px', color: 'var(--text-muted)' }}>CHT</span>
                      </div>
                      <div style={{ color: isEgtDropped ? '#ef4444' : 'var(--text-secondary)', fontSize: '10px' }}>
                        {e} °C <span style={{ fontSize: '9px', color: 'var(--text-dim)' }}>EGT</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* COMPACT SECONDARY TELEMETRY GRID */}
          <div className="s-3d-panel">
            <div className="s-3d-panel-header">
              <span>ENGINE SENSOR TELEMETRY</span>
              <span style={{ fontSize: '9.5px', color: 'var(--text-muted)' }}>CALIBRATED SENSORS</span>
            </div>

            <div className="s-3d-secondary-grid">
              {/* Oil Pressure */}
              <div className={`s-3d-secondary-item ${isRunning && Number(oilPress) < 2.5 ? 'critical' : ''}`}>
                <span style={{ color: 'var(--text-muted)' }}>OIL PRESSURE</span>
                <strong style={{ color: isRunning && Number(oilPress) < 2.5 ? '#ef4444' : 'var(--text-primary)' }}>
                  {oilPress} bar
                </strong>
              </div>

              {/* Oil Temperature */}
              <div className={`s-3d-secondary-item ${isRunning && Number(oilTemp) > 105 ? 'warning' : ''}`}>
                <span style={{ color: 'var(--text-muted)' }}>OIL TEMP</span>
                <strong style={{ color: isRunning && Number(oilTemp) > 105 ? 'var(--status-orange)' : 'var(--text-primary)' }}>
                  {oilTemp} °C
                </strong>
              </div>

              {/* Fuel Pressure */}
              <div className="s-3d-secondary-item">
                <span style={{ color: 'var(--text-muted)' }}>FUEL PRESS</span>
                <strong style={{ color: 'var(--accent-cyan)' }}>
                  {fuelPress} bar
                </strong>
              </div>

              {/* Fuel Flow */}
              <div className="s-3d-secondary-item">
                <span style={{ color: 'var(--text-muted)' }}>FUEL FLOW</span>
                <strong style={{ color: 'var(--accent-cyan)' }}>
                  {fuelFlowLh} L/h
                </strong>
              </div>

              {/* Manifold Pressure (MAP) */}
              <div className="s-3d-secondary-item">
                <span style={{ color: 'var(--text-muted)' }}>MANIFOLD (MAP)</span>
                <strong style={{ color: '#ffffff' }}>
                  {mapHpa} hPa <span style={{ fontSize: '9px', color: 'var(--text-dim)' }}>({mapInhg}")</span>
                </strong>
              </div>

              {/* Air-Fuel Ratio / Lambda */}
              <div className="s-3d-secondary-item">
                <span style={{ color: 'var(--text-muted)' }}>AFR / LAMBDA</span>
                <strong style={{ color: '#ffffff' }}>
                  {afrActual} <span style={{ fontSize: '9px', color: 'var(--text-dim)' }}>({lambdaRatio}λ)</span>
                </strong>
              </div>

              {/* Vibration Total RMS */}
              <div className={`s-3d-secondary-item ${isRunning && Number(vibRms) > 1.2 ? 'critical' : (isRunning && Number(vibRms) > 0.95 ? 'warning' : '')}`}>
                <span style={{ color: 'var(--text-muted)' }}>TOTAL VIB RMS</span>
                <strong style={{ color: isRunning && Number(vibRms) > 1.2 ? '#ef4444' : 'var(--status-green)' }}>
                  {vibRms} g
                </strong>
              </div>

              {/* Vibration Harmonic Orders */}
              <div className="s-3d-secondary-item">
                <span style={{ color: 'var(--text-muted)' }}>VIB HARMONICS</span>
                <strong style={{ fontSize: '9.5px', color: 'var(--text-secondary)' }}>
                  1x:{vibOrders.amp_1x_g}g | Fire:{vibOrders.amp_fire_g}g
                </strong>
              </div>

              {/* Alternator Bus */}
              <div className="s-3d-secondary-item">
                <span style={{ color: 'var(--text-muted)' }}>ALTERNATOR BUS</span>
                <strong style={{ color: isRunning ? 'var(--status-green)' : 'var(--text-dim)' }}>
                  {alternatorV} V
                </strong>
              </div>

              {/* Environmental Ambient & Altitude */}
              <div className="s-3d-secondary-item">
                <span style={{ color: 'var(--text-muted)' }}>ALT / AMBIENT</span>
                <strong style={{ color: 'var(--text-secondary)' }}>
                  {altitudeM}m | {ambientC}°C
                </strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
