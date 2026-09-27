/**
 * Tactical UAV Telemetry Data Store & State Defaults
 * SIH26054 Rotax 914F MALE UAV Digital Twin Telemetry Monitor
 *
 * INITIAL_TELEMETRY is the dashboard state before live WebSocket telemetry arrives
 * (and after a disconnect): no engine data. Live readings are null and render as '---'.
 */

export const INITIAL_TELEMETRY = {
  // Static node / link branding
  utcTime: "--:--:-- UTC",
  frameNumber: 0,
  nodeId: "GCU-ALPHA-01",
  fps: 60,
  latencyMs: 14,
  interfaceBus: "MIL-STD-1553 INTERFACE",
  busStream: "CAN-A / ARINC-429 ACTIVE",

  // Engine / flight state (no data until the backend streams it)
  is_running: false,
  sim_mode: null,
  mission_phase: null,
  rpm: null,
  cht: null,
  egt: null,
  oilPressureBar: null,
  oilTempC: null,
  fuelFlowLh: null,
  vibrationRmsG: null,
  manifoldPressureInHg: null,
  manifoldPressurePct: 0,
  alternator_v: null,
  altitude_m: null,
  health_index: null,
  active_faults: [],
  active_faults_count: 0,
  diagnostics: null,
  expected: null,
  environment: null,
  replay: null,
  recorded_fault: null,

  // Live Stats & Graph thermal heat-map card
  s3: {
    heatmap: {
      title: "UAV Piston Engine Atmospheric Stress Heat Map",
      tooltip: {
        zone: "CRIT_ZONE #2: 438K",
        stress: "RADIAL STRESS: 92%",
        probe: "PROBE ID: TS-98"
      },
      specs: [
        { label: "gradient", val: "Isobaric 2D Model" },
        { label: "probe_x", val: "48.21 mm" },
        { label: "peak_zone", val: "Cyl #2 Upper Baffle" },
        { label: "delta_t", val: "+14.2 K/s" },
        { label: "status", val: "SURFACE WITHIN TOLERANCE", isGreen: true }
      ]
    }
  },
};
