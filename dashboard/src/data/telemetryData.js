/**
 * Tactical UAV Telemetry Data Store & State Defaults
 * SIH26054 Rotax 914F MALE UAV Digital Twin Telemetry Monitor
 */

export const INITIAL_TELEMETRY = {
  // Common Navigation / Flight State
  utcTime: "12:13:10 UTC",
  airframe: "TACTICAL MALE SURVEILLANCE",
  airframeModel: "MQ-9 BLK-5",
  engineModel: "ROTAX 914 F",
  linkStatus: "ONLINE [98.4 dBm]",
  linkStrengthDbm: -98.4,
  rssi: "-48 DBM",
  nodeId: "GCU-ALPHA-01",
  coordinates: "LAT: 34°12'04\"N  LON: 118°28'12\"W  ALT: 18,400 FT MSL",
  fps: 60,
  latencyMs: 14,
  interfaceBus: "MIL-STD-1553 INTERFACE",
  syncRateHz: 50,
  frameNumber: 49184,
  busStream: "CAN-A / ARINC-429 ACTIVE",
  manifoldPressureInHg: 39.4,
  manifoldPressurePct: 78,

  // Screen 1 & 2 Core Telemetry
  rpm: 2483,
  cht: 178.3,
  egt: 642.1,
  oilPressureBar: 4.2,
  oilTempC: 86.0,
  fuelFlowLh: 18.39,
  vibrationRmsG: 0.34,
  batteryVolts: 28.2,
  batteryHealthPct: 98,
  injectionTimingBtdc: "BTDC 14.2°",

  // Screen 2 specifics
  s2: {
    rpm: 2485,
    cht: 178.5,
    egt: 641.8,
    oilPress: 4.2,
    oilTemp: 85.8,
    fuelFlow: 18.4,
    vibRms: 0.32,
    busVolts: 28.2,
    map: 34.2,
    sampleRateHz: 100,
    pktLossPct: "0.00%",
    totalFrames: 1042910,
    hexStream: [
      { addr: "0x00F1", bytes: "4A 22 F9 8B 00 E3", status: "OK" },
      { addr: "0x00F2", bytes: "09 FF 12 C1 A2 33", status: "OK" },
      { addr: "0x00F3", bytes: "EE 45 BD 70 BB 19", status: "OK" },
      { addr: "0x00F4", bytes: "12 8A 90 CE D3 40", status: "OK" },
      { addr: "0x00F5", bytes: "A1 3C 55 9E 27 FA", status: "OK" },
    ]
  },

  // Screen 3 specifics
  s3: {
    param1: {
      name: "PARAMETER 1 / CHT",
      items: [
        { label: "ewid", val: "142.8 °C" },
        { label: "djfjIwei", val: "0.038 bar" },
        { label: "ewjfionf", val: "98.4 %" },
        { label: "jdrijw", val: "NOMINAL" },
        { label: "dnwfwlek", val: "0.0024 ms" },
      ]
    },
    param2: {
      name: "PARAMETER 2 / EGT",
      items: [
        { label: "ewid", val: "685.2 °C" },
        { label: "djfjIwei", val: "1.240 bar" },
        { label: "ewjfionf", val: "94.1 %" },
        { label: "jdrijw", val: "ACTIVE" },
        { label: "dnwfwlek", val: "0.0018 ms" },
      ]
    },
    param3: {
      name: "PARAMETER 3 / RPM",
      items: [
        { label: "ewid", val: "5420 RPM" },
        { label: "djfjIwei", val: "14.7 psi" },
        { label: "ewjfionf", val: "88.6 %" },
        { label: "jdrijw", val: "STABLE" },
        { label: "dnwfwlek", val: "0.0031 ms" },
      ]
    },
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

  // Screen 4 Ideal vs Real
  s4: {
    ideal: [
      { name: "RPM (REVOLUTIONS PER MINUTE)", desc: "Standard Cruise Envelope @ 3,500m ASL", val: "2,500 ± 20", unit: "RPM [NOMINAL]" },
      { name: "CHT (CYLINDER HEAD TEMPERATURE)", desc: "Combustion Chamber Continuous Rating", val: "165.0 - 180.0", unit: "°C [TARGET RANGE]" },
      { name: "EGT (EXHAUST GAS TEMPERATURE)", desc: "Manifold Thermal Equilibrium Threshold", val: "620.0 - 650.0", unit: "°C [OPTIMAL]" },
      { name: "OIL PRESSURE", desc: "Main Gallery Pressurization Line", val: "4.0 - 4.5", unit: "bar [STABLE]" },
      { name: "OIL TEMPERATURE", desc: "Sump Lubricant Viscosity Window", val: "80.0 - 90.0", unit: "°C [REGULATED]" },
      { name: "FUEL FLOW RATE", desc: "Mass Flow Meter Calibrated Average", val: "18.0", unit: "L/h [CONSUMPTION]" },
      { name: "VIBRATION SIGNATURES", desc: "Radial Harmonic Tri-Axial Accelerometer", val: "< 0.30", unit: "g RMS [MAX TOLERANCE]" },
      { name: "BATTERY AND ALTERNATOR HEALTH", desc: "Avionics Bus Dynamic Power Delivery", val: "28.0 / 15.0", unit: "V / A [REGULATED]" },
    ],
    real: [
      { name: "CRUISE RPM", desc: "Hall-Effect Crank Position Sensor", val: "2,483", unit: "RPM", delta: "Δ -17 RPM [NOMINAL]", status: "nominal" },
      { name: "CYLINDER HEAD TEMP (CHT)", desc: "Thermocouple Bank A/B Average", val: "178.3", unit: "°C", delta: "Δ +2.3 °C [NOMINAL]", status: "nominal" },
      { name: "EXHAUST GAS TEMP (EGT)", desc: "Turbine Inlet Pyrometer", val: "642.1", unit: "°C", delta: "Δ +5.1 °C [NOMINAL]", status: "nominal" },
      { name: "OIL PRESSURE", desc: "Piezo-Resistive Transducer", val: "4.2", unit: "bar", delta: "Δ 0.0 bar [OPTIMAL]", status: "nominal" },
      { name: "OIL TEMPERATURE", desc: "Direct Contact RTD Sensor", val: "86.0", unit: "°C", delta: "Δ +2.0 °C [NOMINAL]", status: "nominal" },
      { name: "FUEL FLOW RATE", desc: "Optical Turbine Flow Pulse Unit", val: "18.39", unit: "L/h", delta: "Δ +0.39 L/h [NOMINAL]", status: "nominal" },
      { name: "VIBRATION RMS ●", desc: "Engine Mount Accelerometer #2", val: "0.34", unit: "g", delta: "Δ +0.04 g [WARNING]", status: "warning" },
      { name: "ALTERNATOR OUTPUT", desc: "Avionics Bus Dynamic Power Delivery", val: "28.2 / 14.8", unit: "V/A", delta: "", status: "nominal" },
    ]
  },

  // Screen 5 Health Summary
  s5: {
    healthScore: 92.4,
    idealBaseline: "100.0%",
    realCompliance: "92.4%",
    deltaVariance: "-7.6%",
    activeAnomalyCount: 1,
    warning: {
      name: "VIBRATION SIGNATURE (RMS)",
      desc: "Engine Mount Accelerometer #2 // Tri-Axial Node",
      ideal: "< 0.30 g",
      real: "0.34 g",
      chip: "+0.04 g (+13.3%) WARNING"
    },
    nominals: [
      { label: "CRUISE RPM", val: "2,483", unit: "RPM" },
      { label: "CYLINDER HEAD TEMP", val: "178.3", unit: "°C" },
      { label: "EXHAUST GAS TEMP", val: "642.1", unit: "°C" },
      { label: "OIL PRESSURE", val: "4.2", unit: "bar" },
    ],
    diagnosis: "DIAGNOSIS: VIBRATION HARMONIC ELEVATION MATCHING AFT MOUNT BUSHING",
    flightStatus: "FLIGHT STATUS: ADVISORY / LOW RISK"
  }
};
