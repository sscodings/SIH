import React from 'react';
import { useEngineTelemetry } from './hooks/useEngineTelemetry';
import { ControlBar } from './components/ControlBar';
import { FaultBanner } from './components/FaultBanner';
import { EngineViewport } from './components/EngineViewport';
import { StatusReadout } from './components/StatusReadout';
import './index.css';

export default function App() {
  const { telemetry, isConnected, sendCommand } = useEngineTelemetry();

  return (
    <div className="dashboard-app">
      {/* Tactical Header */}
      <header className="dashboard-header">
        <div className="header-brand">
          <div className="brand-icon">R914</div>
          <div>
            <h1 className="brand-title">Rotax 914F Aero Piston Engine Digital Twin</h1>
            <div className="brand-subtitle">
              MALE UAV Real-Time Telemetry, 3-Layer Hybrid AI/ML Diagnostics & Prognostics
            </div>
          </div>
        </div>

        <div className="header-badges">
          <span className="badge" style={{ background: 'rgba(51, 65, 85, 0.4)', color: 'var(--text-muted)' }}>
            IAI Heron / MALE UAV
          </span>
          <span className={`badge ${isConnected ? 'badge-connected' : 'badge-disconnected'}`}>
            <span
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: '50%',
                backgroundColor: isConnected ? 'var(--accent-emerald)' : 'var(--accent-rose)',
              }}
            />
            {isConnected ? 'LIVE TELEMETRY' : 'CONNECTING...'}
          </span>
        </div>
      </header>

      {/* Control Bar */}
      <ControlBar
        telemetry={telemetry}
        isConnected={isConnected}
        sendCommand={sendCommand}
      />

      {/* 3-Layer AI/ML Fault Banner */}
      <FaultBanner telemetry={telemetry} />

      {/* 3D Model Viewport and Parameter Readouts side-by-side */}
      <main className="main-content-grid">
        <div className="viewport-column">
          <EngineViewport telemetry={telemetry} />
        </div>

        <div className="readout-column">
          <StatusReadout telemetry={telemetry} />
        </div>
      </main>

      {/* Footer System Status */}
      <footer
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 16px',
          backgroundColor: 'var(--panel-bg)',
          border: '1px solid var(--card-border)',
          borderRadius: 'var(--radius-lg)',
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          color: 'var(--text-dim)',
        }}
      >
        <span>
          SIH26054 (DRDO) Digital Twin System | Rotax 914F Aero Piston Turbocharged Engine
        </span>
        <span>
          Architecture: L1 Physics Rules + L2 8-Fault Supervised Classifier + L3 Autoencoder Novelty Anomaly Detector
        </span>
      </footer>
    </div>
  );
}
