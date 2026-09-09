import React from 'react';

export function ScreenIdealVsReal({ telemetry }) {
  const s4 = telemetry.s4 || { ideal: [], real: [] };

  return (
    <div className="s4-dual-container">
      {/* Left Column: IDEAL DATA (Baseline Digital Twin) */}
      <div className="s4-column">
        <div className="s4-col-header">
          <div className="s4-col-topline">
            <span>SPECIFICATION MODEL // REV 4.8</span>
            <span className="uav-badge uav-badge-gray">BENCHMARK ACTIVE</span>
          </div>
          <h2 className="s4-col-title">IDEAL DATA</h2>
          <div className="s4-col-subtitle">DIGITAL TWIN BASELINE // NOMINAL OPERATING PROFILE</div>
        </div>

        <div className="s4-card-list">
          {s4.ideal.map((item, idx) => (
            <div key={idx} className="s4-spec-card">
              <div className="s4-spec-label-grp">
                <span className="s4-spec-name">{item.name}</span>
                <span className="s4-spec-desc">{item.desc}</span>
              </div>
              <div className="s4-spec-val-grp">
                <span className="s4-spec-val">{item.val}</span>
                <span className="s4-spec-val-desc">{item.unit}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Center Technical Compass / Timeline Motif Divider */}
      <div className="s4-divider-col">
        <div className="s4-divider-line" />
        <div className="s4-compass-node">NORTH-00°</div>
        <div className="s4-compass-node mid">REF // Δ</div>
        <div className="s4-compass-node">SOUTH-180°</div>
      </div>

      {/* Right Column: REAL DATA (Live Telemetry Feed) */}
      <div className="s4-column">
        <div className="s4-col-header">
          <div className="s4-col-topline">
            <span>DOWNLINK: S-BAND DIRECT // RSSI: -48 DBM</span>
            <span className="uav-badge uav-badge-green">
              <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', backgroundColor: 'var(--status-green)' }} />
              STREAM ONLINE
            </span>
          </div>
          <h2 className="s4-col-title">REAL DATA</h2>
          <div className="s4-col-subtitle">LIVE TELEMETRY STREAM // SENSOR TELEMETRY FEED</div>
        </div>

        <div className="s4-card-list">
          {s4.real.map((item, idx) => {
            const isWarning = item.status === 'warning';

            return (
              <div key={idx} className={`s4-spec-card ${isWarning ? 'warning-card' : ''}`}>
                <div className="s4-spec-label-grp">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span className="s4-spec-name" style={{ color: isWarning ? 'var(--status-orange)' : '#ffffff' }}>
                      {item.name}
                    </span>
                    {isWarning && <span className="uav-dot-orange" />}
                  </div>
                  <span className="s4-spec-desc">{item.desc}</span>
                </div>

                <div className="s4-spec-val-grp">
                  <span className={`s4-spec-val ${isWarning ? 'warning' : ''}`}>
                    {item.val} <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>{item.unit}</span>
                  </span>
                  {item.delta && (
                    <span className={`uav-delta-chip ${isWarning ? 'warning' : 'nominal'}`}>
                      {item.delta}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
