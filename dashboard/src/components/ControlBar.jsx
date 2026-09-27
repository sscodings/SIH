import React, { useState, useEffect } from 'react';
import { API_BASE } from '../hooks/useEngineTelemetry';
import { humanize } from '../utils/format';

// Seconds for an injected fault to develop from 0% to 100%.
const FAULT_RAMP_S = 35;
const CATASTROPHIC_RAMP_S = 15;
const FAULT_SEVERITY = 0.85;

// Recorded minutes streamed per real second.
const REPLAY_SPEEDS = [0.5, 1, 2, 5, 10, 30];

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function ControlBar({ telemetry, isConnected, sendCommand }) {
  const [missions, setMissions] = useState([]);
  const [selectedFault, setSelectedFault] = useState('misfire');
  const [selectedCylinder, setSelectedCylinder] = useState(0);

  const isRunning = Boolean(telemetry?.is_running);
  const isReplay = telemetry?.sim_mode === 'mission_replay';
  const replay = telemetry?.replay;
  const recordedFault = telemetry?.recorded_fault;
  const sourceValue = isReplay && replay ? String(replay.mission_id) : 'sandbox';

  useEffect(() => {
    if (!isConnected) return;
    fetch(`${API_BASE}/api/missions`)
      .then((res) => res.json())
      .then((data) => setMissions(data.missions || []))
      .catch((err) => console.warn('[ControlBar] Could not load mission list:', err));
  }, [isConnected]);

  const handleSourceChange = (value) => {
    if (value === 'sandbox') {
      sendCommand({ command: 'select_sandbox' });
    } else {
      sendCommand({ command: 'select_mission', mission_id: Number(value), speed: replay?.speed ?? 1 });
    }
  };

  const handleInjectFault = () => {
    const isCatastrophic = selectedFault === 'catastrophic_failure';
    sendCommand({
      command: 'inject_fault',
      kind: selectedFault,
      severity: isCatastrophic ? 1.0 : FAULT_SEVERITY,
      cylinder: Number(selectedCylinder),
      ramp_s: isCatastrophic ? CATASTROPHIC_RAMP_S : FAULT_RAMP_S,
      start_in_s: 0.0,
    });
  };

  const handleClearFaults = () => {
    sendCommand({ command: 'clear_faults' });
    sendCommand({ command: 'set_health', health: 1.0 });
  };

  const statusLabel = !isConnected
    ? 'DISCONNECTED'
    : replay?.complete ? 'COMPLETE' : isRunning ? 'RUNNING' : 'PAUSED';

  return (
    <div className="control-bar">
      {/* Primary Simulation Controls */}
      <div className="control-group-left">
        <button
          type="button"
          onClick={() => sendCommand({ command: 'resume' })}
          disabled={!isConnected || isRunning || Boolean(replay?.complete)}
          className="control-btn btn-start"
        >
          Start
        </button>

        <button
          type="button"
          onClick={() => sendCommand({ command: 'pause' })}
          disabled={!isConnected || !isRunning}
          className="control-btn btn-pause"
        >
          Pause
        </button>

        <button
          type="button"
          onClick={() => sendCommand({ command: 'reset' })}
          disabled={!isConnected}
          className="control-btn btn-reset"
          title={isReplay ? 'Rewind the recorded mission to minute 0' : 'Return the engine to the runway, cold and paused'}
        >
          Reset
        </button>

        <div className="status-indicator-box">
          <span className={`status-dot ${!isConnected ? 'disconnected' : isRunning ? 'running' : 'paused'}`} />
          <span style={{ fontWeight: 600, color: '#E2E8F0' }}>{statusLabel}</span>
          {isConnected && isReplay && replay && (
            <span style={{ color: 'var(--text-dim)' }}>
              (MIN {replay.elapsed_min} / {replay.duration_min})
            </span>
          )}
          {isConnected && !isReplay && typeof telemetry?.t === 'number' && (
            <span style={{ color: 'var(--text-dim)' }}>(T+ {formatClock(telemetry.t)})</span>
          )}
        </div>
      </div>

      <div className="control-group-right">
        <span className="control-label">Source:</span>
        <select
          value={sourceValue}
          onChange={(e) => handleSourceChange(e.target.value)}
          disabled={!isConnected}
          className="fault-select"
          style={{ maxWidth: '340px' }}
          title="Live physics sandbox, or replay one of the 15 recorded missions"
        >
          <option value="sandbox">Live Sandbox (physics twin)</option>
          {missions.map((m) => (
            <option key={m.mission_id} value={String(m.mission_id)}>
              {`Mission ${m.mission_id} · ${m.mission_type.replace(/_/g, ' ')} · ${m.weather_profile.replace(/_/g, ' ')} · ${
                m.fault_type === 'none' ? 'healthy' : `${m.fault_type.replace(/_/g, ' ')} @ min ${m.fault_onset_min}`
              } · ${m.duration_min} min`}
            </option>
          ))}
        </select>

        {isReplay ? (
          <>
            <span className="control-label">Speed:</span>
            <select
              value={String(replay?.speed ?? 1)}
              onChange={(e) => sendCommand({ command: 'set_replay_speed', speed: Number(e.target.value) })}
              disabled={!isConnected}
              className="fault-select"
              style={{ minWidth: '110px' }}
              title="Recorded minutes streamed per real second"
            >
              {REPLAY_SPEEDS.map((s) => (
                <option key={s} value={String(s)}>{s} min/s</option>
              ))}
            </select>
            <span
              className={`uav-badge ${recordedFault?.active ? 'uav-badge-orange' : 'uav-badge-green'}`}
              title="Ground-truth label recorded in the dataset (not the AI diagnosis)"
            >
              RECORDED LABEL: {recordedFault?.active ? humanize(recordedFault.kind) : 'HEALTHY'}
            </span>
          </>
        ) : (
          <>
            <span className="control-label">Inject Fault:</span>
            <select
              value={selectedFault}
              onChange={(e) => setSelectedFault(e.target.value)}
              className="fault-select"
            >
              <option value="misfire">1. Misfire</option>
              <option value="injector_abnormalities">2. Injector Mismatch</option>
              <option value="cooling_degradation">3. Cooling Heat Loss</option>
              <option value="lubrication_issues">4. Lubrication Deficit (Oil Leak)</option>
              <option value="sensor_drift">5. Sensor Drift</option>
              <option value="combustion_instability">6. Combustion Instability</option>
              <option value="overheating_trends">7. Overheating Trend</option>
              <option value="abnormal_vibration">8. 1x Shaft Unbalance Vibration</option>
              <option value="catastrophic_failure">9. Catastrophic Failure ({CATASTROPHIC_RAMP_S} s ramp)</option>
            </select>

            {['misfire', 'sensor_drift', 'injector_abnormalities'].includes(selectedFault) && (
              <select
                value={selectedCylinder}
                onChange={(e) => setSelectedCylinder(Number(e.target.value))}
                className="fault-select"
                style={{ width: '85px', minWidth: '85px', borderColor: 'var(--accent-amber)' }}
                title="Target Cylinder"
              >
                <option value={0}>Cyl 1</option>
                <option value={1}>Cyl 2</option>
                <option value={2}>Cyl 3</option>
                <option value={3}>Cyl 4</option>
              </select>
            )}

            <button type="button" onClick={handleInjectFault} disabled={!isConnected} className="btn-inject">
              Inject
            </button>

            <button type="button" onClick={handleClearFaults} disabled={!isConnected} className="btn-clear">
              Clear
            </button>
          </>
        )}
      </div>
    </div>
  );
}
