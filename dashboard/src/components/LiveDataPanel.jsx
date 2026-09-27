import React from 'react';
import { fmt, fmtInt, humanize, isNum, kgPerSecToLitresPerHour } from '../utils/format';

const maxOf = (arr) => (Array.isArray(arr) && arr.length && arr.every(isNum) ? Math.max(...arr) : null);

function healthColor(health) {
  if (!isNum(health)) return undefined;
  if (health < 0.25) return '#ef4444';
  if (health < 0.6) return '#f59e0b';
  return '#10b981';
}

/** Label/value live-data table for the 3D Digital Twin page. */
export function LiveDataPanel({ telemetry }) {
  const isReplay = telemetry?.sim_mode === 'mission_replay';
  const health = telemetry?.health_index;
  const hColor = healthColor(health);
  const mlDiag = telemetry?.diagnostics?.ml_diagnostics || {};
  const diagnosedCyl = mlDiag.anomaly_detected && isNum(mlDiag.diagnosed_cylinder) ? mlDiag.diagnosed_cylinder : null;
  const cht = telemetry?.cht_c || [];
  const egt = telemetry?.egt_c || [];

  const rows = [
    { label: 'RPM', value: fmtInt(telemetry?.rpm), unit: 'RPM', color: telemetry?.craft_crashed ? '#ef4444' : undefined },
    { label: 'CHT (MAX)', value: fmt(maxOf(cht), 1), unit: '°C', color: 'var(--status-green)' },
    { label: 'EGT (MAX)', value: fmt(maxOf(egt), 1), unit: '°C', color: 'var(--status-orange)' },
    { label: 'OIL PRESS', value: fmt(telemetry?.oil_pressure_bar, 2), unit: 'BAR' },
    { label: 'OIL TEMP', value: fmt(telemetry?.oil_temp_c, 1), unit: '°C' },
    { label: 'FUEL FLOW', value: fmt(kgPerSecToLitresPerHour(telemetry?.fuel_flow_kg_s), 1), unit: 'L/H', color: 'var(--accent-cyan)' },
    { label: 'VIB (RMS)', value: fmt(telemetry?.vibration_rms_g, 3), unit: 'g' },
    { label: 'ALTERNATOR', value: fmt(telemetry?.alternator_v, 2), unit: 'V' },
    { label: 'ALTITUDE', value: fmtInt(telemetry?.altitude_m), unit: 'm' },
  ];

  const badge = !telemetry?.sim_mode
    ? { text: 'NO DATA', cls: 'uav-badge-orange' }
    : isReplay
      ? { text: `REPLAY · MISSION ${telemetry.replay?.mission_id}`, cls: 'uav-badge-cyan' }
      : { text: 'SANDBOX · LIVE PHYSICS', cls: 'uav-badge-green' };

  return (
    <div className="data-panel">
      <div className="data-panel-header">
        <span className="panel-heading">LIVE DATA</span>
        <span className={`uav-badge ${badge.cls}`}>{badge.text}</span>
      </div>

      <div className="data-row">
        <span className="data-label">PHASE:</span>
        <span className="data-val">{telemetry?.mission_phase ? humanize(telemetry.mission_phase) : '---'}</span>
      </div>
      <div className="data-row data-row-stacked">
        <div className="data-row-line">
          <span className="data-label">HEALTH INDEX:</span>
          <span className="data-val" style={hColor ? { color: hColor } : undefined}>{fmt(health, 3)} / 1.000</span>
        </div>
        <div className="health-bar-container">
          <div
            className="health-bar-fill"
            style={{ width: `${isNum(health) ? Math.max(0, Math.min(100, health * 100)) : 0}%`, backgroundColor: hColor }}
          />
        </div>
      </div>

      {rows.map((row) => (
        <div key={row.label} className="data-row">
          <span className="data-label">{row.label}:</span>
          <span className="data-val" style={row.color ? { color: row.color } : undefined}>
            {row.value} {row.unit}
          </span>
        </div>
      ))}

      <div className="data-subhead">PER-CYLINDER CHT / EGT</div>
      {[0, 1, 2, 3].map((idx) => (
        <div key={idx} className={`data-row ${diagnosedCyl === idx ? 'data-row-alert' : ''}`}>
          <span className="data-label">CYL {idx + 1}{diagnosedCyl === idx ? ' ⚠' : ''}</span>
          <span className="data-val">
            {fmt(cht[idx], 1)} °C · {fmt(egt[idx], 0)} °C
          </span>
        </div>
      ))}

      {isReplay && (
        <div className="panel-footnote">
          Recorded dataset has one CHT channel (shown on all cylinders) and no alternator reading.
        </div>
      )}
    </div>
  );
}
