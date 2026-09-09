import React, { useState, useEffect } from 'react';

export function TopBar({ activeTab, setActiveTab, telemetry }) {
  const [currentTime, setCurrentTime] = useState(telemetry.utcTime || "12:13:10 UTC");
  const [frameTick, setFrameTick] = useState(telemetry.frameNumber || 49184);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      const hours = String(now.getUTCHours()).padStart(2, '0');
      const minutes = String(now.getUTCMinutes()).padStart(2, '0');
      const seconds = String(now.getUTCSeconds()).padStart(2, '0');
      const ms = String(Math.floor(now.getUTCMilliseconds() / 100));
      setCurrentTime(`${hours}:${minutes}:${seconds}.${ms} UTC`);
      setFrameTick(prev => prev + 1);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const tabs = [
    { id: 'simulation', num: '1', label: '1. UAV SCHEMATIC' },
    { id: 'engine_3d_simulation', num: '2', label: '2. 3D DIGITAL TWIN' },
    { id: 'livestats', num: '3', label: '3. LIVE STATS' },
    { id: 'livestats_graph', num: '4', label: '4. LIVE STATS & GRAPH' },
    { id: 'ideal_real', num: '5', label: '5. IDEAL VS REAL' },
    { id: 'health_summary', num: '6', label: '6. HEALTH SUMMARY' },
  ];

  return (
    <header className="uav-topbar">
      {/* Row 1: Brand & Nav Tabs & Right Status */}
      <div className="uav-topbar-row-1">
        <div className="uav-sys-brand">
          <span className="uav-dot-pulse" />
          <span>
            {activeTab === 'engine_3d_simulation' ? 'SYS.DIGITAL_TWIN // ROTAX 914F 3D MODEL' :
             activeTab === 'livestats' ? 'SYS_STATUS: ONLINE  |  UAV-914 ROTAX TURBO' :
             activeTab === 'livestats_graph' ? 'SYS-UAV // TELEMETRY MONITOR' :
             activeTab === 'ideal_real' ? 'UAV PROPULSION TELEMETRY SUITE // ARCHITECTURE 04' :
             'SYS.TELEMETRY // UAV-914F'}
          </span>
        </div>

        {/* Center Tabs */}
        <nav className="uav-nav-tabs">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            let activeClass = '';
            if (isActive) {
              // Screen 5 uses bordered dark box motif, others use white pill
              activeClass = tab.id === 'health_summary' ? 'active-box' : 'active-pill';
            }

            return (
              <button
                key={tab.id}
                className={`uav-nav-tab ${activeClass}`}
                onClick={() => setActiveTab(tab.id)}
                title={`Press ${tab.num} to switch`}
              >
                {isActive && (
                  tab.id === 'health_summary' ? (
                    <span className="tab-dot-square" />
                  ) : (
                    <span className="tab-dot" />
                  )
                )}
                {tab.label}
              </button>
            );
          })}
        </nav>

        {/* Right Corner Telemetry Sync Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '11px' }}>
          {(activeTab === 'ideal_real' || activeTab === 'health_summary') ? (
            <>
              <span style={{ color: 'var(--text-muted)' }}>SYNC RATE: <strong style={{ color: '#fff' }}>50 Hz</strong></span>
              <span style={{ color: 'var(--text-muted)' }}>FRAME: <strong style={{ color: '#fff' }}>#{frameTick}</strong></span>
              <span className="uav-badge uav-badge-green">TELEMETRY LOCKED</span>
            </>
          ) : (
            <span style={{ color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>
              {currentTime}
            </span>
          )}
        </div>
      </div>

      {/* Row 2: Subtitle Metadata / Hardware Bus Links */}
      <div className="uav-topbar-meta">
        {(activeTab === 'simulation' || activeTab === 'engine_3d_simulation') && (
          <>
            <div className="uav-meta-group">
              <span className="uav-meta-item">AIRFRAME: <span className="uav-meta-val">TACTICAL MALE SURVEILLANCE</span></span>
              <span className="uav-meta-item">ENGINE: <span className="uav-meta-val-cyan">ROTAX 914 F</span></span>
              <span className="uav-meta-item">LINK: <span className="uav-meta-val-green">ONLINE [98.4 dBm]</span></span>
            </div>
            <div className="uav-meta-group">
              <span>{currentTime}</span>
            </div>
          </>
        )}

        {activeTab === 'livestats' && (
          <>
            <div className="uav-meta-group">
              <span className="uav-meta-item">AIRFRAME: <span className="uav-meta-val">PREDATOR CLASS UAV</span></span>
              <span className="uav-meta-item">DOWNLINK: <span className="uav-meta-val-green">STREAM ACTIVE (100 Hz)</span></span>
            </div>
            <div className="uav-meta-group">
              <span className="uav-badge uav-badge-cyan">ARINC 429 BUS</span>
              <span>UTC {currentTime}</span>
            </div>
          </>
        )}

        {activeTab === 'livestats_graph' && (
          <>
            <div className="uav-meta-group">
              <span className="uav-meta-item">PROBES: <span className="uav-meta-val">4x CHT | 4x EGT | 1x OIL | 1x VIB</span></span>
              <span className="uav-meta-item">SAMPLING: <span className="uav-meta-val-cyan">T+0 ... T+10 SCAN</span></span>
            </div>
            <div className="uav-meta-group">
              <span>REC: {currentTime}</span>
            </div>
          </>
        )}

        {activeTab === 'ideal_real' && (
          <>
            <div className="uav-meta-group">
              <span className="uav-meta-item">SPEC MODEL: <span className="uav-meta-val">REV 4.8 DIGITAL TWIN</span></span>
              <span className="uav-meta-item">DOWNLINK: <span className="uav-meta-val-cyan">S-BAND DIRECT // RSSI: -48 DBM</span></span>
            </div>
            <div className="uav-meta-group">
              <span className="uav-meta-val-green">● 11 OF 11 SENSORS SYNCED</span>
            </div>
          </>
        )}

        {activeTab === 'health_summary' && (
          <>
            <div className="uav-meta-group">
              <span className="uav-meta-item">AIRFRAME: <span className="uav-meta-val">MQ-9 BLK-5</span></span>
              <span className="uav-meta-item">PROPULSION: <span className="uav-meta-val-cyan">ROTAX 914 F</span></span>
              <span className="uav-meta-item">PREDICTIVE SUITE: <span className="uav-meta-val">CONVERGENCE REV 4.8</span></span>
            </div>
            <div className="uav-meta-group">
              <span className="uav-badge uav-badge-orange">● 1 ANOMALY ACTIVE</span>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
