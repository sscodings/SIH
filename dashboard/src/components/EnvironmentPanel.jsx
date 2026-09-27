import React from 'react';
import { fmt, humanize } from '../utils/format';

/** Ambient conditions: ISA model in sandbox mode, recorded climate data in mission replay. */
export function EnvironmentPanel({ telemetry }) {
  const env = telemetry?.environment;
  const isRecorded = env?.source === 'climate_dataset';
  const notModelled = env && !isRecorded ? 'N/A IN SANDBOX' : '---';

  const cells = [
    { label: 'OUTSIDE AIR TEMP', value: `${fmt(env?.temp_c, 1)} °C` },
    { label: 'PRESSURE', value: `${fmt(env?.pressure_hpa, 1)} hPa` },
    { label: 'AIR DENSITY', value: `${fmt(env?.density_kg_m3, 3)} kg/m³` },
    { label: 'HUMIDITY', value: env?.humidity_pct != null ? `${fmt(env.humidity_pct, 1)} %` : notModelled },
    {
      label: 'WIND',
      value: env?.wind_speed_kt != null ? `${fmt(env.wind_speed_kt, 1)} kt @ ${fmt(env.wind_dir_deg, 0)}° REL` : notModelled,
    },
    { label: 'WEATHER PROFILE', value: env?.weather_profile ? humanize(env.weather_profile) : notModelled },
  ];

  return (
    <div className="data-panel">
      <div className="data-panel-header">
        <span className="panel-heading">ENVIRONMENT</span>
        <span className={`uav-badge ${isRecorded ? 'uav-badge-cyan' : 'uav-badge-green'}`}>
          {!env ? 'NO DATA' : isRecorded ? 'RECORDED CLIMATE' : 'ISA ATMOSPHERE MODEL'}
        </span>
      </div>
      <div className="env-grid">
        {cells.map((cell) => (
          <div key={cell.label} className="env-cell">
            <span className="data-label">{cell.label}</span>
            <span className="data-val">{cell.value}</span>
          </div>
        ))}
      </div>
      {env && !isRecorded && (
        <div className="panel-footnote">
          Sandbox models temperature and pressure from altitude (ISA) only. Select a recorded mission for measured
          humidity, wind and weather profile.
        </div>
      )}
    </div>
  );
}
