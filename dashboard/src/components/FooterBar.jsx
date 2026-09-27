import React from 'react';
import { isNum } from '../utils/format';

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

  if (activeTab === 'health_summary') {
    const diag = telemetry.diagnostics?.ml_diagnostics;
    return (
      <footer className="uav-footer">
        <div className="uav-footer-left">
          <span>DIAGNOSTIC ENGINE: <strong style={{ color: '#fff' }}>{diag ? 'ONLINE' : 'NO DATA'}</strong></span>
          <span style={{ color: 'var(--border-hairline-bright)' }}>|</span>
          <span style={{ color: diag?.anomaly_detected ? 'var(--status-orange)' : 'var(--status-green)', fontWeight: 700 }}>
            {diag ? (diag.anomaly_detected ? 'ANOMALY DETECTED' : 'NO ACTIVE ANOMALY') : 'AWAITING TELEMETRY'}
          </span>
        </div>
        <div className="uav-footer-right">
          <span>UAV AIRFRAME: <strong>MQ-9 BLK-5</strong></span>
          <span>MODE: <strong style={{ color: 'var(--accent-cyan)' }}>HEALTH SUMMARY</strong></span>
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
        <span>ALT: {isNum(telemetry.altitude_m) ? `${Math.round(telemetry.altitude_m / 0.3048).toLocaleString()} FT MSL` : '--- FT MSL'}</span>
      </div>
      <div className="uav-footer-right">
        <span>FRAME RATE: <strong>{telemetry.fps || 60} FPS</strong></span>
        <span>LATENCY: <strong>{telemetry.latencyMs || 14}ms</strong></span>
        <span>{telemetry.interfaceBus || "MIL-STD-1553 INTERFACE"}</span>
      </div>
    </footer>
  );
}
