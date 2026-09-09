import React from 'react';

export function StatusReadout({ telemetry }) {
  const rpm = telemetry?.rpm !== undefined ? telemetry.rpm.toFixed(0) : '----';
  const oilPress = telemetry?.oil_pressure_bar !== undefined ? telemetry.oil_pressure_bar.toFixed(2) : '--.--';
  const oilTemp = telemetry?.oil_temp_c !== undefined ? telemetry.oil_temp_c.toFixed(1) : '--.-';
  const fuelFlow = telemetry?.fuel_flow_kg_s !== undefined ? telemetry.fuel_flow_kg_s.toFixed(5) : '-.-----';

  const healthIndexVal = telemetry?.diagnostics?.ml_diagnostics?.health_index;
  const healthIndex = healthIndexVal !== undefined ? Number(healthIndexVal).toFixed(3) : '1.000';
  const healthPercent = healthIndexVal !== undefined ? Math.max(0, Math.min(100, healthIndexVal * 100)) : 100;

  const cht = telemetry?.cht_c || ['---', '---', '---', '---'];
  const egt = telemetry?.egt_c || ['---', '---', '---', '---'];
  const deltaCht = telemetry?.diagnostics?.delta_cht_ambient || ['--', '--', '--', '--'];
  const alt = telemetry?.altitude_m !== undefined ? telemetry.altitude_m.toFixed(0) : '---';
  const altV = telemetry?.alternator_v !== undefined ? telemetry.alternator_v.toFixed(2) : '--.--';
  const vib = telemetry?.vibration_rms_g !== undefined ? telemetry.vibration_rms_g.toFixed(3) : '---';

  return (
    <div className="readout-column">
      {/* 5 Primary Telemetry Parameter Cards */}
      <div className="telemetry-grid">
        {/* RPM */}
        <div className="telemetry-card">
          <div className="telemetry-label">Engine Speed</div>
          <div className="telemetry-val-box">
            <span className="telemetry-val">{rpm}</span>
            <span className="telemetry-unit">RPM</span>
          </div>
          <div className="telemetry-sub">Rated: 5800 max</div>
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
            <span className="telemetry-val" style={{ color: 'var(--accent-emerald)' }}>{healthIndex}</span>
            <span className="telemetry-unit">/ 1.000</span>
          </div>
          <div className="health-bar-container">
            <div className="health-bar-fill" style={{ width: `${healthPercent}%` }} />
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

          return (
            <div key={idx} className="cyl-row">
              <span style={{ fontWeight: 700, color: 'var(--text-main)' }}>Cyl {idx + 1}</span>
              <span style={{ color: 'var(--text-muted)' }}>CHT: <strong style={{ color: '#fff' }}>{cFormatted}°C</strong></span>
              <span style={{ color: 'var(--text-dim)' }}>ΔAmb: {dFormatted}°C</span>
              <span style={{ color: 'var(--text-muted)' }}>EGT: <strong style={{ color: '#fff' }}>{eFormatted}°C</strong></span>
            </div>
          );
        })}
      </div>

      {/* Flight & Electrical Conditions */}
      <div className="telemetry-grid">
        <div className="telemetry-card">
          <div className="telemetry-label">Altitude</div>
          <div className="telemetry-val-box">
            <span className="telemetry-val">{alt}</span>
            <span className="telemetry-unit">m</span>
          </div>
          <div className="telemetry-sub">Barometric</div>
        </div>

        <div className="telemetry-card">
          <div className="telemetry-label">Alternator</div>
          <div className="telemetry-val-box">
            <span className="telemetry-val">{altV}</span>
            <span className="telemetry-unit">V</span>
          </div>
          <div className="telemetry-sub">Vib: {vib}g</div>
        </div>

        <div className="telemetry-card" style={{ gridColumn: 'span 2' }}>
          <div className="telemetry-label">Ambient Air Temperature</div>
          <div className="telemetry-val-box">
            <span className="telemetry-val">{telemetry?.ambient_c !== undefined ? Number(telemetry.ambient_c).toFixed(1) : '15.0'}</span>
            <span className="telemetry-unit">°C</span>
          </div>
          <div className="telemetry-sub">ISA Standard Atmosphere Model</div>
        </div>
      </div>
    </div>
  );
}
