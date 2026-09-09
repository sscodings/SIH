import React, { useRef, useEffect } from 'react';

function LightLineChart({ yMin, yMax, seriesA, seriesB }) {
  const xLabels = ["T+0", "T+2", "T+4", "T+6", "T+8", "T+10"];
  const ySteps = 5;
  const yValues = [];
  const stepVal = (yMax - yMin) / ySteps;
  for (let i = 0; i <= ySteps; i++) {
    yValues.push(Math.round(yMin + i * stepVal));
  }

  const svgWidth = 480;
  const svgHeight = 220;
  const padLeft = 42;
  const padRight = 24;
  const padTop = 20;
  const padBottom = 30;

  const chartW = svgWidth - padLeft - padRight;
  const chartH = svgHeight - padTop - padBottom;

  const getX = (idx) => padLeft + (idx / (seriesA.length - 1)) * chartW;
  const getY = (val) => padTop + chartH - ((val - yMin) / (yMax - yMin)) * chartH;

  const pathA = seriesA.map((val, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(val)}`).join(' ');
  const pathB = seriesB.map((val, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(val)}`).join(' ');

  return (
    <svg width="100%" height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
      {/* Light Grid Background */}
      <rect x={padLeft} y={padTop} width={chartW} height={chartH} fill="#ffffff" stroke="#cbd5e1" strokeWidth="1" />

      {/* Horizontal Gridlines & Y-Axis Labels */}
      {yValues.map((val, idx) => {
        const y = getY(val);
        return (
          <g key={idx}>
            <line x1={padLeft} y1={y} x2={padLeft + chartW} y2={y} stroke="#f1f5f9" strokeWidth="1" />
            <text x={padLeft - 8} y={y + 3.5} fill="#64748b" fontSize="9.5" fontWeight="600" textAnchor="end" fontFamily="var(--font-mono)">
              {val}
            </text>
          </g>
        );
      })}

      {/* Vertical Gridlines & X-Axis Labels */}
      {xLabels.map((lbl, idx) => {
        const x = getX(idx);
        return (
          <g key={idx}>
            <line x1={x} y1={padTop} x2={x} y2={padTop + chartH} stroke="#f1f5f9" strokeWidth="1" />
            <text x={x} y={svgHeight - 10} fill="#64748b" fontSize="9.5" fontWeight="600" textAnchor="middle" fontFamily="var(--font-mono)">
              {lbl}
            </text>
          </g>
        );
      })}

      {/* Series A (Blue Line & Filled Dots) */}
      <path d={pathA} fill="none" stroke="#2563eb" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      {seriesA.map((val, i) => (
        <circle key={`a-${i}`} cx={getX(i)} cy={getY(val)} r="3.5" fill="#2563eb" stroke="#ffffff" strokeWidth="1" />
      ))}

      {/* Series B (Orange Line & Open Dots) */}
      <path d={pathB} fill="none" stroke="#ea580c" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      {seriesB.map((val, i) => (
        <circle key={`b-${i}`} cx={getX(i)} cy={getY(val)} r="3.5" fill="#ffffff" stroke="#ea580c" strokeWidth="2" />
      ))}
    </svg>
  );
}

function AtmosphericStressHeatmap({ heatmapData }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // Build isobaric multi-zone thermal stress gradient
    // Base green background
    ctx.fillStyle = "#10b981";
    ctx.fillRect(0, 0, w, h);

    // Deep blue bottom-left cold boundary
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

    // High temperature thermal hotspot at (w*0.35, h*0.5)
    const hotGrad = ctx.createRadialGradient(w * 0.32, h * 0.48, 12, w * 0.32, h * 0.48, w * 0.48);
    hotGrad.addColorStop(0, '#ef4444');
    hotGrad.addColorStop(0.35, '#f97316');
    hotGrad.addColorStop(0.65, '#eab308');
    hotGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = hotGrad;
    ctx.fillRect(0, 0, w, h);

    // Secondary warm diffuse zone top
    const topWarm = ctx.createRadialGradient(w * 0.65, h * 0.35, 10, w * 0.65, h * 0.35, w * 0.38);
    topWarm.addColorStop(0, '#f59e0b');
    topWarm.addColorStop(0.5, '#84cc16');
    topWarm.addColorStop(1, 'transparent');
    ctx.fillStyle = topWarm;
    ctx.fillRect(0, 0, w, h);

    // Right-side rainbow color scale bar
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
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, 10, barW, h - 20);

  }, []);

  return (
    <div className="s3-heatmap-container">
      <div className="s3-heatmap-title">{heatmapData.title}</div>
      <div className="s3-heatmap-canvas-wrapper">
        <canvas
          ref={canvasRef}
          width={540}
          height={200}
          style={{ width: '100%', height: '200px', display: 'block' }}
        />

        {/* Axis Labels */}
        <span style={{ position: 'absolute', top: 6, left: 8, fontSize: '9px', fontWeight: 700, color: '#ffffff', fontFamily: 'var(--font-mono)' }}>
          LT (K)
        </span>
        <span style={{ position: 'absolute', bottom: 4, left: 8, fontSize: '9px', color: '#ffffff', fontFamily: 'var(--font-mono)' }}>
          0.0
        </span>
        <span style={{ position: 'absolute', bottom: 4, right: 32, fontSize: '9px', fontWeight: 700, color: '#ffffff', fontFamily: 'var(--font-mono)' }}>
          Pressure (mm/Hg)
        </span>

        {/* Hotspot Probe Dot & Callout Tooltip */}
        <div className="s3-heatmap-dot" style={{ top: '48%', left: '38%' }} />
        <div className="s3-heatmap-tooltip" style={{ top: '30%', left: '42%' }}>
          <div>{heatmapData.tooltip.zone}</div>
          <div>{heatmapData.tooltip.stress}</div>
          <div>{heatmapData.tooltip.probe}</div>
        </div>
      </div>
    </div>
  );
}

export function ScreenLiveStatsAndGraph({ telemetry }) {
  const s3 = telemetry.s3 || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
      {/* Centered Large Section Title */}
      <h1 className="uav-screen-title">LIVE STATS AND GRAPH</h1>

      {/* 2x2 Grid */}
      <div className="s3-grid">
        {/* Card 1: Parameter 1 / CHT */}
        <div className="s3-card">
          <div className="s3-chart-box">
            <LightLineChart
              yMin={20}
              yMax={100}
              seriesA={[42, 70, 43, 74, 70, 92]}
              seriesB={[67, 63, 73, 68, 80, 76]}
            />
          </div>
          <div className="s3-card-subinfo">
            <div className="s3-param-heading">PARAMETER 1</div>
            <div className="s3-param-subheading">CHT</div>
            <div className="s3-kv-list">
              {s3.param1?.items?.map((it, idx) => (
                <div key={idx} className="s3-kv-row">
                  <span className="s3-kv-key">{it.label} :</span>
                  <span className="s3-kv-val">{it.val}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Card 2: Parameter 2 / EGT */}
        <div className="s3-card">
          <div className="s3-chart-box">
            <LightLineChart
              yMin={30}
              yMax={110}
              seriesA={[66, 56, 77, 60, 82, 95]}
              seriesB={[48, 65, 58, 79, 68, 84]}
            />
          </div>
          <div className="s3-card-subinfo">
            <div className="s3-param-heading">PARAMETER 2</div>
            <div className="s3-param-subheading">EGT</div>
            <div className="s3-kv-list">
              {s3.param2?.items?.map((it, idx) => (
                <div key={idx} className="s3-kv-row">
                  <span className="s3-kv-key">{it.label} :</span>
                  <span className="s3-kv-val">{it.val}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Card 3: Parameter 3 / RPM */}
        <div className="s3-card">
          <div className="s3-chart-box">
            <LightLineChart
              yMin={10}
              yMax={100}
              seriesA={[28, 58, 48, 86, 74, 80]}
              seriesB={[47, 40, 63, 59, 76, 83]}
            />
          </div>
          <div className="s3-card-subinfo">
            <div className="s3-param-heading">PARAMETER 3</div>
            <div className="s3-param-subheading">RPM</div>
            <div className="s3-kv-list">
              {s3.param3?.items?.map((it, idx) => (
                <div key={idx} className="s3-kv-row">
                  <span className="s3-kv-key">{it.label} :</span>
                  <span className="s3-kv-val">{it.val}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Card 4: Atmospheric & Thermal Stress Heat Map */}
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
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
