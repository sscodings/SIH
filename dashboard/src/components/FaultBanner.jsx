import React from 'react';

export function FaultBanner({ telemetry }) {
  const diag = telemetry?.diagnostics?.ml_diagnostics || {};

  // Layer 1 data (Physics Rules)
  const l1Detected = Boolean(diag.anomaly_detected);
  const l1Fault = diag.fault_type || 'none';
  const l1Msg = diag.message || 'Physics thermodynamic checks nominal';

  // Layer 2 data (8-Class ML Classifier)
  const l2Fault = diag.layer2_predicted_fault || 'none';
  const l2Conf = diag.layer2_confidence !== undefined ? (diag.layer2_confidence * 100).toFixed(1) : '---';
  const l2Active = l2Fault !== 'none' && l2Fault !== 'healthy';

  // Layer 3 data (Autoencoder Novel Anomaly Detector)
  const l3Detected = Boolean(diag.layer3_anomaly_detected);
  const l3Error = diag.layer3_reconstruction_error !== undefined ? Number(diag.layer3_reconstruction_error).toFixed(4) : '---';

  return (
    <div className="fault-banner">
      {/* LAYER 1: Physics Rules Engine */}
      <div className={`layer-card ${l1Detected ? 'l1-active' : 'dimmed'}`}>
        <div className="layer-header">
          <div className="layer-title-box">
            <span className="layer-badge">LAYER 1</span>
            <span className="layer-name">Physics Rules</span>
          </div>
          <span className={`layer-status-pill ${l1Detected ? 'pill-alert' : 'pill-nominal'}`}>
            {l1Detected ? 'ALERT' : 'NOMINAL'}
          </span>
        </div>

        <div className="layer-body">
          <div className="layer-label">Deterministic Check:</div>
          <div className="layer-value-row">
            <span className="layer-value">
              {l1Fault.replace(/_/g, ' ').toUpperCase()}
            </span>
          </div>
          <div className="layer-subtext" title={l1Msg}>
            {l1Msg}
          </div>
        </div>
      </div>

      {/* LAYER 2: Trained Multi-Class Classifier */}
      <div className={`layer-card ${l2Active ? 'l2-active' : 'dimmed'}`}>
        <div className="layer-header">
          <div className="layer-title-box">
            <span className="layer-badge">LAYER 2</span>
            <span className="layer-name">8-Fault Classifier</span>
          </div>
          <span className={`layer-status-pill ${l2Active ? 'pill-warning' : 'pill-nominal'}`}>
            {l2Active ? 'FAULT DETECTED' : 'HEALTHY'}
          </span>
        </div>

        <div className="layer-body">
          <div className="layer-label">Supervised Prediction:</div>
          <div className="layer-value-row">
            <span className="layer-value">
              {l2Fault.replace(/_/g, ' ').toUpperCase()}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 700, color: 'var(--accent-cyan)' }}>
              {l2Conf}%
            </span>
          </div>
          <div className="layer-subtext">
            Trained supervised model outputting class probabilities
          </div>
        </div>
      </div>

      {/* LAYER 3: Autoencoder Novelty Anomaly Detector */}
      <div className={`layer-card ${l3Detected ? 'l3-active' : 'dimmed'}`}>
        <div className="layer-header">
          <div className="layer-title-box">
            <span className="layer-badge">LAYER 3</span>
            <span className="layer-name">Autoencoder Novelty</span>
          </div>
          <span className={`layer-status-pill ${l3Detected ? 'pill-purple' : 'pill-nominal'}`}>
            {l3Detected ? 'ANOMALY DETECTED' : 'NORMAL'}
          </span>
        </div>

        <div className="layer-body">
          <div className="layer-label">Reconstruction Error:</div>
          <div className="layer-value-row">
            <span className="layer-value" style={{ color: l3Detected ? 'var(--accent-purple)' : '#fff' }}>
              MSE: {l3Error}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-dim)' }}>
              (Limit: 0.0631)
            </span>
          </div>
          <div className="layer-subtext">
            Unsupervised neural autoencoder detecting unmodeled/novel shifts
          </div>
        </div>
      </div>
    </div>
  );
}
