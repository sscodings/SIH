import React, { useRef, useEffect } from 'react';
import { useTelemetryHistory } from '../hooks/useTelemetryHistory';

/**
 * Maps detected fault categories from SIH-main PhysicsRuleEngine to their corresponding physical engine parameters.
 */
const FAULT_PARAM_MAP = {
  misfire: ['egt', 'rpm', 'vibrationRmsG'],
  injector_abnormal: ['fuelFlowLh', 'egt'],
  injector_abnormalities: ['fuelFlowLh', 'egt'],
  cooling_degradation: ['cht', 'oilTempC'],
  lubrication_issue: ['oilPressureBar', 'oilTempC'],
  lubrication_issues: ['oilPressureBar', 'oilTempC'],
  sensor_drift: ['cht', 'egt'],
  combustion_instability: ['rpm', 'vibrationRmsG'],
  overheating_trend: ['cht', 'oilTempC'],
  overheating_trends: ['cht', 'oilTempC'],
  abnormal_vibration: ['vibrationRmsG'],
};

/**
 * Raw-SVG dual-line chart:
 * - seriesA: IDEAL / nominal baseline (flat reference line)
 * - seriesB: ACTUAL / live rolling buffer (diverges visibly on fault detection)
 * Auto-scales yMin and yMax from combined data with ~15% padding so the spike is prominently visible.
 */
function LightLineChart({
  seriesA = [],
  seriesB = [],
  xLabels = ['T-30s', 'T-24s', 'T-18s', 'T-12s', 'T-6s', 'T-0s'],
  isParamFaulted = false,
  paramUnit = '',
  decimals = 0,
}) {
  // Auto-scale yMin and yMax with ~15% padding so spikes or drops are clearly accentuated
  const allVals = [...seriesA, ...seriesB].filter((v) => typeof v === 'number' && !isNaN(v));
  let minVal = allVals.length > 0 ? Math.min(...allVals) : 0;
  let maxVal = allVals.length > 0 ? Math.max(...allVals) : 100;

  if (minVal === maxVal) {
    minVal = minVal * 0.85 - 1;
    maxVal = maxVal * 1.15 + 1;
  }

  const span = maxVal - minVal;
  const pad = Math.max(span * 0.15, Math.abs(maxVal) * 0.05);
  const yMin = Math.max(0, minVal - pad);
  const yMax = maxVal + pad;

  const ySteps = 5;
  const yValues = [];
  const stepVal = (yMax - yMin) / ySteps;
  for (let i = 0; i <= ySteps; i++) {
    const val = yMin + i * stepVal;
    yValues.push(decimals > 0 ? val.toFixed(decimals) : Math.round(val));
  }

  const svgWidth = 480;
  const svgHeight = 200;
  const padLeft = 48;
  const padRight = 20;
  const padTop = 18;
  const padBottom = 26;

  const chartW = svgWidth - padLeft - padRight;
  const chartH = svgHeight - padTop - padBottom;

  const getX = (idx) => padLeft + (idx / Math.max(1, seriesA.length - 1)) * chartW;
  const getY = (val) => {
    if (yMax === yMin) return padTop + chartH / 2;
    const clamped = Math.max(yMin, Math.min(yMax, val));
    return padTop + chartH - ((clamped - yMin) / (yMax - yMin)) * chartH;
  };

  const pathA = seriesA.map((val, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(val)}`).join(' ');
  const pathB = seriesB.map((val, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(val)}`).join(' ');

  // Colors:
  // IDEAL = Clean Emerald / Slate dashed reference line
  const idealColor = '#059669';
  // ACTUAL = Normal Blue when nominal, Vivid Red only when fault is confirmed detected
  const actualColor = isParamFaulted ? '#ef4444' : '#2563eb';

  const currentIdeal = seriesA.length > 0 ? seriesA[seriesA.length - 1] : 0;
  const currentActual = seriesB.length > 0 ? seriesB[seriesB.length - 1] : 0;

  return (
    <div className="s3-chart-box">
      <svg
        width="100%"
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
      >
        {/* Light Grid Background */}
        <rect x={padLeft} y={padTop} width={chartW} height={chartH} fill="#ffffff" stroke="#cbd5e1" strokeWidth="1" />

        {/* Horizontal Gridlines & Y-Axis Labels */}
        {yValues.map((val, idx) => {
          const numVal = parseFloat(val);
          const y = getY(numVal);
          return (
            <g key={idx}>
              <line x1={padLeft} y1={y} x2={padLeft + chartW} y2={y} stroke="#f1f5f9" strokeWidth="1" />
              <text
                x={padLeft - 8}
                y={y + 3.5}
                fill="#64748b"
                fontSize="9"
                fontWeight="600"
                textAnchor="end"
                fontFamily="var(--font-mono)"
              >
                {val}
              </text>
            </g>
          );
        })}

        {/* Vertical Gridlines & X-Axis Labels */}
        {xLabels.map((lbl, idx) => {
          const x = padLeft + (idx / (xLabels.length - 1)) * chartW;
          return (
            <g key={idx}>
              <line x1={x} y1={padTop} x2={x} y2={padTop + chartH} stroke="#f1f5f9" strokeWidth="1" />
              <text
                x={x}
                y={svgHeight - 8}
                fill="#64748b"
                fontSize="9"
                fontWeight="600"
                textAnchor="middle"
                fontFamily="var(--font-mono)"
              >
                {lbl}
              </text>
            </g>
          );
        })}

        {/* Series A (IDEAL Baseline: Emerald Reference Line with Dashes) */}
        <path
          d={pathA}
          fill="none"
          stroke={idealColor}
          strokeWidth="2.0"
          strokeDasharray="4 3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Series B (ACTUAL Live: Blue nominal or Red when fault is actively detected) */}
        <path
          d={pathB}
          fill="none"
          stroke={actualColor}
          strokeWidth={isParamFaulted ? '2.8' : '2.2'}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Dots on actual series */}
        {seriesB.map((val, i) => {
          if (i % 5 === 0 || i === seriesB.length - 1) {
            return (
              <circle
                key={`b-${i}`}
                cx={getX(i)}
                cy={getY(val)}
                r={i === seriesB.length - 1 ? (isParamFaulted ? 5.0 : 4.0) : 3.0}
                fill={i === seriesB.length - 1 ? actualColor : '#ffffff'}
                stroke={actualColor}
                strokeWidth={i === seriesB.length - 1 ? 1.5 : 2}
              />
            );
          }
          return null;
        })}
      </svg>

      {/* Dual-Line Chart Legend */}
      <div className="s3-legend-row">
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          {/* Series A Legend */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span
              style={{
                display: 'inline-block',
                width: 14,
                height: 2.5,
                backgroundColor: idealColor,
                borderTop: '1px dashed #ffffff',
              }}
            />
            <span style={{ color: '#047857', fontWeight: 700 }}>
              IDEAL (BASELINE): {currentIdeal} {paramUnit}
            </span>
          </div>

          {/* Series B Legend */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span
              style={{
                display: 'inline-block',
                width: 14,
                height: 2.5,
                backgroundColor: actualColor,
              }}
            />
            <span style={{ color: isParamFaulted ? '#b91c1c' : '#1d4ed8', fontWeight: 800 }}>
              ACTUAL (LIVE): {currentActual} {paramUnit}
            </span>
          </div>
        </div>

        {/* Visual Fault Flag: only shown once fault is detected */}
        {isParamFaulted ? (
          <span className="s3-badge-fault">⚠ FAULT DETECTED</span>
        ) : (
          <span style={{ color: '#64748b', fontSize: '9px', fontWeight: 600 }}>TOLERANCE: NOMINAL</span>
        )}
      </div>
    </div>
  );
}

/**
 * Atmospheric & Thermal Stress Heat Map (Original Canvas Component)
 */
function AtmosphericStressHeatmap({ heatmapData }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // Base green background
    ctx.fillStyle = '#10b981';
    ctx.fillRect(0, 0, w, h);

    // Deep blue cold boundary
    const coldGrad = ctx.createRadialGradient(w * 0.15, h * 0.88, 10, w * 0.15, h * 0.88, w * 0.45);
    coldGrad.addColorStop(0, '#1d4ed8');
    coldGrad.addColorStop(0.5, '#0284c7');
    coldGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = coldGrad;
    ctx.fillRect(0, 0, w, h);

    // Blue bottom strip
    const bottomGrad = ctx.createLinearGradient(0, h * 0.7, 0, h);
    bottomGrad.addColorStop(0, 'transparent');
    bottomGrad.addColorStop(0.6, '#0284c7');
    bottomGrad.addColorStop(1, '#1e40af');
    ctx.fillStyle = bottomGrad;
    ctx.fillRect(0, 0, w, h);

    // Thermal hotspot at center-left
    const hotGrad = ctx.createRadialGradient(w * 0.32, h * 0.48, 12, w * 0.32, h * 0.48, w * 0.48);
    hotGrad.addColorStop(0, '#ef4444');
    hotGrad.addColorStop(0.35, '#f97316');
    hotGrad.addColorStop(0.65, '#eab308');
    hotGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = hotGrad;
    ctx.fillRect(0, 0, w, h);

    // Secondary warm diffuse zone
    const topWarm = ctx.createRadialGradient(w * 0.65, h * 0.35, 10, w * 0.65, h * 0.35, w * 0.38);
    topWarm.addColorStop(0, '#f59e0b');
    topWarm.addColorStop(0.5, '#84cc16');
    topWarm.addColorStop(1, 'transparent');
    ctx.fillStyle = topWarm;
    ctx.fillRect(0, 0, w, h);

    // Color scale bar on right edge
    const barW = 12;
    const barX = w - 18;
    const scaleGrad = ctx.createLinearGradient(0, 10, 0, h - 10);
    scaleGrad.addColorStop(0, '#b91c1c');
    scaleGrad.addColorStop(0.2, '#f97316');
    scaleGrad.addColorStop(0.4, '#eab308');
    scaleGrad.addColorStop(0.6, '#22c55e');
    scaleGrad.addColorStop(0.8, '#06b6d4');
    scaleGrad.addColorStop(1, '#1e3a8a');
    ctx.fillStyle = scaleGrad;
    ctx.fillRect(barX, 10, barW, h - 20);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, 10, barW, h - 20);
  }, []);

  return (
    <div className="s3-heatmap-container">
      <div className="s3-heatmap-title">{heatmapData.title || 'ATMOSPHERIC & THERMAL PROFILE'}</div>
      <div className="s3-heatmap-canvas-wrapper">
        <canvas
          ref={canvasRef}
          width={540}
          height={200}
          style={{ width: '100%', height: '200px', display: 'block' }}
        />

        {/* Axis Labels */}
        <span
          style={{
            position: 'absolute',
            top: 6,
            left: 8,
            fontSize: '9px',
            fontWeight: 700,
            color: '#ffffff',
            fontFamily: 'var(--font-mono)',
          }}
        >
          LT (K)
        </span>
        <span
          style={{
            position: 'absolute',
            bottom: 4,
            left: 8,
            fontSize: '9px',
            color: '#ffffff',
            fontFamily: 'var(--font-mono)',
          }}
        >
          0.0
        </span>
        <span
          style={{
            position: 'absolute',
            bottom: 4,
            right: 32,
            fontSize: '9px',
            fontWeight: 700,
            color: '#ffffff',
            fontFamily: 'var(--font-mono)',
          }}
        >
          Pressure (mm/Hg)
        </span>

        {/* Hotspot Probe Dot & Callout Tooltip */}
        <div className="s3-heatmap-dot" style={{ top: '48%', left: '38%' }} />
        <div className="s3-heatmap-tooltip" style={{ top: '30%', left: '42%' }}>
          <div>{heatmapData.tooltip?.zone || 'Zone 3 Thermal Concentrator'}</div>
          <div>{heatmapData.tooltip?.stress || 'Peak Stress: 88.4%'}</div>
          <div>{heatmapData.tooltip?.probe || 'Sensors: Ch 1-4 Active'}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * ScreenLiveStatsAndGraph
 * Full 8-card responsive monitoring grid with live dual-line charts for all 7 telemetry parameters
 * plus the atmospheric thermal stress heatmap.
 * Strictly adheres to the rule: "Till the time the fault is not detected, there is no fault indication on the graph.
 * Once detected on the main page, the affected parameter highlights with its real visible spike."
 */
export function ScreenLiveStatsAndGraph({ telemetry }) {
  const { params, xLabels } = useTelemetryHistory(telemetry);
  const s3 = telemetry?.s3 || {};

  // EXACT same detection condition as ScreenEngine3DSimulation (the main page)
  const activeFaults = Array.isArray(telemetry?.active_faults)
    ? telemetry.active_faults.filter((f) => f && f !== 'none')
    : [];
  const mlDiag = telemetry?.diagnostics?.ml_diagnostics || {};
  const isFaultDetected = activeFaults.length > 0 || Boolean(mlDiag.anomaly_detected);
  const detectedFault = (activeFaults[0] || mlDiag.fault_type || 'none').toLowerCase();

  // Determine which specific parameters are affected by the detected fault
  const affectedKeys = isFaultDetected
    ? FAULT_PARAM_MAP[detectedFault] || ['rpm', 'cht', 'egt', 'oilPressureBar', 'oilTempC', 'fuelFlowLh', 'vibrationRmsG']
    : [];

  // List of all 7 parameters with display configuration
  const paramOrder = [
    { key: 'rpm', num: 1, name: 'CRANKSHAFT VELOCITY', sub: 'RPM (REVOLUTIONS PER MINUTE)' },
    { key: 'cht', num: 2, name: 'CYLINDER HEAD TEMP', sub: 'CHT (PEAK CYLINDER)' },
    { key: 'egt', num: 3, name: 'EXHAUST GAS TEMP', sub: 'EGT (PEAK MANIFOLD)' },
    { key: 'oilPressureBar', num: 4, name: 'OIL PRESSURE', sub: 'MAIN GALLERY PRESSURE' },
    { key: 'oilTempC', num: 5, name: 'OIL TEMPERATURE', sub: 'SUMP LUBRICANT TEMPERATURE' },
    { key: 'fuelFlowLh', num: 6, name: 'FUEL FLOW RATE', sub: 'MASS FLOW CONSUMPTION' },
    { key: 'vibrationRmsG', num: 7, name: 'RADIAL VIBRATION', sub: 'VIBRATION SIGNATURE (RMS)' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', paddingBottom: '32px' }}>
      {/* Centered Tactical Title & Status Eyebrow */}
      <div style={{ textAlign: 'center', marginBottom: '18px' }}>
        <div className="uav-section-eyebrow">
          REAL-TIME DUAL-LINE TELEMETRY MONITOR // IDEAL BASELINE VS ACTUAL SENSOR STREAM
        </div>
        <h1 className="uav-screen-title" style={{ margin: '4px 0 6px' }}>
          LIVE STATS AND GRAPH
        </h1>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          30-SECOND ROLLING WINDOW (T-30s ➔ T-0s) • STREAM FREQUENCY: 1.0 HZ •{' '}
          <span style={{ color: isFaultDetected ? '#ef4444' : 'var(--status-green)', fontWeight: 700 }}>
            STATUS:{' '}
            {isFaultDetected
              ? `⚠ FAULT DETECTED: ${(detectedFault || 'ANOMALY').toUpperCase().replace('_', ' ')}`
              : 'ALL PARAMETERS NOMINAL'}
          </span>
        </div>
      </div>

      {/* Responsive Grid covering all 7 parameters + 1 heatmap */}
      <div className="s3-grid s3-grid-expanded">
        {paramOrder.map((item) => {
          const p = params[item.key] || {};
          const isThisParamFaulted = isFaultDetected && affectedKeys.includes(item.key);

          return (
            <div key={item.key} className="s3-card">
              <div className="s3-chart-wrapper">
                <LightLineChart
                  seriesA={p.idealSeries || []}
                  seriesB={p.actualSeries || []}
                  xLabels={xLabels}
                  isParamFaulted={isThisParamFaulted}
                  paramUnit={p.unit}
                  decimals={p.decimals}
                />
              </div>

              <div className="s3-card-subinfo">
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}>
                  <div className="s3-param-heading">PARAMETER {item.num}</div>
                  {isThisParamFaulted && <span className="s3-badge-fault">⚠ FAULT DETECTED</span>}
                </div>
                <div className="s3-param-subheading">{item.sub}</div>

                <div className="s3-kv-list">
                  <div className="s3-kv-row">
                    <span className="s3-kv-key">NOMINAL BASELINE :</span>
                    <span className="s3-kv-val" style={{ color: '#10b981' }}>
                      {p.nominalRange}
                    </span>
                  </div>
                  <div className="s3-kv-row">
                    <span className="s3-kv-key">LIVE VALUE (ACTUAL) :</span>
                    <span
                      className="s3-kv-val"
                      style={{
                        color: isThisParamFaulted ? '#ef4444' : '#ffffff',
                        fontWeight: 700,
                      }}
                    >
                      {p.currentValue} {p.unit}
                    </span>
                  </div>
                  <div className="s3-kv-row">
                    <span className="s3-kv-key">VARIANCE (Δ FROM IDEAL) :</span>
                    <span
                      className="s3-kv-val"
                      style={{
                        color:
                          p.deltaFromIdeal === 0
                            ? 'var(--text-muted)'
                            : isThisParamFaulted
                            ? '#f97316'
                            : 'var(--status-green)',
                      }}
                    >
                      {p.deltaFromIdeal > 0 ? `+${p.deltaFromIdeal}` : p.deltaFromIdeal} {p.unit}
                    </span>
                  </div>
                  <div className="s3-kv-row">
                    <span className="s3-kv-key">HEALTH STATUS :</span>
                    <span
                      className="s3-kv-val"
                      style={{
                        color: isThisParamFaulted ? '#ef4444' : 'var(--status-green)',
                        fontWeight: 700,
                      }}
                    >
                      {isThisParamFaulted ? 'FAULT DETECTED [OUT OF SPEC]' : 'NOMINAL [IN SPEC]'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Card 8: Atmospheric & Thermal Stress Heat Map */}
        <div className="s3-card">
          <AtmosphericStressHeatmap heatmapData={s3.heatmap || {}} />
          <div className="s3-card-subinfo">
            <div className="s3-param-heading">ATMOSPHERIC & THERMAL PROFILE</div>
            <div className="s3-param-subheading">CYLINDER STRESS MAP</div>
            <div className="s3-kv-list">
              {s3.heatmap?.specs?.map((it, idx) => (
                <div key={idx} className="s3-kv-row">
                  <span className="s3-kv-key">{it.label} :</span>
                  <span className="s3-kv-val" style={{ color: it.isGreen ? 'var(--status-green)' : '#ffffff' }}>
                    {it.val}
                  </span>
                </div>
              )) || (
                <>
                  <div className="s3-kv-row">
                    <span className="s3-kv-key">MODEL :</span>
                    <span className="s3-kv-val">Isobaric 2D Model</span>
                  </div>
                  <div className="s3-kv-row">
                    <span className="s3-kv-key">PEAK ZONE :</span>
                    <span className="s3-kv-val">Cyl #2 Upper Baffle</span>
                  </div>
                  <div className="s3-kv-row">
                    <span className="s3-kv-key">DELTA T :</span>
                    <span className="s3-kv-val">+14.2 K/s</span>
                  </div>
                  <div className="s3-kv-row">
                    <span className="s3-kv-key">STATUS :</span>
                    <span className="s3-kv-val" style={{ color: 'var(--status-green)' }}>
                      SURFACE WITHIN TOLERANCE
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
