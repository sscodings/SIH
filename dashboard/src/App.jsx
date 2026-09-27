import React, { useState, useEffect, useMemo } from 'react';
import { INITIAL_TELEMETRY } from './data/telemetryData';
import { useEngineTelemetry } from './hooks/useEngineTelemetry';
import { useTelemetryHistory } from './hooks/useTelemetryHistory';
import { TopBar } from './components/TopBar';
import { FooterBar } from './components/FooterBar';
import { ScreenSimulation } from './components/ScreenSimulation';
import { ScreenLiveStatsAndGraph } from './components/ScreenLiveStatsAndGraph';
import { ScreenHealthSummary } from './components/ScreenHealthSummary';
import { ScreenEngine3DSimulation } from './components/ScreenEngine3DSimulation';
import { ErrorBoundary } from './components/ErrorBoundary';
import { isNum, kgPerSecToLitresPerHour } from './utils/format';
import './index.css';

const TAB_KEYS = {
  '1': 'simulation',
  '2': 'engine_3d_simulation',
  '3': 'livestats_graph',
  '4': 'health_summary',
};

const MAP_MAX_PA = 1.42e5; // turbo boost cap in the physics model

const round = (v, digits) => (isNum(v) ? Number(v.toFixed(digits)) : null);
const maxOf = (arr) => (Array.isArray(arr) && arr.length && arr.every(isNum) ? Math.max(...arr) : null);

export default function App() {
  const [activeTab, setActiveTab] = useState('simulation');
  const { telemetry: wsLiveTelemetry, isConnected, sendCommand } = useEngineTelemetry();

  // HUD store: live WebSocket telemetry merged over the no-data defaults (which also cover disconnects).
  const telemetry = useMemo(() => {
    const ws = wsLiveTelemetry;
    if (!isConnected || !ws) return INITIAL_TELEMETRY;
    const rpm = round(ws.rpm, 0);
    const cht = round(maxOf(ws.cht_c), 1);
    const egt = round(maxOf(ws.egt_c), 1);
    const oilP = round(ws.oil_pressure_bar, 2);
    const oilT = round(ws.oil_temp_c, 1);
    const vib = round(ws.vibration_rms_g, 3);
    const fuelLh = round(kgPerSecToLitresPerHour(ws.fuel_flow_kg_s), 2);
    const mapPa = ws.diagnostics?.map_pa;
    const mapInHg = isNum(mapPa) ? Number((mapPa / 3386.39).toFixed(1)) : null;

    return {
      ...INITIAL_TELEMETRY,
      ...ws,
      rpm,
      cht,
      egt,
      oilPressureBar: oilP,
      oilTempC: oilT,
      fuelFlowLh: fuelLh,
      vibrationRmsG: vib,
      manifoldPressureInHg: mapInHg,
      manifoldPressurePct: isNum(mapPa) ? Math.min(100, (mapPa / MAP_MAX_PA) * 100) : 0,
      active_faults: ws.active_faults || [],
      active_faults_count: ws.active_faults_count ?? (ws.active_faults?.length || 0),
    };
  }, [wsLiveTelemetry, isConnected]);

  const telemetryHistory = useTelemetryHistory(telemetry);

  // Keyboard Navigation: 1-4 keys for mission control tab switching
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (TAB_KEYS[e.key]) setActiveTab(TAB_KEYS[e.key]);
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
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          telemetry={telemetry}
        />

        {/* Main Tab Screen Viewport */}
        <main className="uav-main-viewport">
          <ErrorBoundary title={`Screen Error (${activeTab})`}>
            {activeTab === 'engine_3d_simulation' && (
              <ScreenEngine3DSimulation
                telemetry={telemetry}
                wsTelemetry={wsLiveTelemetry}
                isConnected={isConnected}
                sendCommand={sendCommand}
              />
            )}

            {activeTab === 'simulation' && (
              <ScreenSimulation
                telemetry={telemetry}
                onOpenSimulation={() => setActiveTab('engine_3d_simulation')}
              />
            )}

            {activeTab === 'livestats_graph' && (
              <ScreenLiveStatsAndGraph telemetry={telemetry} history={telemetryHistory} />
            )}

            {activeTab === 'health_summary' && (
              <ScreenHealthSummary telemetry={telemetry} />
            )}
          </ErrorBoundary>
        </main>

        {/* Persistent Tactical Footer Bar */}
        <FooterBar
          activeTab={activeTab}
          telemetry={telemetry}
        />
      </div>
    </div>
  );
}
