import React from 'react';

export function ScreenHealthSummary({ telemetry }) {
  const s5 = telemetry.s5 || {};
  const score = s5.healthScore || 92.4;

  // SVG Circular Gauge Arc Math
  const radius = 100;
  const strokeWidth = 10;
  const circumference = 2 * Math.PI * radius;
  // Arc starts from top (-90deg), score goes from 0 to 100%
  const strokeDashoffset = circumference - (score / 100) * circumference;

  return (
    <div className="s5-container">
      {/* Eyebrow & Main Headings */}
      <div className="uav-section-eyebrow">
        PREDICTIVE MAINTENANCE SUITE // BENCHMARK REV 4.8 VS SENSOR FEED DOWNLINK
      </div>
      <h1 className="uav-screen-title" style={{ marginBottom: '8px' }}>
        OVERALL HEALTH SUMMARY
      </h1>
      <div className="uav-section-subtitle">
        DIGITAL TWIN CONVERGENCE & SYSTEM INTEGRITY
      </div>

      {/* Centerpiece Circular Health Gauge */}
      <div className="s5-gauge-wrapper">
        <svg width="240" height="240" viewBox="0 0 240 240" style={{ transform: 'rotate(-90deg)' }}>
          {/* Background Track (Dotted Dim Arc) */}
          <circle
            cx="120"
            cy="120"
            r={radius}
            fill="none"
            stroke="rgba(255, 255, 255, 0.12)"
            strokeWidth={strokeWidth}
            strokeDasharray="4,4"
          />

          {/* Foreground Active Orange Arc */}
          <circle
            cx="120"
            cy="120"
            r={radius}
            fill="none"
            stroke="#f59e0b"
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            style={{
              filter: 'drop-shadow(0 0 8px rgba(245, 158, 11, 0.6))',
              transition: 'stroke-dashoffset 0.8s ease'
            }}
          />
        </svg>

        {/* Gauge Inner Text */}
        <div className="s5-gauge-center">
          <div className="s5-gauge-percent">
            {score}<span className="s5-gauge-percent-unit">%</span>
          </div>
          <div className="s5-gauge-caption">
            OVERALL ENGINE HEALTH SCORE
          </div>
        </div>
      </div>

      {/* Active Anomaly Pill */}
      <div className="s5-anomaly-pill">
        <span className="uav-dot-orange" />
        <span>1 ACTIVE ANOMALY DETECTED</span>
      </div>

      {/* 3-Column Statistical Summary */}
      <div className="s5-three-col-stats">
        <div className="s5-stat-block">
          <span className="s5-stat-lbl">IDEAL BASELINE</span>
          <span className="s5-stat-val">{s5.idealBaseline || "100.0%"}</span>
        </div>
        <div className="s5-stat-block">
          <span className="s5-stat-lbl">REAL COMPLIANCE</span>
          <span className="s5-stat-val orange">{s5.realCompliance || "92.4%"}</span>
        </div>
        <div className="s5-stat-block">
          <span className="s5-stat-lbl">DELTA VARIANCE</span>
          <span className="s5-stat-val">{s5.deltaVariance || "-7.6%"}</span>
        </div>
      </div>

      {/* Highlighted Warning Card */}
      <div className="s5-warning-card">
        <div className="s5-warning-left">
          <div className="s5-warning-title">
            <span className="uav-dot-orange" />
            <span>{s5.warning?.name || "VIBRATION SIGNATURE (RMS)"}</span>
          </div>
          <span className="s5-warning-sub">
            {s5.warning?.desc || "Engine Mount Accelerometer #2 // Tri-Axial Node"}
          </span>
        </div>

        <div className="s5-warning-right">
          <div className="s5-compare-item">
            <span className="s5-compare-lbl">IDEAL BASELINE</span>
            <span className="s5-compare-val">{s5.warning?.ideal || "< 0.30 g"}</span>
          </div>
          <div className="s5-compare-item">
            <span className="s5-compare-lbl">REAL SENSOR</span>
            <span className="s5-compare-val orange">{s5.warning?.real || "0.34 g"}</span>
          </div>
          <span className="uav-badge uav-badge-orange" style={{ padding: '5px 10px', fontSize: '10.5px' }}>
            {s5.warning?.chip || "+0.04 g (+13.3%) WARNING"}
          </span>
        </div>
      </div>

      {/* Row of 4 Nominal Status Cards */}
      <div className="s5-nominal-grid">
        {s5.nominals?.map((card, idx) => (
          <div key={idx} className="s5-nom-card">
            <div className="s5-nom-left">
              <span className="s5-nom-lbl">{card.label}</span>
              <span className="s5-nom-val">
                {card.val} <span>{card.unit}</span>
              </span>
            </div>
            <span className="uav-badge uav-badge-green" style={{ fontSize: '9px', padding: '2px 6px' }}>
              NOMINAL
            </span>
          </div>
        ))}
      </div>

      {/* Diagnosis Bottom Advisory Bar */}
      <div className="s5-diag-bar">
        <div className="s5-diag-text">
          <strong>DIAGNOSIS:</strong> VIBRATION HARMONIC ELEVATION MATCHING AFT MOUNT BUSHING
        </div>
        <div className="s5-flight-status">
          FLIGHT STATUS: ADVISORY / LOW RISK
        </div>
      </div>
    </div>
  );
}
