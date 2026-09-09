import { useState, useEffect, useRef } from 'react';

const BUFFER_SIZE = 30; // 30 samples spanning the 30-second rolling window (T-30s to T-0s)

// Nominal / Ideal baselines matching dashboard/src/data/telemetryData.js (s4.ideal)
export const IDEAL_BASELINES = {
  rpm: {
    val: 2500.0,
    unit: 'RPM',
    name: 'CRANKSHAFT VELOCITY',
    subheading: 'RPM (REVOLUTIONS PER MINUTE)',
    nominalRange: '2,500 ± 20 RPM',
    decimals: 0,
  },
  cht: {
    val: 172.5,
    unit: '°C',
    name: 'CYLINDER HEAD TEMPERATURE',
    subheading: 'CHT (PEAK / DEVIATING CYLINDER)',
    nominalRange: '165.0 - 180.0 °C',
    decimals: 1,
  },
  egt: {
    val: 635.0,
    unit: '°C',
    name: 'EXHAUST GAS TEMPERATURE',
    subheading: 'EGT (PEAK / DEVIATING CYLINDER)',
    nominalRange: '620.0 - 650.0 °C',
    decimals: 1,
  },
  oilPressureBar: {
    val: 4.25,
    unit: 'bar',
    name: 'MAIN GALLERY OIL PRESSURE',
    subheading: 'OIL PRESSURE',
    nominalRange: '4.0 - 4.5 bar',
    decimals: 2,
  },
  oilTempC: {
    val: 85.0,
    unit: '°C',
    name: 'SUMP LUBRICANT TEMPERATURE',
    subheading: 'OIL TEMPERATURE',
    nominalRange: '80.0 - 90.0 °C',
    decimals: 1,
  },
  fuelFlowLh: {
    val: 18.0,
    unit: 'L/h',
    name: 'FUEL FLOW CONSUMPTION RATE',
    subheading: 'FUEL FLOW RATE',
    nominalRange: '18.0 L/h [CONSUMPTION]',
    decimals: 1,
  },
  vibrationRmsG: {
    val: 0.20,
    unit: 'g',
    name: 'RADIAL HARMONIC VIBRATION',
    subheading: 'VIBRATION RMS',
    nominalRange: '< 0.30 g [MAX TOLERANCE]',
    decimals: 3,
  },
};

// Module-level persistent buffer so history continues across tab switches
let moduleHistory = null;
let lastSampleTimestamp = 0;

/**
 * Extracts normalized parameter numbers from the live telemetry object.
 * Intelligently captures single-cylinder divergences (e.g. misfire EGT drop or hotspot CHT spike).
 */
function extractParamValues(telemetry) {
  if (!telemetry) {
    return {
      rpm: 2500,
      cht: 172.5,
      egt: 635.0,
      oilPressureBar: 4.25,
      oilTempC: 85.0,
      fuelFlowLh: 18.0,
      vibrationRmsG: 0.20,
    };
  }

  // 1. RPM
  const rpm = typeof telemetry.rpm === 'number' ? telemetry.rpm : 2500;

  // 2. CHT: Find cylinder with largest deviation from nominal (172.5°C) to capture thermal spikes
  let cht = 172.5;
  if (Array.isArray(telemetry.cht_c) && telemetry.cht_c.length > 0) {
    let maxDev = -1;
    telemetry.cht_c.forEach((val) => {
      const dev = Math.abs(val - 172.5);
      if (dev > maxDev) {
        maxDev = dev;
        cht = val;
      }
    });
  } else if (typeof telemetry.cht === 'number') {
    cht = telemetry.cht;
  }

  // 3. EGT: Find cylinder with largest deviation from nominal (635.0°C) to capture misfire drop or lean spike
  let egt = 635.0;
  if (Array.isArray(telemetry.egt_c) && telemetry.egt_c.length > 0) {
    let maxDev = -1;
    telemetry.egt_c.forEach((val) => {
      const dev = Math.abs(val - 635.0);
      if (dev > maxDev) {
        maxDev = dev;
        egt = val;
      }
    });
  } else if (typeof telemetry.egt === 'number') {
    egt = telemetry.egt;
  }

  // 4. Oil Pressure (bar)
  let oilPressureBar = 4.25;
  if (typeof telemetry.oilPressureBar === 'number') {
    oilPressureBar = telemetry.oilPressureBar;
  } else if (typeof telemetry.oil_pressure_bar === 'number') {
    oilPressureBar = telemetry.oil_pressure_bar;
  }

  // 5. Oil Temp (°C)
  let oilTempC = 85.0;
  if (typeof telemetry.oilTempC === 'number') {
    oilTempC = telemetry.oilTempC;
  } else if (typeof telemetry.oil_temp_c === 'number') {
    oilTempC = telemetry.oil_temp_c;
  }

  // 6. Fuel Flow (L/h)
  let fuelFlowLh = 18.0;
  if (typeof telemetry.fuelFlowLh === 'number') {
    fuelFlowLh = telemetry.fuelFlowLh;
  } else if (typeof telemetry.fuel_flow_l_h === 'number') {
    fuelFlowLh = telemetry.fuel_flow_l_h;
  } else if (typeof telemetry.fuel_flow_kg_s === 'number') {
    fuelFlowLh = Number((telemetry.fuel_flow_kg_s * 3600 / 0.72).toFixed(1));
  }

  // 7. Vibration RMS (g)
  let vibrationRmsG = 0.20;
  if (typeof telemetry.vibrationRmsG === 'number') {
    vibrationRmsG = telemetry.vibrationRmsG;
  } else if (typeof telemetry.vibration_rms_g === 'number') {
    vibrationRmsG = telemetry.vibration_rms_g;
  }

  return {
    rpm: Number(rpm.toFixed(0)),
    cht: Number(cht.toFixed(1)),
    egt: Number(egt.toFixed(1)),
    oilPressureBar: Number(oilPressureBar.toFixed(2)),
    oilTempC: Number(oilTempC.toFixed(1)),
    fuelFlowLh: Number(fuelFlowLh.toFixed(1)),
    vibrationRmsG: Number(vibrationRmsG.toFixed(3)),
  };
}

/**
 * Hook to manage a 30-sample rolling buffer per parameter sampled at ~1Hz.
 * Returns series for IDEAL baseline and ACTUAL live values.
 */
export function useTelemetryHistory(telemetry) {
  const [history, setHistory] = useState(() => {
    if (moduleHistory) {
      return moduleHistory;
    }
    const initial = extractParamValues(telemetry);
    const initialBuffers = {};
    Object.keys(IDEAL_BASELINES).forEach((key) => {
      initialBuffers[key] = Array(BUFFER_SIZE).fill(initial[key]);
    });
    moduleHistory = initialBuffers;
    return initialBuffers;
  });

  useEffect(() => {
    if (!telemetry) return;

    const now = Date.now();
    // Sample once per second
    if (now - lastSampleTimestamp >= 900) {
      lastSampleTimestamp = now;
      const current = extractParamValues(telemetry);

      setHistory((prev) => {
        const next = {};
        Object.keys(IDEAL_BASELINES).forEach((key) => {
          const arr = prev[key] || Array(BUFFER_SIZE).fill(current[key]);
          next[key] = [...arr.slice(1), current[key]];
        });
        moduleHistory = next;
        return next;
      });
    }
  }, [telemetry]);

  // X-axis timestamps representing real elapsed time in 6 intervals
  const xLabels = ['T-30s', 'T-24s', 'T-18s', 'T-12s', 'T-6s', 'T-0s'];

  // Construct parameter history items
  const params = {};
  Object.keys(IDEAL_BASELINES).forEach((key) => {
    const meta = IDEAL_BASELINES[key];
    const idealVal = meta.val;
    const currentActual = history[key] ? history[key][history[key].length - 1] : idealVal;
    const delta = currentActual - idealVal;

    params[key] = {
      ...meta,
      key,
      idealSeries: Array(BUFFER_SIZE).fill(idealVal),
      actualSeries: history[key] || Array(BUFFER_SIZE).fill(idealVal),
      currentValue: currentActual,
      deltaFromIdeal: Number(delta.toFixed(meta.decimals)),
    };
  });

  return {
    params,
    xLabels,
  };
}
