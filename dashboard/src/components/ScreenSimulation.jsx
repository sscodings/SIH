import React from 'react';

export function ScreenSimulation({ telemetry, onOpenSimulation }) {
  return (
    <div className="hud-framed-container">
      {/* HUD 4 Corner Brackets */}
      <div className="hud-corner-tl" />
      <div className="hud-corner-tr" />
      <div className="hud-corner-bl" />
      <div className="hud-corner-br" />

      <div className="s1-grid">
        {/* Left Column: Technical Figures 1.0 & 2.1 */}
        <div className="s1-left-column">
          {/* FIG 1.0: Elevation Profile MQ-9 */}
          <div className="s1-blueprint-card">
            <div className="s1-figure-header">
              <span>FIG 1.0 // ELEVATION PROFILE [MQ-9 CLASS AIRFRAME] | SCALE 1:35</span>
              <span className="s1-figure-stn">STN: F18-W // AFT-PUSHER CONFIG</span>
            </div>

            <div style={{ position: 'relative', width: '100%', minHeight: '190px', background: '#0a0d13', borderRadius: '2px', overflow: 'hidden' }}>
              {/* Dotted Grid Background */}
              <svg width="100%" height="190" viewBox="0 0 800 220" preserveAspectRatio="xMidYMid meet" className="s1-svg-viewport">
                <defs>
                  <pattern id="dotGrid1" width="16" height="16" patternUnits="userSpaceOnUse">
                    <circle cx="2" cy="2" r="0.8" fill="rgba(255, 255, 255, 0.12)" />
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#dotGrid1)" />

                {/* UAV Silhouette & Airframe Structure */}
                <g transform="translate(40, 20)">
                  {/* Subtle Grid reference box */}
                  <rect x="0" y="10" width="720" height="170" fill="none" stroke="rgba(255, 255, 255, 0.08)" strokeDasharray="4,4" />

                  {/* Fuselage Profile */}
                  <path
                    d="M 50,110 C 50,75 100,65 240,65 L 560,75 C 600,78 630,90 635,110 C 630,130 590,135 550,135 L 200,135 C 100,135 50,130 50,110 Z"
                    fill="#626d7c"
                    stroke="#8a99ad"
                    strokeWidth="1.5"
                  />

                  {/* Nose Optronics Radome Chin */}
                  <path
                    d="M 80,120 C 80,140 110,140 125,125 Z"
                    fill="#3b4452"
                    stroke="#22d3ee"
                    strokeWidth="1.2"
                  />

                  {/* Optical Pod Lens */}
                  <circle cx="98" cy="128" r="8" fill="#141a24" stroke="#22d3ee" strokeWidth="1.5" />
                  <circle cx="98" cy="128" r="3" fill="#22d3ee" />

                  {/* Wing Root & Wing Planform */}
                  <polygon
                    points="240,65 310,25 350,25 285,65"
                    fill="#7d8a9e"
                    stroke="#a3b1c6"
                    strokeWidth="1.2"
                  />
                  <polygon
                    points="270,30 330,30 300,50 250,50"
                    fill="#525d6e"
                    opacity="0.8"
                  />

                  {/* V-Tail Stabilizers */}
                  <polygon
                    points="520,74 580,25 615,25 565,75"
                    fill="#7d8a9e"
                    stroke="#a3b1c6"
                    strokeWidth="1.2"
                  />
                  <polygon
                    points="540,135 585,170 605,170 565,135"
                    fill="#525d6e"
                    stroke="#8a99ad"
                    strokeWidth="1.2"
                  />

                  {/* Tail Number Callout */}
                  <text x="568" y="60" fill="#ffffff" fontSize="10" fontWeight="700" fontFamily="var(--font-mono)">F18</text>

                  {/* Pusher Propeller Hub & Blades */}
                  <rect x="635" y="98" width="8" height="24" rx="2" fill="#334155" stroke="#94a3b8" />
                  <ellipse cx="642" cy="110" rx="3" ry="55" fill="rgba(34, 211, 238, 0.2)" stroke="#22d3ee" strokeWidth="1" strokeDasharray="3,2" />
                  <line x1="640" y1="60" x2="640" y2="160" stroke="#f8fafc" strokeWidth="2.5" />

                  {/* Landing Gear Pods */}
                  <line x1="125" y1="135" x2="135" y2="168" stroke="#cbd5e1" strokeWidth="2" />
                  <circle cx="138" cy="172" r="7" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.5" />
                  <circle cx="138" cy="172" r="2" fill="#22d3ee" />

                  <line x1="320" y1="135" x2="310" y2="170" stroke="#cbd5e1" strokeWidth="2" />
                  <circle cx="306" cy="174" r="8" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.5" />
                  <circle cx="306" cy="174" r="2" fill="#22d3ee" />

                  {/* Leader Lines & Callouts */}
                  <line x1="98" y1="120" x2="98" y2="50" stroke="#22d3ee" strokeWidth="1" strokeDasharray="2,2" />
                  <line x1="98" y1="50" x2="180" y2="50" stroke="#22d3ee" strokeWidth="1" />
                  <circle cx="98" cy="120" r="2" fill="#22d3ee" />
                  <text x="100" y="44" fill="#22d3ee" fontSize="9.5" fontWeight="700" letterSpacing="0.08em" fontFamily="var(--font-mono)">
                    SAR / FLIR OPTRONICS
                  </text>

                  <line x1="600" y1="120" x2="600" y2="150" stroke="#22d3ee" strokeWidth="1" strokeDasharray="2,2" />
                  <line x1="600" y1="150" x2="550" y2="150" stroke="#22d3ee" strokeWidth="1" />
                  <circle cx="600" cy="120" r="2" fill="#22d3ee" />
                  <text x="550" y="144" fill="#22d3ee" fontSize="9.5" fontWeight="700" letterSpacing="0.08em" fontFamily="var(--font-mono)" textAnchor="end">
                    PROPULSION BAY
                  </text>
                </g>
              </svg>
            </div>
          </div>

          {/* FIG 2.1: Exploded Blueprint Assembly (Clickable to Launch 3D Simulation) */}
          <div
            className="s1-blueprint-card"
            style={{ cursor: 'pointer', position: 'relative' }}
            onClick={onOpenSimulation}
            title="Click to launch 3D Digital Twin Engine Simulation"
          >
            <div className="s1-figure-header">
              <span>FIG 2.1 // ROTAX 914 F EXPLODED BLUEPRINT ASSEMBLY | ISOMETRIC MECHANICAL POWERPLANT // 4-CYL TURBOCHARGED</span>
              <button
                type="button"
                className="uav-badge uav-badge-cyan"
                style={{ cursor: 'pointer', border: '1px solid var(--accent-cyan)' }}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSimulation();
                }}
              >
                ▶ LAUNCH 3D DIGITAL TWIN
              </button>
            </div>

            <div style={{ position: 'relative', width: '100%', minHeight: '230px', background: '#0a0d13', borderRadius: '2px', overflow: 'hidden' }}>
              <svg width="100%" height="230" viewBox="0 0 800 240" preserveAspectRatio="xMidYMid meet" className="s1-svg-viewport">
                <defs>
                  <pattern id="dotGrid2" width="16" height="16" patternUnits="userSpaceOnUse">
                    <circle cx="2" cy="2" r="0.8" fill="rgba(255, 255, 255, 0.08)" />
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#dotGrid2)" />

                {/* Framing Box */}
                <rect x="20" y="10" width="760" height="215" fill="none" stroke="rgba(34, 211, 238, 0.3)" strokeWidth="1" />

                <g transform="translate(30, 20)">
                  {/* Central Transmission Axis */}
                  <line x1="30" y1="105" x2="710" y2="105" stroke="#22d3ee" strokeWidth="1.2" strokeDasharray="4,3" opacity="0.8" />

                  {/* 1. Prop Flange / Drive */}
                  <g transform="translate(60, 55)">
                    <ellipse cx="45" cy="50" rx="32" ry="46" fill="rgba(15, 23, 42, 0.8)" stroke="#38bdf8" strokeWidth="1.5" />
                    <ellipse cx="45" cy="50" rx="22" ry="34" fill="none" stroke="rgba(255, 255, 255, 0.3)" strokeWidth="1" strokeDasharray="2,2" />
                    <circle cx="45" cy="50" r="10" fill="#0f172a" stroke="#22d3ee" strokeWidth="2" />
                    <circle cx="45" cy="50" r="4" fill="#22d3ee" />
                    <circle cx="45" cy="18" r="2.5" fill="#ffffff" />
                    <circle cx="45" cy="82" r="2.5" fill="#ffffff" />
                    <circle cx="22" cy="50" r="2.5" fill="#ffffff" />
                    <circle cx="68" cy="50" r="2.5" fill="#ffffff" />
                    <text x="45" y="122" fill="var(--text-secondary)" fontSize="9" fontWeight="700" textAnchor="middle" fontFamily="var(--font-mono)">
                      1. PROP FLANGE / DRIVE
                    </text>
                  </g>

                  {/* 2. Gearbox Reduction */}
                  <g transform="translate(180, 50)">
                    <polygon
                      points="20,15 65,10 75,90 25,95 10,60"
                      fill="#1e293b"
                      stroke="#94a3b8"
                      strokeWidth="1.5"
                    />
                    <ellipse cx="45" cy="55" rx="18" ry="24" fill="none" stroke="#22d3ee" strokeWidth="1.2" strokeDasharray="3,2" />
                    <circle cx="45" cy="55" r="7" fill="#0f172a" stroke="#94a3b8" />
                    <text x="45" y="127" fill="var(--text-secondary)" fontSize="9" fontWeight="700" textAnchor="middle" fontFamily="var(--font-mono)">
                      2. GEARBOX REDUCTION
                    </text>
                  </g>

                  {/* 3. Rotax 914 F Core */}
                  <g transform="translate(300, 45)">
                    <rect x="35" y="15" width="85" height="78" rx="4" fill="#1e293b" stroke="#ffffff" strokeWidth="1.8" />
                    <ellipse cx="77" cy="54" rx="24" ry="28" fill="none" stroke="#38bdf8" strokeWidth="1" />
                    <line x1="77" y1="20" x2="77" y2="88" stroke="rgba(255,255,255,0.2)" strokeDasharray="2,2" />

                    {/* Left Cylinder Bank 1 (Red Cooling Fins) */}
                    <g transform="translate(0, 18)">
                      <rect x="5" y="0" width="30" height="28" fill="#1e293b" stroke="#ef4444" strokeWidth="1.2" />
                      <line x1="5" y1="7" x2="35" y2="7" stroke="#ef4444" strokeWidth="1" />
                      <line x1="5" y1="14" x2="35" y2="14" stroke="#ef4444" strokeWidth="1" />
                      <line x1="5" y1="21" x2="35" y2="21" stroke="#ef4444" strokeWidth="1" />
                    </g>
                    <g transform="translate(0, 52)">
                      <rect x="5" y="0" width="30" height="28" fill="#1e293b" stroke="#ef4444" strokeWidth="1.2" />
                      <line x1="5" y1="7" x2="35" y2="7" stroke="#ef4444" strokeWidth="1" />
                      <line x1="5" y1="14" x2="35" y2="14" stroke="#ef4444" strokeWidth="1" />
                      <line x1="5" y1="21" x2="35" y2="21" stroke="#ef4444" strokeWidth="1" />
                    </g>

                    {/* Right Cylinder Bank 2 (Red Cooling Fins) */}
                    <g transform="translate(120, 18)">
                      <rect x="0" y="0" width="30" height="28" fill="#1e293b" stroke="#ef4444" strokeWidth="1.2" />
                      <line x1="0" y1="7" x2="30" y2="7" stroke="#ef4444" strokeWidth="1" />
                      <line x1="0" y1="14" x2="30" y2="14" stroke="#ef4444" strokeWidth="1" />
                      <line x1="0" y1="21" x2="30" y2="21" stroke="#ef4444" strokeWidth="1" />
                    </g>
                    <g transform="translate(120, 52)">
                      <rect x="0" y="0" width="30" height="28" fill="#1e293b" stroke="#ef4444" strokeWidth="1.2" />
                      <line x1="0" y1="7" x2="30" y2="7" stroke="#ef4444" strokeWidth="1" />
                      <line x1="0" y1="14" x2="30" y2="14" stroke="#ef4444" strokeWidth="1" />
                      <line x1="0" y1="21" x2="30" y2="21" stroke="#ef4444" strokeWidth="1" />
                    </g>

                    <text x="77" y="132" fill="#ffffff" fontSize="10" fontWeight="800" textAnchor="middle" letterSpacing="0.08em" fontFamily="var(--font-mono)">
                      ROTAX 914 F CORE
                    </text>
                  </g>

                  {/* 4. Turbocharger & Wastegate */}
                  <g transform="translate(500, 50)">
                    <ellipse cx="45" cy="55" rx="28" ry="32" fill="#1e293b" stroke="#f59e0b" strokeWidth="1.8" />
                    <circle cx="45" cy="55" r="14" fill="#0f172a" stroke="#22d3ee" strokeWidth="1.5" />
                    <path d="M 45,30 C 65,30 75,55 75,70 L 60,80" fill="none" stroke="#f59e0b" strokeWidth="1.5" />

                    <rect x="80" y="15" width="22" height="18" rx="2" fill="#0f172a" stroke="#38bdf8" strokeWidth="1.2" />
                    <line x1="65" y1="35" x2="80" y2="24" stroke="#38bdf8" strokeWidth="1" />

                    <text x="55" y="127" fill="var(--text-secondary)" fontSize="9" fontWeight="700" textAnchor="middle" fontFamily="var(--font-mono)">
                      4. TURBOCHARGER / WASTEGATE
                    </text>
                  </g>

                  {/* Blueprint Leader Lines */}
                  <line x1="315" y1="45" x2="280" y2="10" stroke="#22d3ee" strokeWidth="1" />
                  <line x1="280" y1="10" x2="160" y2="10" stroke="#22d3ee" strokeWidth="1" />
                  <circle cx="315" cy="45" r="2" fill="#22d3ee" />
                  <text x="160" y="6" fill="#22d3ee" fontSize="9" fontWeight="700" letterSpacing="0.06em" fontFamily="var(--font-mono)">
                    CYLINDER HEAD #1 (CHT)
                  </text>

                  <line x1="595" y1="70" x2="630" y2="25" stroke="#22d3ee" strokeWidth="1" />
                  <line x1="630" y1="25" x2="710" y2="25" stroke="#22d3ee" strokeWidth="1" />
                  <circle cx="595" cy="70" r="2" fill="#22d3ee" />
                  <text x="710" y="20" fill="#22d3ee" fontSize="9" fontWeight="700" letterSpacing="0.06em" fontFamily="var(--font-mono)" textAnchor="end">
                    BOOST REGULATOR
                  </text>

                  <line x1="410" y1="125" x2="450" y2="155" stroke="#22d3ee" strokeWidth="1" />
                  <line x1="450" y1="155" x2="520" y2="155" stroke="#22d3ee" strokeWidth="1" />
                  <circle cx="410" cy="125" r="2" fill="#22d3ee" />
                  <text x="520" y="152" fill="#22d3ee" fontSize="8.5" fontWeight="700" letterSpacing="0.06em" fontFamily="var(--font-mono)" textAnchor="end">
                    OIL SUMP / SENSOR V8
                  </text>
                </g>
              </svg>
            </div>
          </div>
        </div>

        {/* Right Column: Tactical Parameters Sidebar */}
        <div className="s1-parameters-panel">
          {/* Simulation Header Badge with interactive launch click */}
          <div className="s1-param-pill-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              type="button"
              className="uav-badge"
              style={{ background: '#ffffff', color: '#000000', borderRadius: '14px', padding: '4px 12px', fontWeight: 800, fontSize: '11px', cursor: 'pointer', border: 'none' }}
              onClick={onOpenSimulation}
              title="Click to launch 3D interactive simulation"
            >
              <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: 'var(--status-green)', marginRight: 6 }} />
              SIMULATION ↗
            </button>
            <span style={{ fontSize: '10px', color: 'var(--accent-cyan)', cursor: 'pointer', fontWeight: 600 }} onClick={onOpenSimulation}>
              3D VIEWPORT READY
            </span>
          </div>

          <h2 className="s1-parameters-title">PARAMETERS</h2>
          
          <div className="s1-param-subline">
            <span>ROTAX TELEMETRY PACKET</span>
            <span style={{ color: 'var(--status-green)', fontWeight: 700 }}>STATUS: CALIBRATED</span>
          </div>

          {/* Key-Value Parameter Table */}
          <div className="s1-param-table">
            <div className="s1-param-row">
              <div>
                <span className="s1-param-label">RPM</span>
                <span className="s1-param-desc">(Resolutions per minute)</span>
              </div>
              <div className="s1-param-value">
                {telemetry.rpm.toLocaleString()} <span className="s1-param-unit">RPM</span>
              </div>
            </div>

            <div className="s1-param-row">
              <div>
                <span className="s1-param-label">CHT</span>
                <span className="s1-param-desc">(Cylinder Head Temperature)</span>
              </div>
              <div className="s1-param-value">
                {telemetry.cht} <span className="s1-param-unit">°C</span>
              </div>
            </div>

            <div className="s1-param-row">
              <div>
                <span className="s1-param-label">EGT</span>
                <span className="s1-param-desc">(Exhaust Gas Temperature)</span>
              </div>
              <div className="s1-param-value">
                {telemetry.egt} <span className="s1-param-unit">°C</span>
              </div>
            </div>

            <div className="s1-param-row">
              <div>
                <span className="s1-param-label">Oil pressure and Temperature</span>
              </div>
              <div className="s1-param-value">
                {telemetry.oilPressureBar} <span className="s1-param-unit">bar</span> / {telemetry.oilTempC} <span className="s1-param-unit">°C</span>
              </div>
            </div>

            <div className="s1-param-row">
              <div>
                <span className="s1-param-label">Fuel Flow</span>
              </div>
              <div className="s1-param-value">
                {telemetry.fuelFlowLh} <span className="s1-param-unit">L/h</span>
              </div>
            </div>

            <div className="s1-param-row">
              <div>
                <span className="s1-param-label">Vibration Signatures</span>
              </div>
              <div className="s1-param-value green">
                {telemetry.vibrationRmsG} <span className="s1-param-unit">g [NOM]</span>
              </div>
            </div>

            <div className="s1-param-row">
              <div>
                <span className="s1-param-label">Battery and Alternator Health</span>
              </div>
              <div className="s1-param-value">
                {telemetry.batteryVolts} <span className="s1-param-unit">V</span> / {telemetry.batteryHealthPct}%
              </div>
            </div>

            <div className="s1-param-row">
              <div>
                <span className="s1-param-label">Injection Timing Parameters</span>
              </div>
              <div className="s1-param-value cyan">
                {telemetry.injectionTimingBtdc}
              </div>
            </div>
          </div>

          {/* Bottom Bus Stream & Manifold Pressure Widget */}
          <div className="s1-bottom-bus">
            <div className="s1-bus-row">
              <span style={{ color: 'var(--text-secondary)' }}>BUS STREAM:</span>
              <span style={{ color: 'var(--accent-cyan)', fontWeight: 700 }}>{telemetry.busStream}</span>
            </div>
            <div className="s1-bus-row">
              <span style={{ color: 'var(--text-secondary)' }}>MANIFOLD PRESSURE:</span>
              <span style={{ color: '#ffffff', fontWeight: 700 }}>{telemetry.manifoldPressureInHg} inHg [TURBO BOOST]</span>
            </div>
            <div className="s1-progress-track">
              <div className="s1-progress-fill" style={{ width: `${telemetry.manifoldPressurePct}%` }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
