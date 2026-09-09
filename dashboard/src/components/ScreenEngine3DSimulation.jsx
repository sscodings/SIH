import React, { useState } from 'react';
import { EngineViewport } from './EngineViewport';

const PIPELINE_STAGES = [
  { key: 'NORMAL', label: '1. NORMAL', desc: 'Baseline Envelope' },
  { key: 'INJECTED', label: '2. INJECTED', desc: 'Propagation Latency' },
  { key: 'PROPAGATING', label: '3. PROPAGATING', desc: 'Physics Ramp' },
  { key: 'DATA_COLLECTION', label: '4. DATA ACCUM', desc: 'Windowing' },
  { key: 'ML_ANALYZING', label: '5. ML ANALYZING', desc: 'Neural Inference' },
  { key: 'ANOMALY_DETECTED', label: '6. ANOMALY DETECTED', desc: 'Threshold Crossed' },
  { key: 'FAULT_CLASSIFIED', label: '7. FAULT CLASSIFIED', desc: 'Alert Dispatched' },
];

export function ScreenEngine3DSimulation({ telemetry, wsTelemetry, isConnected, sendCommand, onBack }) {
  // Configurable Simulation Controls
  const [selectedFault, setSelectedFault] = useState('misfire');
  const [severityVal, setSeverityVal] = useState(0.75); // 0.50 Low, 0.75 Med, 0.90 High
  const [simSpeed, setSimSpeed] = useState(1);         // 1x, 2x, 4x
  const [detectionThreshold, setDetectionThreshold] = useState(80); // 60% to 95%
  const [rampDuration, setRampDuration] = useState(3.5); // 2.0s, 3.5s, 6.0s
  const [targetCylinder, setTargetCylinder] = useState(0); // Cyl 1-4
  const [throttleVal, setThrottleVal] = useState(65);

  // Active Simulation State
  const isRunning = wsTelemetry?.is_running ?? false;
  const simTime = wsTelemetry?.t !== undefined ? wsTelemetry.t.toFixed(1) : telemetry.utcTime;

  // Primary Critical Live Parameters
  const rtm = wsTelemetry?.rtm_percent !== undefined ? Number(wsTelemetry.rtm_percent).toFixed(1) : '98.4';
  const engineLoad = wsTelemetry?.engine_load_pct !== undefined ? Number(wsTelemetry.engine_load_pct).toFixed(1) : '77.2';
  const rpm = wsTelemetry?.rpm !== undefined ? Math.round(wsTelemetry.rpm) : (telemetry.rpm || 4500);
  const healthIndexVal = wsTelemetry?.health_index !== undefined ? Number(wsTelemetry.health_index) : 0.985;
  const healthPercent = Math.max(0, Math.min(100, healthIndexVal * 100));

  // Dynamic RTM Status Styling
  const rtmNum = Number(rtm);
  const rtmStatus = rtmNum >= 90 ? 'OPTIMAL' : (rtmNum >= 75 ? 'DEGRADED' : 'CRITICAL');
  const rtmColor = rtmNum >= 90 ? 'var(--status-green)' : (rtmNum >= 75 ? 'var(--status-orange)' : '#ef4444');

  // Progressive ML Pipeline State (Decoupled Fault Progression)
  const pipeline = wsTelemetry?.ml_pipeline || {};
  const stage = pipeline.stage || 'NORMAL';
  const stageLabel = pipeline.stage_label || 'Normal Baseline Envelope';
  const injectedFault = pipeline.injected_fault || 'none';
  const isDetected = Boolean(pipeline.is_detected);
  const detectedFault = pipeline.detected_fault || 'none';
  const engineResponse = pipeline.engine_response || 'Nominal Baseline';
  const mlStatus = pipeline.ml_status || 'Monitoring live telemetry stream';
  const mlConfPct = pipeline.ml_confidence_pct !== undefined ? Number(pipeline.ml_confidence_pct).toFixed(1) : '1.5';
  const devPct = pipeline.telemetry_deviation_pct !== undefined ? Number(pipeline.telemetry_deviation_pct).toFixed(1) : '0.0';
  const latencyS = pipeline.detection_latency_s !== undefined ? Number(pipeline.detection_latency_s).toFixed(1) : '0.0';
  const recommendation = pipeline.recommendation || 'Engine running nominally. Continuous predictive monitoring active.';
  const thresholdPct = pipeline.detection_threshold !== undefined ? Math.round(pipeline.detection_threshold * 100) : detectionThreshold;

  // ML Diagnostics from Layer 1, 2, 3
  const mlDiag = wsTelemetry?.diagnostics?.ml_diagnostics || {};
  const l1Detected = Boolean(mlDiag.anomaly_detected);
  const l1Fault = mlDiag.fault_type || 'none';
  const l1Msg = mlDiag.message || 'Nominal physics thermodynamic envelope';

  const l2Fault = mlDiag.layer2_predicted_fault || 'none';
  const l2Conf = mlDiag.layer2_confidence !== undefined ? (mlDiag.layer2_confidence * 100).toFixed(1) : '94.2';
  const l2Active = isDetected && l2Fault !== 'none' && l2Fault !== 'healthy';

  const l3Detected = Boolean(isDetected && mlDiag.layer3_anomaly_detected);
  const l3Error = mlDiag.layer3_reconstruction_error !== undefined ? Number(mlDiag.layer3_reconstruction_error).toFixed(4) : '0.0142';

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

  const handleThresholdChange = (e) => {
    const val = Number(e.target.value);
    setDetectionThreshold(val);
    if (sendCommand) {
      sendCommand({
        command: 'set_detection_threshold',
        threshold: val / 100.0,
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
        detection_threshold: detectionThreshold / 100.0,
        start_in_s: 0.0,
      });
    }
  };

  const handleClearFaults = () => {
    if (sendCommand) sendCommand({ command: 'clear_faults' });
  };

  // Helper for Stepper Stage Status
  const getStageStatus = (stageKey) => {
    const currentIdx = PIPELINE_STAGES.findIndex(s => s.key === stage);
    const thisIdx = PIPELINE_STAGES.findIndex(s => s.key === stageKey);
    if (stage === stageKey) return isDetected ? 'active alert' : 'active';
    if (currentIdx > thisIdx) return 'completed';
    return 'pending';
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
            <span className="s-3d-main-sub">IAI HERON / MALE UAV ENGINE SIMULATOR & FAULT PROGRESSION CORE</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span className={`uav-badge ${isConnected ? 'uav-badge-green' : 'uav-badge-orange'}`}>
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: isConnected ? 'var(--status-green)' : 'var(--status-orange)' }} />
            {isConnected ? 'LIVE WEBSOCKET STREAM' : 'LOCAL SIMULATION MODE'}
          </span>
          <span className="uav-badge uav-badge-cyan">4-CYL TURBOCHARGED</span>
          <span className="uav-badge uav-badge-cyan" style={{ background: 'rgba(46, 230, 166, 0.12)', borderColor: 'rgba(46, 230, 166, 0.4)' }}>
            AI PREDICTIVE MAINTENANCE
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
              {isRunning ? 'RUNNING' : 'PAUSED'}
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

      {/* Configurable Simulation Control Panel (Requirement 10) */}
      <div className="s-3d-sim-control-panel">
        <div className="sim-ctrl-row">
          {/* Fault Selector */}
          <div className="sim-ctrl-group">
            <span className="sim-ctrl-label">FAULT MODE:</span>
            <select
              value={selectedFault}
              onChange={(e) => setSelectedFault(e.target.value)}
              className="hud-select"
              style={{ minWidth: '220px' }}
            >
              <option value="misfire">1. Misfire (Cyl 1 Combustion Drop)</option>
              <option value="injector_abnormalities">2. Injector Mismatch (Bank A/B)</option>
              <option value="cooling_degradation">3. Cooling Heat Rejection Loss</option>
              <option value="lubrication_issues">4. Lubrication Pressure Deficit</option>
              <option value="sensor_drift">5. Sensor Inconsistency Drift</option>
              <option value="combustion_instability">6. Combustion Cyclic Jitter</option>
              <option value="overheating_trends">7. Overheating Thermal Spike</option>
              <option value="abnormal_vibration">8. 1x/Cam Gearbox Vibration Spike</option>
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

          {/* Ramp Duration */}
          <div className="sim-ctrl-group">
            <span className="sim-ctrl-label">RAMP TIME:</span>
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
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="sim-ctrl-row" style={{ borderTop: '1px solid rgba(255, 255, 255, 0.06)', paddingTop: '8px' }}>
          {/* Detection Confidence Threshold Slider */}
          <div className="sim-ctrl-group" style={{ flex: '1', minWidth: '280px' }}>
            <span className="sim-ctrl-label">DETECTION THRESHOLD:</span>
            <input
              type="range"
              min="60"
              max="95"
              step="5"
              value={detectionThreshold}
              onChange={handleThresholdChange}
              style={{ width: '130px', accentColor: 'var(--status-orange)', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--status-orange)', fontFamily: 'var(--font-mono)' }}>
              {detectionThreshold}% CONFIDENCE REQUIRED
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

        {/* Right Column: AI Diagnostics & Engine Telemetry Breakdown */}
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

          {/* ML PROGRESSION & REASONING PIPELINE HUD (Requirement 6) */}
          <div className="s-3d-panel" style={{ borderLeft: isDetected ? '3px solid #ef4444' : '3px solid var(--accent-cyan)' }}>
            <div className="s-3d-panel-header">
              <span>AI/ML PREDICTIVE DETECTION PIPELINE</span>
              <span className={`uav-badge ${isDetected ? 'uav-badge-orange' : (stage === 'NORMAL' ? 'uav-badge-green' : 'uav-badge-cyan')}`} style={{ fontSize: '9px' }}>
                {stage.replace('_', ' ')}
              </span>
            </div>

            {/* 7-Stage Visual Stepper Breadcrumb */}
            <div className="ml-pipeline-stepper">
              {PIPELINE_STAGES.map((s, idx) => (
                <React.Fragment key={s.key}>
                  <div className={`ml-stepper-item ${getStageStatus(s.key)}`} title={s.desc}>
                    {s.label}
                  </div>
                  {idx < PIPELINE_STAGES.length - 1 && (
                    <span className="ml-stepper-arrow">›</span>
                  )}
                </React.Fragment>
              ))}
            </div>

            {/* Pipeline Metrics Card */}
            <div style={{ background: 'rgba(0, 0, 0, 0.25)', border: '1px solid rgba(255, 255, 255, 0.06)', borderRadius: '3px', padding: '10px', marginBottom: '8px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '8px', fontSize: '11px', marginBottom: '8px' }}>
                <div>
                  <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>ENGINE PHYSICAL RESPONSE:</span>
                  <div style={{ color: isDetected ? '#ff8888' : 'var(--text-primary)', fontWeight: 600 }}>
                    {engineResponse}
                  </div>
                </div>
                <div>
                  <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>DETECTION LATENCY:</span>
                  <div style={{ color: isDetected ? 'var(--status-orange)' : 'var(--text-dim)', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                    {latencyS}s {isDetected ? '(Threshold crossed)' : '(Accumulating)'}
                  </div>
                </div>
              </div>

              <div style={{ fontSize: '10.5px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                <span style={{ color: 'var(--text-muted)' }}>ML STATUS: </span>
                <strong style={{ color: '#fff' }}>{mlStatus}</strong>
              </div>

              {/* Dynamic Anomaly Confidence Progress with Threshold Marker */}
              <div style={{ marginBottom: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '3px' }}>
                  <span>ANOMALY CONFIDENCE: <strong style={{ color: isDetected ? '#ef4444' : 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>{mlConfPct}%</strong></span>
                  <span>THRESHOLD: <strong style={{ color: 'var(--status-orange)', fontFamily: 'var(--font-mono)' }}>{thresholdPct}%</strong></span>
                </div>
                <div style={{ position: 'relative', width: '100%', height: '8px', background: 'rgba(255, 255, 255, 0.08)', borderRadius: '4px', overflow: 'hidden' }}>
                  {/* Threshold Guide Marker */}
                  <div
                    style={{
                      position: 'absolute',
                      left: `${thresholdPct}%`,
                      top: 0,
                      bottom: 0,
                      width: '2px',
                      background: 'rgba(245, 166, 35, 0.9)',
                      zIndex: 2,
                    }}
                    title={`Detection Threshold: ${thresholdPct}%`}
                  />
                  {/* Confidence Fill */}
                  <div
                    style={{
                      width: `${Math.min(100, Math.max(0, Number(mlConfPct)))}%`,
                      height: '100%',
                      background: isDetected
                        ? '#ef4444'
                        : (Number(mlConfPct) >= thresholdPct - 15 ? 'linear-gradient(90deg, #00e5ff, #f59e0b)' : 'var(--accent-cyan)'),
                      transition: 'width 0.25s ease-out'
                    }}
                  />
                </div>
              </div>

              {/* Actionable Maintenance Recommendation */}
              {isDetected && (
                <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '3px', padding: '6px 8px', marginTop: '6px' }}>
                  <div style={{ fontSize: '10px', fontWeight: 800, color: '#ff7777', letterSpacing: '0.04em' }}>
                    RECOMMENDED ACTION:
                  </div>
                  <div style={{ fontSize: '10.5px', color: '#ffffff' }}>
                    {recommendation}
                  </div>
                </div>
              )}
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
                  {l1Detected ? `Rule active: ${l1Fault.toUpperCase()} - ${l1Msg}` : 'Thermodynamic & oil pressure physics nominal'}
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
                  {l2Active ? `Classified: ${l2Fault.toUpperCase()} (${l2Conf}% confidence)` : 'Supervised neural classifier: Nominal baseline'}
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
                  Novelty Recon MSE: <strong style={{ color: '#fff' }}>{l3Error}</strong> (Threshold: 0.0631)
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
                const d = Number(deltaChtAmbient[idx] || 37).toFixed(1);
                const isHot = Number(c) > 200;
                const isEgtDropped = isDetected && detectedFault === 'misfire' && idx === 0;

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

          {/* COMPACT SECONDARY TELEMETRY GRID (Requirement 1) */}
          <div className="s-3d-panel">
            <div className="s-3d-panel-header">
              <span>ENGINE SENSOR TELEMETRY</span>
              <span style={{ fontSize: '9.5px', color: 'var(--text-muted)' }}>CALIBRATED METRICS</span>
            </div>

            <div className="s-3d-secondary-grid">
              {/* Oil Pressure */}
              <div className={`s-3d-secondary-item ${Number(oilPress) < 2.5 ? 'critical' : ''}`}>
                <span style={{ color: 'var(--text-muted)' }}>OIL PRESSURE</span>
                <strong style={{ color: Number(oilPress) < 2.5 ? '#ef4444' : 'var(--text-primary)' }}>
                  {oilPress} bar
                </strong>
              </div>

              {/* Oil Temperature */}
              <div className={`s-3d-secondary-item ${Number(oilTemp) > 105 ? 'warning' : ''}`}>
                <span style={{ color: 'var(--text-muted)' }}>OIL TEMP</span>
                <strong style={{ color: Number(oilTemp) > 105 ? 'var(--status-orange)' : 'var(--text-primary)' }}>
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
              <div className={`s-3d-secondary-item ${Number(vibRms) > 1.2 ? 'critical' : (Number(vibRms) > 0.95 ? 'warning' : '')}`}>
                <span style={{ color: 'var(--text-muted)' }}>TOTAL VIB RMS</span>
                <strong style={{ color: Number(vibRms) > 1.2 ? '#ef4444' : 'var(--status-green)' }}>
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
                <strong style={{ color: 'var(--status-green)' }}>
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
