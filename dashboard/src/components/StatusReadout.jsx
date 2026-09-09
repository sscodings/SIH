import React from 'react';

export function StatusReadout({ telemetry }) {
  const rpm = telemetry?.rpm !== undefined ? telemetry.rpm.toFixed(0) : '----';
  const oilPress = telemetry?.oil_pressure_bar !== undefined ? telemetry.oil_pressure_bar.toFixed(2) : '--.--';
  const oilTemp = telemetry?.oil_temp_c !== undefined ? telemetry.oil_temp_c.toFixed(1) : '--.-';
  const fuelFlow = telemetry?.fuel_flow_kg_s !== undefined ? telemetry.fuel_flow_kg_s.toFixed(5) : '-.-----';

  const healthIndexVal = telemetry?.health_index ?? telemetry?.diagnostics?.ml_diagnostics?.health_index;
  const healthIndex = healthIndexVal !== undefined ? Number(healthIndexVal).toFixed(3) : '1.000';
  const healthPercent = healthIndexVal !== undefined ? Math.max(0, Math.min(100, healthIndexVal * 100)) : 100;

  const cht = telemetry?.cht_c || ['---', '---', '---', '---'];
  const egt = telemetry?.egt_c || ['---', '---', '---', '---'];
  const deltaCht = telemetry?.diagnostics?.delta_cht_ambient || ['--', '--', '--', '--'];
  const alt = telemetry?.altitude_m !== undefined ? telemetry.altitude_m.toFixed(0) : '---';
  const altV = telemetry?.alternator_v !== undefined ? telemetry.alternator_v.toFixed(2) : '--.--';
  const vib = telemetry?.vibration_rms_g !== undefined ? telemetry.vibration_rms_g.toFixed(3) : '---';

  const isCrashed = Boolean(telemetry?.craft_crashed || (Number(healthIndex) <= 0.001 && Number(alt) <= 5));
  const isEmergencyDescent = !isCrashed && Number(healthIndex) <= 0.25;

  // AI & Physics Diagnostic consensus
  const mlDiag = telemetry?.diagnostics?.ml_diagnostics || {};
  const isBrainAnomaly = Boolean(
    mlDiag.anomaly_detected || mlDiag.layer1_physics_active || mlDiag.layer3_anomaly_detected ||
    (mlDiag.layer2_predicted_fault && mlDiag.layer2_predicted_fault !== 'none' && (mlDiag.layer2_confidence ?? 0) >= 0.65)
  );
  const brainDiagnosedCyl = (typeof mlDiag.diagnosed_cylinder === 'number' && mlDiag.diagnosed_cylinder >= 0 && mlDiag.diagnosed_cylinder < 4)
    ? mlDiag.diagnosed_cylinder
    : null;

  return (
    <div className="readout-column">
      {/* Critical Crash Banner if Health is 0 or Craft Crashed */}
      {isCrashed && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.3)',
          border: '2px solid #ef4444',
          borderRadius: '8px',
          padding: '12px 16px',
          marginBottom: '12px',
          color: '#fee2e2',
          fontFamily: 'var(--font-mono)',
          fontSize: '12px',
          fontWeight: 800,
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          animation: 'pulse 1.5s infinite',
        }}>
          <span style={{ fontSize: '20px' }}>💥</span>
          <span>AIRCRAFT CRASHED — TOTAL LOSS OF ENGINE POWER & GROUND IMPACT (0 m ALTITUDE, 0 RPM)</span>
        </div>
      )}

      {/* Emergency Descent Warning if Engine Health Collapsed */}
      {isEmergencyDescent && (
        <div style={{
          backgroundColor: 'rgba(245, 158, 11, 0.25)',
          border: '1px solid #f59e0b',
          borderRadius: '8px',
          padding: '10px 14px',
          marginBottom: '12px',
          color: '#fef3c7',
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <span style={{ fontSize: '16px' }}>⚠️</span>
          <span>CRITICAL: ENGINE SEIZURE / POWER LOSS — RAPID EMERGENCY DESCENT IN PROGRESS</span>
        </div>
      )}

      {/* 5 Primary Telemetry Parameter Cards */}
      <div className="telemetry-grid">
        {/* RPM */}
        <div className={`telemetry-card ${isCrashed ? 'alert' : ''}`} style={isCrashed ? { borderColor: '#ef4444' } : {}}>
          <div className="telemetry-label">Engine Speed</div>
          <div className="telemetry-val-box">
            <span className="telemetry-val" style={isCrashed ? { color: '#ef4444' } : {}}>{rpm}</span>
            <span className="telemetry-unit">RPM</span>
          </div>
          <div className="telemetry-sub">{isCrashed ? 'SEIZED / 0 RPM' : 'Rated: 5800 max'}</div>
        </div>

        {/* Oil Pressure */}
        <div className="telemetry-card">
          <div className="telemetry-label">Oil Pressure</div>
          <div className="telemetry-val-box">
            <span className="telemetry-val" style={{ color: 'var(--accent-cyan)' }}>{oilPress}</span>
            <span className="telemetry-unit">bar</span>
          </div>
          <div className="telemetry-sub">Relief: 6.2 bar</div>
        </div>

        {/* Oil Temp */}
        <div className="telemetry-card">
          <div className="telemetry-label">Oil Temp</div>
          <div className="telemetry-val-box">
            <span className="telemetry-val">{oilTemp}</span>
            <span className="telemetry-unit">°C</span>
          </div>
          <div className="telemetry-sub">Max: 130 °C</div>
        </div>

        {/* Fuel Flow */}
        <div className="telemetry-card">
          <div className="telemetry-label">Fuel Flow</div>
          <div className="telemetry-val-box">
            <span className="telemetry-val" style={{ fontSize: '18px' }}>{fuelFlow}</span>
            <span className="telemetry-unit">kg/s</span>
          </div>
          <div className="telemetry-sub">Dual Carb Bank</div>
        </div>

        {/* Dynamic Health Index (spanning full width in column) */}
        <div className="telemetry-card" style={{ gridColumn: 'span 2' }}>
          <div className="telemetry-label">Dynamic Health Index (RUL Proxy)</div>
          <div className="telemetry-val-box">
            <span className="telemetry-val" style={{ color: Number(healthIndex) < 0.25 ? 'var(--accent-rose)' : 'var(--accent-emerald)' }}>
              {healthIndex}
            </span>
            <span className="telemetry-unit">/ 1.000</span>
          </div>
          <div className="health-bar-container">
            <div
              className="health-bar-fill"
              style={{
                width: `${healthPercent}%`,
                backgroundColor: Number(healthIndex) < 0.25 ? '#ef4444' : Number(healthIndex) < 0.6 ? '#f59e0b' : '#10b981',
              }}
            />
          </div>
        </div>
      </div>

      {/* Per-Cylinder Temperatures */}
      <div className="cylinder-temps-card">
        <div className="telemetry-label" style={{ marginBottom: '8px' }}>
          Per-Cylinder CHT & EGT Breakdown
        </div>
        {[0, 1, 2, 3].map((idx) => {
          const c = cht[idx];
          const e = egt[idx];
          const d = deltaCht[idx];
          const cFormatted = typeof c === 'number' ? c.toFixed(1) : c;
          const eFormatted = typeof e === 'number' ? e.toFixed(0) : e;
          const dFormatted = typeof d === 'number' ? d.toFixed(1) : d;

          const avgEgt = Array.isArray(egt) ? egt.reduce((a, b) => a + (Number(b) || 0), 0) / 4 : 850;
          const isHot = typeof c === 'number' && c >= 115;
          const isPhysicsAnomaly = (typeof e === 'number' && (e < 600 || (avgEgt - e > 75))) || (typeof c === 'number' && c >= 125);
          const isBrainDiagnosed = isBrainAnomaly && brainDiagnosedCyl === idx;
          const isFaulted = isPhysicsAnomaly || isBrainDiagnosed;

          return (
            <div
              key={idx}
              className="cyl-row"
              style={{
                backgroundColor: isFaulted ? 'rgba(239, 68, 68, 0.15)' : isHot ? 'rgba(245, 158, 11, 0.1)' : 'transparent',
                border: isFaulted ? '1px solid rgba(239, 68, 68, 0.4)' : '1px solid transparent',
                borderRadius: '6px',
                padding: '4px 8px',
                marginBottom: '4px',
              }}
            >
              <span style={{ fontWeight: 700, color: isFaulted ? '#f87171' : 'var(--text-main)' }}>
                Cyl {idx + 1} {isFaulted ? '⚠️' : ''}
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                CHT: <strong style={{ color: isHot ? '#f87171' : '#fff' }}>{cFormatted}°C</strong>
              </span>
              <span style={{ color: 'var(--text-dim)' }}>ΔAmb: {dFormatted}°C</span>
              <span style={{ color: 'var(--text-muted)' }}>
                EGT: <strong style={{ color: '#fff' }}>{eFormatted}°C</strong>
              </span>
            </div>
          );
        })}
      </div>

      {/* Flight & Electrical Conditions */}
      <div className="telemetry-grid">
        <div className="telemetry-card" style={isCrashed ? { borderColor: '#ef4444' } : isEmergencyDescent ? { borderColor: '#f59e0b' } : {}}>
          <div className="telemetry-label">Flight Altitude</div>
          <div className="telemetry-val-box">
            <span className="telemetry-val" style={isCrashed ? { color: '#ef4444' } : isEmergencyDescent ? { color: '#f59e0b' } : {}}>{alt}</span>
            <span className="telemetry-unit">m</span>
          </div>
          <div className="telemetry-sub">{isCrashed ? 'GROUND IMPACT' : isEmergencyDescent ? 'SINKING' : 'Barometric'}</div>
        </div>

        <div className="telemetry-card">
          <div className="telemetry-label">Alternator</div>
          <div className="telemetry-val-box">
            <span className="telemetry-val">{altV}</span>
            <span className="telemetry-unit">V</span>
          </div>
          <div className="telemetry-sub">Vib: {vib}g</div>
        </div>
      </div>
    </div>
  );
}
