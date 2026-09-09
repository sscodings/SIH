import React, { useState, useEffect, useRef } from 'react';

export function ScreenLiveStats({ telemetry }) {
  const [hexRows, setHexRows] = useState(telemetry.s2?.hexStream || []);
  const [totalFrames, setTotalFrames] = useState(telemetry.s2?.totalFrames || 1042910);
  const canvasRef = useRef(null);
  const animFrameRef = useRef(null);
  const timeOffsetRef = useRef(0);

  // Animate Hex Stream ticking
  useEffect(() => {
    const hexInterval = setInterval(() => {
      setTotalFrames(prev => prev + 5);
      const hexChars = "0123456789ABCDEF";
      const randomHexByte = () => hexChars[Math.floor(Math.random() * 16)] + hexChars[Math.floor(Math.random() * 16)];
      setHexRows(prev => prev.map(r => ({
        ...r,
        bytes: `${randomHexByte()} ${randomHexByte()} ${randomHexByte()} ${randomHexByte()} ${randomHexByte()} ${randomHexByte()}`
      })));
    }, 600);
    return () => clearInterval(hexInterval);
  }, []);

  // Animate Live Vibration Waveform on High-Contrast White Background Chart
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const render = () => {
      timeOffsetRef.current += 0.04;
      const t = timeOffsetRef.current;
      const w = canvas.width;
      const h = canvas.height;

      ctx.clearRect(0, 0, w, h);

      // Light background
      ctx.fillStyle = "#e2e8f0";
      ctx.fillRect(0, 0, w, h);

      // Light gridlines
      ctx.strokeStyle = "rgba(100, 116, 139, 0.25)";
      ctx.lineWidth = 1;
      const gridStepX = 30;
      const gridStepY = 22;

      for (let x = 0; x < w; x += gridStepX) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += gridStepY) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Red Flat Line: CHT_CORE_AVG (~68% height)
      const chtY = h * 0.72;
      ctx.strokeStyle = "#dc2626";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(0, chtY);
      ctx.lineTo(w, chtY);
      ctx.stroke();

      // Black Jagged Oscillating Waveform: VIB_CH1 (ACCEL)
      ctx.strokeStyle = "#09090b";
      ctx.lineWidth = 2.4;
      ctx.beginPath();

      const points = [];
      const numPoints = 120;
      for (let i = 0; i < numPoints; i++) {
        const x = (i / (numPoints - 1)) * w;
        const normX = i * 0.15;
        // Superposition of harmonic sines simulating engine vibration order
        const wave = 
          Math.sin(normX - t * 2.5) * 0.45 +
          Math.sin(normX * 2.1 - t * 3.8) * 0.35 +
          Math.sin(normX * 0.5 - t * 1.2) * 0.2;
        
        const y = h * 0.55 + wave * (h * 0.38);
        points.push({ x, y });
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      animFrameRef.current = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  const s2Data = telemetry.s2 || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
      {/* Centered Large Section Title */}
      <h1 className="uav-screen-title">LIVE STATS</h1>

      {/* Upper Half: 2D Flat Engine Diagram & Engine Telemetry List */}
      <div className="s2-top-grid">
        {/* Left: Engine Flat Illustration */}
        <div className="s2-engine-icon-container">
          <svg width="340" height="260" viewBox="0 0 380 300" preserveAspectRatio="xMidYMid meet">
            {/* Background alignment grid */}
            <line x1="190" y1="0" x2="190" y2="300" stroke="rgba(255,255,255,0.06)" strokeDasharray="3,3" />
            <line x1="0" y1="150" x2="380" y2="150" stroke="rgba(255,255,255,0.06)" strokeDasharray="3,3" />

            {/* Cyan Dashed Connection Arcs from Turbocharger to Cylinder Banks */}
            <path
              d="M 190,65 C 130,65 95,100 85,130"
              fill="none"
              stroke="#22d3ee"
              strokeWidth="2.5"
              strokeDasharray="5,4"
            />
            <path
              d="M 190,65 C 250,65 285,100 295,130"
              fill="none"
              stroke="#22d3ee"
              strokeWidth="2.5"
              strokeDasharray="5,4"
            />

            {/* Top Turbocharger Disc Housing */}
            <g transform="translate(190, 55)">
              <circle cx="0" cy="0" r="22" fill="#475569" stroke="#94a3b8" strokeWidth="2" />
              <circle cx="0" cy="0" r="14" fill="#1e293b" stroke="#cbd5e1" strokeWidth="1.5" />
              <line x1="-10" y1="-10" x2="10" y2="10" stroke="#f8fafc" strokeWidth="2" />
              <line x1="-10" y1="10" x2="10" y2="-10" stroke="#f8fafc" strokeWidth="2" />
              <circle cx="0" cy="0" r="4" fill="#22d3ee" />
            </g>

            {/* Central Engine Body / Crankcase Block */}
            <g transform="translate(140, 95)">
              {/* Outer Housing Frame */}
              <rect x="0" y="0" width="100" height="110" rx="16" fill="#334155" stroke="#94a3b8" strokeWidth="2" />
              {/* Dark Inner Core */}
              <rect x="8" y="8" width="84" height="94" rx="10" fill="#0f172a" stroke="#475569" strokeWidth="1" />
            </g>

            {/* Lower Accessory Hub */}
            <g transform="translate(170, 215)">
              <rect x="0" y="0" width="40" height="35" rx="8" fill="#475569" stroke="#94a3b8" strokeWidth="1.5" />
              <circle cx="20" cy="18" r="8" fill="#0f172a" stroke="#cbd5e1" strokeWidth="1.5" />
              <circle cx="20" cy="18" r="3" fill="#ffffff" />
            </g>

            {/* Left Red Cylinder Banks (Cylinders 1 & 3) */}
            <g transform="translate(65, 115)">
              {/* Top Left Cylinder #1 */}
              <rect x="0" y="0" width="65" height="30" rx="4" fill="#991b1b" stroke="#ef4444" strokeWidth="2" />
              <rect x="5" y="5" width="55" height="6" rx="2" fill="#ef4444" />
              <rect x="5" y="15" width="55" height="6" rx="2" fill="#ef4444" />

              {/* Bottom Left Cylinder #3 */}
              <rect x="5" y="42" width="60" height="26" rx="4" fill="#991b1b" stroke="#ef4444" strokeWidth="2" />
              <rect x="10" y="47" width="50" height="5" rx="2" fill="#ef4444" />
              <rect x="10" y="56" width="50" height="5" rx="2" fill="#ef4444" />
            </g>

            {/* Right Red Cylinder Banks (Cylinders 2 & 4) */}
            <g transform="translate(250, 115)">
              {/* Top Right Cylinder #2 */}
              <rect x="0" y="0" width="65" height="30" rx="4" fill="#991b1b" stroke="#ef4444" strokeWidth="2" />
              <rect x="5" y="5" width="55" height="6" rx="2" fill="#ef4444" />
              <rect x="5" y="15" width="55" height="6" rx="2" fill="#ef4444" />

              {/* Bottom Right Cylinder #4 */}
              <rect x="0" y="42" width="60" height="26" rx="4" fill="#991b1b" stroke="#ef4444" strokeWidth="2" />
              <rect x="5" y="47" width="50" height="5" rx="2" fill="#ef4444" />
              <rect x="5" y="56" width="50" height="5" rx="2" fill="#ef4444" />
            </g>

            {/* Leader Line Labels */}
            {/* Turbo Charger Label */}
            <line x1="210" y1="50" x2="270" y2="40" stroke="#94a3b8" strokeWidth="1" />
            <circle cx="210" cy="50" r="2" fill="#ffffff" />
            <text x="275" y="43" fill="#cbd5e1" fontSize="9" fontWeight="700" fontFamily="var(--font-mono)">
              TURBO CHARGER
            </text>

            {/* Cyl_Head #1 Label */}
            <line x1="95" y1="125" x2="40" y2="85" stroke="#94a3b8" strokeWidth="1" />
            <circle cx="95" cy="125" r="3.5" fill="#ffffff" stroke="#22d3ee" strokeWidth="1.5" />
            <text x="35" y="80" fill="#cbd5e1" fontSize="9" fontWeight="700" fontFamily="var(--font-mono)">
              CYL_HEAD #1
            </text>
          </svg>
        </div>

        {/* Right: Engine Telemetry Table */}
        <div className="s2-telemetry-panel">
          <div className="s2-panel-header">
            <span style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-secondary)' }}>
              ENGINE TELEMETRY
            </span>
            <span className="uav-badge uav-badge-green">STREAM ACTIVE</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <div className="s2-table-row">
              <span className="s2-table-label">RPM:</span>
              <span className="s2-table-val">{s2Data.rpm?.toLocaleString() || '2,485'} RPM</span>
            </div>
            <div className="s2-table-row">
              <span className="s2-table-label">CHT:</span>
              <span className="s2-table-val" style={{ color: 'var(--status-green)' }}>{s2Data.cht || 178.5} °C</span>
            </div>
            <div className="s2-table-row">
              <span className="s2-table-label">EGT:</span>
              <span className="s2-table-val" style={{ color: 'var(--status-orange)' }}>{s2Data.egt || 641.8} °C</span>
            </div>
            <div className="s2-table-row">
              <span className="s2-table-label">OIL PRESS:</span>
              <span className="s2-table-val">{s2Data.oilPress || 4.2} BAR</span>
            </div>
            <div className="s2-table-row">
              <span className="s2-table-label">OIL TEMP:</span>
              <span className="s2-table-val">{s2Data.oilTemp || 85.8} °C</span>
            </div>
            <div className="s2-table-row">
              <span className="s2-table-label">FUEL FLOW:</span>
              <span className="s2-table-val" style={{ color: 'var(--accent-cyan)' }}>{s2Data.fuelFlow || 18.4} L/H</span>
            </div>
            <div className="s2-table-row">
              <span className="s2-table-label">VIB (RMS):</span>
              <span className="s2-table-val">{s2Data.vibRms || 0.32} g</span>
            </div>
            <div className="s2-table-row">
              <span className="s2-table-label">BUS VOLTS:</span>
              <span className="s2-table-val">{s2Data.busVolts || 28.2} V</span>
            </div>
            <div className="s2-table-row">
              <span className="s2-table-label">MAP:</span>
              <span className="s2-table-val">{s2Data.map || 34.2} inHg</span>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-muted)', marginTop: '14px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <span>SAMPLE RATE: {s2Data.sampleRateHz || 100} Hz</span>
            <span>PKT LOSS: {s2Data.pktLossPct || '0.00%'}</span>
          </div>
        </div>
      </div>

      {/* Lower Half: LIVE DATA Header, Light Inverted Waveform Chart, and Hex Stream Table */}
      <h2 className="uav-screen-title" style={{ fontSize: '26px', marginTop: '16px' }}>LIVE DATA</h2>

      <div className="s2-live-data-panel">
        <div className="s2-live-data-header">
          <div style={{ display: 'flex', gap: '20px' }}>
            <span>CHANNEL: <strong>BUS_RX_01</strong></span>
            <span>BAUD: <strong>115200</strong></span>
            <span>PROTOCOL: <strong>ARINC 429</strong></span>
          </div>
          <span className="uav-badge uav-badge-green">
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: 'var(--status-green)' }} />
            STREAMING SYNCED
          </span>
        </div>

        <div className="s2-data-split">
          {/* Light-Background Line Chart Card */}
          <div className="light-chart-card">
            <canvas
              ref={canvasRef}
              width={640}
              height={180}
              style={{ width: '100%', height: '180px', display: 'block', borderRadius: '2px' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
              <div className="light-chart-legend">
                <span><strong style={{ color: '#09090b' }}>—</strong> VIB_CH1 (ACCEL)</span>
                <span><strong style={{ color: '#dc2626' }}>—</strong> CHT_CORE_AVG</span>
              </div>
              <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 600 }}>
                TIME WINDOW: 5.00s
              </div>
            </div>
          </div>

          {/* Hex Stream Data Table */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', paddingLeft: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px', color: 'var(--text-secondary)', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <span>HEX STREAM</span>
              <span>PARITY: OK</span>
            </div>

            <div className="s2-hex-table">
              {hexRows.map((row, idx) => (
                <div key={idx} className="s2-hex-row">
                  <span className="s2-hex-addr">{row.addr}</span>
                  <span className="s2-hex-bytes">{row.bytes}</span>
                  <span className="s2-hex-status">{row.status}</span>
                </div>
              ))}
            </div>

            <div style={{ fontSize: '10px', color: 'var(--text-muted)', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              TOTAL FRAMES: <strong style={{ color: '#ffffff' }}>{totalFrames.toLocaleString()}</strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
