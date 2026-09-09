import React, { useState, useEffect } from 'react';
import { INITIAL_TELEMETRY } from './data/telemetryData';
import { useEngineTelemetry } from './hooks/useEngineTelemetry';
import { TopBar } from './components/TopBar';
import { FooterBar } from './components/FooterBar';
import { ScreenSimulation } from './components/ScreenSimulation';
import { ScreenLiveStats } from './components/ScreenLiveStats';
import { ScreenLiveStatsAndGraph } from './components/ScreenLiveStatsAndGraph';
import { ScreenIdealVsReal } from './components/ScreenIdealVsReal';
import { ScreenHealthSummary } from './components/ScreenHealthSummary';
import { ScreenEngine3DSimulation } from './components/ScreenEngine3DSimulation';
import './index.css';

export default function App() {
  const [activeTab, setActiveTab] = useState('simulation');
  const [telemetry, setTelemetry] = useState(INITIAL_TELEMETRY);

  // Connect to live WebSocket stream if backend is online
  const { telemetry: wsLiveTelemetry, isConnected, sendCommand } = useEngineTelemetry();

  // Synchronize incoming live websocket telemetry into the HUD data store
  useEffect(() => {
    if (wsLiveTelemetry && isConnected) {
      setTelemetry(prev => {
        const liveRpm = Math.round(wsLiveTelemetry.rpm || prev.rpm);
        const liveCht = wsLiveTelemetry.cht_c ? Number(Math.max(...wsLiveTelemetry.cht_c).toFixed(1)) : prev.cht;
        const liveEgt = wsLiveTelemetry.egt_c ? Number(Math.max(...wsLiveTelemetry.egt_c).toFixed(1)) : prev.egt;
        const liveOilP = wsLiveTelemetry.oil_pressure_bar ? Number(wsLiveTelemetry.oil_pressure_bar.toFixed(1)) : prev.oilPressureBar;
        const liveOilT = wsLiveTelemetry.oil_temp_c ? Number(wsLiveTelemetry.oil_temp_c.toFixed(1)) : prev.oilTempC;
        const liveVib = wsLiveTelemetry.vibration_rms_g ? Number(wsLiveTelemetry.vibration_rms_g.toFixed(2)) : prev.vibrationRmsG;
        const liveFuelLh = wsLiveTelemetry.fuel_flow_kg_s ? Number((wsLiveTelemetry.fuel_flow_kg_s * 3600 / 0.72).toFixed(2)) : prev.fuelFlowLh;

        return {
          ...prev,
          rpm: liveRpm,
          cht: liveCht,
          egt: liveEgt,
          oilPressureBar: liveOilP,
          oilTempC: liveOilT,
          fuelFlowLh: liveFuelLh,
          vibrationRmsG: liveVib,
          s2: {
            ...prev.s2,
            rpm: liveRpm,
            cht: liveCht,
            egt: liveEgt,
            oilPress: liveOilP,
            oilTemp: liveOilT,
            fuelFlow: Number((liveFuelLh).toFixed(1)),
            vibRms: liveVib,
          }
        };
      });
    }
  }, [wsLiveTelemetry, isConnected]);

  // Keyboard Navigation: 1-5 keys for mission control tab switching
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.key === '1') setActiveTab('simulation');
      if (e.key === '2') setActiveTab('livestats');
      if (e.key === '3') setActiveTab('livestats_graph');
      if (e.key === '4') setActiveTab('ideal_real');
      if (e.key === '5') setActiveTab('health_summary');
      if (e.key === 'Escape' && activeTab === 'engine_3d_simulation') setActiveTab('simulation');
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab]);

  return (
    <div className="uav-grid-bg">
      <div className="uav-app-container">
        {/* Persistent Top Navigation Bar */}
        <TopBar
          activeTab={activeTab === 'engine_3d_simulation' ? 'simulation' : activeTab}
          setActiveTab={setActiveTab}
          telemetry={telemetry}
        />

        {/* Main Tab Screen Viewport */}
        <main className="uav-main-viewport">
          {activeTab === 'simulation' && (
            <ScreenSimulation
              telemetry={telemetry}
              onOpenSimulation={() => setActiveTab('engine_3d_simulation')}
            />
          )}

          {activeTab === 'engine_3d_simulation' && (
            <ScreenEngine3DSimulation
              telemetry={telemetry}
              wsTelemetry={wsLiveTelemetry}
              isConnected={isConnected}
              sendCommand={sendCommand}
              onBack={() => setActiveTab('simulation')}
            />
          )}

          {activeTab === 'livestats' && (
            <ScreenLiveStats telemetry={telemetry} />
          )}

          {activeTab === 'livestats_graph' && (
            <ScreenLiveStatsAndGraph telemetry={telemetry} />
          )}

          {activeTab === 'ideal_real' && (
            <ScreenIdealVsReal telemetry={telemetry} />
          )}

          {activeTab === 'health_summary' && (
            <ScreenHealthSummary telemetry={telemetry} />
          )}
        </main>

        {/* Persistent Tactical Footer Bar */}
        <FooterBar
          activeTab={activeTab === 'engine_3d_simulation' ? 'simulation' : activeTab}
          telemetry={telemetry}
        />
      </div>
    </div>
  );
}
