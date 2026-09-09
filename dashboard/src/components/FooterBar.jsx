import React from 'react';

export function FooterBar({ activeTab, telemetry }) {
  if (activeTab === 'livestats_graph') {
    return (
      <footer className="uav-footer" style={{ justifyContent: 'center' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: '11px', letterSpacing: '0.08em' }}>
          UAV ENGINE TELEMETRY NODE V4.1 // REAL-TIME DATA STREAM LINK ESTABLISHED
        </div>
      </footer>
    );
  }

  if (activeTab === 'livestats') {
    return (
      <footer className="uav-footer">
        <div className="uav-footer-left">
          <span>AIRFRAME: <strong>PREDATOR CLASS UAV</strong> | PROPULSION: <strong style={{ color: 'var(--accent-cyan)' }}>ROTAX 914 F</strong></span>
        </div>
        <div className="uav-footer-right">
          <span>SECURE LINK: <strong style={{ color: 'var(--status-green)' }}>ENCRYPTED (AES-256)</strong></span>
        </div>
      </footer>
    );
  }

  if (activeTab === 'ideal_real' || activeTab === 'health_summary') {
    return (
      <footer className="uav-footer">
        <div className="uav-footer-left">
          <span>DIAGNOSTIC ENGINE: <strong style={{ color: '#fff' }}>11 OF 11 SENSORS OPERATIONAL</strong></span>
          <span style={{ color: 'var(--border-hairline-bright)' }}>|</span>
          <span style={{ color: 'var(--status-orange)', fontWeight: 700 }}>
            1 MINOR VARIANCE DETECTED (VIBRATION HARMONIC)
          </span>
        </div>
        <div className="uav-footer-right">
          <span>UAV AIRFRAME: <strong>MQ-9 BLK-5</strong></span>
          <span>MODE: <strong style={{ color: 'var(--accent-cyan)' }}>{activeTab === 'ideal_real' ? 'DUAL COMPARATOR' : 'HEALTH SUMMARY'}</strong></span>
        </div>
      </footer>
    );
  }

  // Default / Screen 1 (SIMULATION)
  return (
    <footer className="uav-footer">
      <div className="uav-footer-left">
        <span className="uav-dot-pulse" style={{ width: 6, height: 6 }} />
        <span>NODE: <strong>{telemetry.nodeId || "GCU-ALPHA-01"}</strong></span>
        <span>{telemetry.coordinates || "LAT: 34°12'04\"N  LON: 118°28'12\"W  ALT: 18,400 FT MSL"}</span>
      </div>
      <div className="uav-footer-right">
        <span>FRAME RATE: <strong>{telemetry.fps || 60} FPS</strong></span>
        <span>LATENCY: <strong>{telemetry.latencyMs || 14}ms</strong></span>
        <span>{telemetry.interfaceBus || "MIL-STD-1553 INTERFACE"}</span>
      </div>
    </footer>
  );
}
