import React, { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { fmt, fmtInt, humanize, isNum } from '../utils/format';

const EXPORT_BG = '#08090c';
const EXPORT_MARGIN_PX = 32;

// Whole-flight parameters from the server's flight_summary.stats, in dashboard display units.
const FLIGHT_PARAMS = [
  { key: 'rpm', label: 'ENGINE SPEED', unit: 'RPM', digits: 0 },
  { key: 'cht_c', label: 'CHT', note: 'HOTTEST CYL', unit: '°C', digits: 1 },
  { key: 'egt_c', label: 'EGT', note: 'HOTTEST CYL', unit: '°C', digits: 1 },
  { key: 'oil_temp_c', label: 'OIL TEMPERATURE', unit: '°C', digits: 1 },
  { key: 'oil_pressure_bar', label: 'OIL PRESSURE', unit: 'bar', digits: 2 },
  { key: 'fuel_flow_lh', label: 'FUEL FLOW', unit: 'L/h', digits: 1 },
  { key: 'vibration_rms_g', label: 'VIBRATION', unit: 'g', digits: 3 },
  { key: 'altitude_m', label: 'ALTITUDE', unit: 'm', digits: 0 },
];

// Detection sources in layer order.
const DETECTOR_NAMES = {
  physics_rule: 'Physics rules (L1)',
  ml_classifier: 'AI classifier (L2)',
  autoencoder: 'Autoencoder (L3)',
  twin_residual: 'Digital-twin residual',
};

const pct = (h) => (isNum(h) ? `${(h * 100).toFixed(1)}%` : '---');

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} H ${String(m).padStart(2, '0')} MIN`;
  if (sec) return m ? `${m} MIN ${String(sec).padStart(2, '0')} S` : `${sec} S`;
  return `${m} MIN`;
}

/** A point in the flight: recorded minute in replay, T+ clock in the sandbox. */
const formatInstant = (seconds, replay) => (replay ? `MIN ${Math.round(seconds / 60)}` : `T+ ${formatClock(seconds)}`);

/** What the summary describes, for the PDF header and file name (not shown on screen). */
function describeSource(telemetry) {
  if (telemetry?.sim_mode === 'mission_replay' && telemetry.replay) {
    const r = telemetry.replay;
    return {
      text: `MISSION ${r.mission_id} REPLAY · ${humanize(r.mission_type)}`,
      slug: `mission-${r.mission_id}_min-${r.elapsed_min}`,
    };
  }
  if (telemetry?.sim_mode === 'sandbox') {
    return {
      text: 'LIVE SANDBOX',
      slug: `sandbox_t-${Math.floor(telemetry.t ?? 0)}s`,
    };
  }
  return { text: 'NO TELEMETRY', slug: 'no-telemetry' };
}

function coverageNote(summary, replay) {
  if (!summary) return 'AWAITING TELEMETRY';
  if (!summary.flight_time_s) return 'NO FLIGHT DATA YET';
  const scope = summary.complete ? (replay ? 'FULL FLIGHT' : 'FLIGHT ENDED') : 'FLIGHT SO FAR';
  return `${scope} · ${formatDuration(summary.flight_time_s)} · ${fmt(summary.fuel_used_l, 1)} L FUEL USED`;
}

function IssueRow({ issue, replay, complete }) {
  let status = 'CLEARED';
  if (issue.active) status = complete ? (replay ? 'PRESENT AT LANDING' : 'PRESENT AT END') : 'ONGOING';
  const until = issue.active && !complete ? 'NOW' : formatInstant(issue.last_t_s, replay);
  const layerOrder = Object.keys(DETECTOR_NAMES);
  const detectors = [...issue.detected_by]
    .sort((a, b) => layerOrder.indexOf(a) - layerOrder.indexOf(b))
    .map((d) => DETECTOR_NAMES[d] || humanize(d))
    .join(' + ');

  return (
    <li className={`s5-issue ${issue.active ? 's5-issue-active' : ''}`}>
      <div className="s5-issue-head">
        <span className="s5-issue-name">{issue.label}</span>
        <span className={`uav-badge ${issue.active ? 'uav-badge-orange' : 'uav-badge-green'}`}>{status}</span>
      </div>
      <dl className="s5-issue-meta">
        <div>
          <dt>DETECTED</dt>
          <dd>{formatInstant(issue.first_t_s, replay)} – {until}</dd>
        </div>
        <div>
          <dt>FLAGGED FOR</dt>
          <dd>{formatDuration(issue.flagged_s)}</dd>
        </div>
        <div>
          <dt>DETECTED BY</dt>
          <dd>{detectors || '---'}</dd>
        </div>
        {issue.cylinders.length > 0 && (
          <div>
            <dt>{issue.cylinders.length > 1 ? 'CYLINDERS' : 'CYLINDER'}</dt>
            <dd>{issue.cylinders.join(', ')}</dd>
          </div>
        )}
        <div>
          <dt>ENGINE HEALTH</dt>
          <dd>{pct(issue.health_at_onset)} → {pct(issue.health_latest)}</dd>
        </div>
      </dl>
    </li>
  );
}

export function ScreenHealthSummary({ telemetry }) {
  const pageRef = useRef(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [snapshotStamp, setSnapshotStamp] = useState(null);

  const health = telemetry?.health_index;
  const score = isNum(health) ? health * 100 : null;
  const diag = telemetry?.diagnostics?.ml_diagnostics;
  const hasAnomaly = Boolean(diag?.anomaly_detected);
  const injected = telemetry?.active_faults || [];
  const source = describeSource(telemetry);
  const replay = telemetry?.sim_mode === 'mission_replay';
  const summary = telemetry?.flight_summary ?? null;
  const complete = Boolean(summary?.complete);
  const issues = summary?.issues ?? [];
  const startScore = isNum(summary?.health?.start) ? summary.health.start * 100 : score;

  // SVG Circular Gauge Arc Math
  const radius = 100;
  const strokeWidth = 10;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - ((score ?? 0) / 100) * circumference;
  const gaugeColor = score === null ? '#475569' : score < 80 ? '#ef4444' : score < 95 ? '#f59e0b' : '#10b981';

  let anomalyText = 'AWAITING TELEMETRY';
  if (diag) {
    anomalyText = hasAnomaly ? `ANOMALY DETECTED: ${humanize(diag.fault_type)}` : 'NO ACTIVE ANOMALY';
    if (injected.length > 0) {
      anomalyText += ` · INJECTED: ${injected.map((f) => `${humanize(f.kind)} (${Math.round((f.progress ?? 0) * 100)}%)`).join(', ')}`;
    }
  }

  const footnotes = [];
  if (summary?.transient_alerts > 0) {
    const n = summary.transient_alerts;
    footnotes.push(`${n} brief alert${n > 1 ? 's' : ''} shorter than ${formatDuration(summary.issue_min_s).toLowerCase()} not counted as ${n > 1 ? 'issues' : 'an issue'}.`);
  }
  if (replay && summary?.recorded_label) {
    const rec = summary.recorded_label;
    footnotes.push(rec.label
      ? `Recorded dataset label: ${rec.label} from min ${rec.onset_min}.`
      : `Recorded dataset label: no fault${complete ? '' : ' so far'}.`);
  }

  const handleDownload = async () => {
    setExporting(true);
    setExportError(null);
    const now = new Date();
    const stamp = now.toISOString().replace('T', ' ').slice(0, 19);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
      flushSync(() => setSnapshotStamp(stamp));
      const canvas = await html2canvas(pageRef.current, { backgroundColor: EXPORT_BG, scale: 2, logging: false });

      // Page sized to the captured summary (in CSS px) plus a dark margin.
      const w = canvas.width / 2 + EXPORT_MARGIN_PX * 2;
      const h = canvas.height / 2 + EXPORT_MARGIN_PX * 2;
      const pdf = new jsPDF({ orientation: w > h ? 'landscape' : 'portrait', unit: 'px', format: [w, h], hotfixes: ['px_scaling'], compress: true });
      pdf.setFillColor(EXPORT_BG);
      pdf.rect(0, 0, w, h, 'F');
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', EXPORT_MARGIN_PX, EXPORT_MARGIN_PX, w - EXPORT_MARGIN_PX * 2, h - EXPORT_MARGIN_PX * 2);
      pdf.save(`health-summary_${source.slug}_${stamp.replace(/[: ]/g, '-')}.pdf`);
    } catch (err) {
      console.error('[ScreenHealthSummary] PDF export failed:', err);
      setExportError('Download failed — see the browser console for details, then try again.');
    } finally {
      setSnapshotStamp(null);
      setExporting(false);
    }
  };

  return (
    <div className="s5-container" ref={pageRef}>
      <div className="s5-toolbar">
        {/* Identifies the flight in the exported PDF only; the download button is left out of the capture. */}
        <span className="s5-export-stamp">
          {snapshotStamp && <><strong>{source.text}</strong> · EXPORTED <strong>{snapshotStamp} UTC</strong></>}
        </span>
        <div className="s5-download" data-html2canvas-ignore="true">
          {exportError && <span className="s5-download-error">{exportError}</span>}
          <button type="button" className="s5-download-btn" onClick={handleDownload} disabled={exporting}>
            {exporting ? 'Preparing PDF…' : 'Download PDF'}
          </button>
        </div>
      </div>

      <div className="uav-section-eyebrow">
        PREDICTIVE MAINTENANCE SUITE // DIGITAL TWIN VS SENSOR FEED DOWNLINK
      </div>
      <h1 className="uav-screen-title uav-screen-title-plain">
        OVERALL HEALTH SUMMARY
      </h1>
      <div className="uav-section-subtitle s5-subtitle">
        DIGITAL TWIN CONVERGENCE & SYSTEM INTEGRITY
      </div>

      {/* Centerpiece Circular Health Gauge */}
      <div className="s5-gauge-wrapper">
        <svg width="240" height="240" viewBox="0 0 240 240">
          {/* Rotation is an SVG attribute (not CSS) so the PDF capture renders the arc starting at 12 o'clock. */}
          <g transform="rotate(-90 120 120)">
          <circle
            cx="120"
            cy="120"
            r={radius}
            fill="none"
            stroke="rgba(255, 255, 255, 0.12)"
            strokeWidth={strokeWidth}
            strokeDasharray="4,4"
          />
          <circle
            cx="120"
            cy="120"
            r={radius}
            fill="none"
            stroke={gaugeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 8px ${gaugeColor})`, transition: 'stroke-dashoffset 0.8s ease' }}
          />
          </g>
        </svg>

        <div className="s5-gauge-center">
          <div className="s5-gauge-percent">
            {score === null ? '---' : score.toFixed(1)}<span className="s5-gauge-percent-unit">%</span>
          </div>
          <div className="s5-gauge-caption">
            ENGINE HEALTH SCORE<br />(RUL PROXY)
          </div>
        </div>
      </div>

      {/* Active Anomaly Pill */}
      <div className={`s5-anomaly-pill ${hasAnomaly ? '' : 's5-anomaly-pill-ok'}`}>
        <span className={hasAnomaly ? 'uav-dot-orange' : 'uav-dot-green'} />
        <span>{anomalyText}</span>
      </div>

      {/* Health over this flight */}
      <div className="s5-three-col-stats">
        <div className="s5-stat-block">
          <span className="s5-stat-lbl">HEALTH AT FLIGHT START</span>
          <span className="s5-stat-val">{pct(isNum(startScore) ? startScore / 100 : null)}</span>
        </div>
        <div className="s5-stat-block">
          <span className="s5-stat-lbl">{complete ? (replay ? 'HEALTH AT LANDING' : 'HEALTH AT END') : 'HEALTH NOW'}</span>
          <span className={`s5-stat-val ${score !== null && score < 95 ? 'orange' : 'green'}`}>{pct(health)}</span>
        </div>
        <div className="s5-stat-block">
          <span className="s5-stat-lbl">CHANGE THIS FLIGHT</span>
          <span className="s5-stat-val">{score === null || !isNum(startScore) ? '---' : `${(score - startScore).toFixed(1)}%`}</span>
        </div>
      </div>

      {/* Whole-flight parameter averages */}
      <section className="s5-section">
        <div className="s5-section-head">
          <h2 className="s5-section-title">WHOLE-FLIGHT AVERAGES</h2>
          <span className="s5-section-note">{coverageNote(summary, replay)}</span>
        </div>
        <div className="s5-flight-grid">
          {FLIGHT_PARAMS.map((p) => {
            const st = summary?.stats?.[p.key];
            const show = (v) => (p.digits === 0 ? fmtInt(v) : fmt(v, p.digits));
            return (
              <div key={p.key} className="s5-flight-stat">
                <span className="s5-flight-lbl">
                  AVG {p.label}
                  {p.note && <span className="s5-flight-lbl-note"> · {p.note}</span>}
                </span>
                <span className="s5-flight-val">
                  {show(st?.avg)} <span className="s5-flight-unit">{p.unit}</span>
                </span>
                <span className="s5-flight-range">MIN {show(st?.min)} · MAX {show(st?.max)}</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Issues the diagnosis raised during the flight */}
      <section className="s5-section">
        <div className="s5-section-head">
          <h2 className="s5-section-title">ISSUES DURING FLIGHT</h2>
          <span className="s5-section-note">
            {summary ? (issues.length ? `${issues.length} ISSUE${issues.length > 1 ? 'S' : ''}` : 'NONE') : '---'}
          </span>
        </div>
        {issues.length > 0 ? (
          <ul className="s5-issue-list">
            {issues.map((issue) => (
              <IssueRow key={`${issue.fault_type}-${issue.first_t_s}`} issue={issue} replay={replay} complete={complete} />
            ))}
          </ul>
        ) : (
          <div className={`s5-issues-empty ${summary ? '' : 's5-issues-nodata'}`}>
            {summary ? (
              <><span className="uav-dot-green" /> No issues detected {complete ? 'during this flight' : 'so far'}.</>
            ) : 'Awaiting telemetry.'}
          </div>
        )}
        {footnotes.map((note) => (
          <p key={note} className="s5-footnote">{note}</p>
        ))}
      </section>
    </div>
  );
}
