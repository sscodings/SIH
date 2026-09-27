import { useState, useEffect, useRef } from 'react';
import { isNum, kgPerSecToLitresPerHour } from '../utils/format';

const BUFFER_SIZE = 30; // 30 samples spanning the 30-second rolling window (T-30s to T-0s)
const SAMPLE_INTERVAL_MS = 900;

export const PARAM_META = {
  rpm: { unit: 'RPM', decimals: 0 },
  cht: { unit: '°C', decimals: 1 },
  egt: { unit: '°C', decimals: 1 },
  oilPressureBar: { unit: 'bar', decimals: 2 },
  oilTempC: { unit: '°C', decimals: 1 },
  fuelFlowLh: { unit: 'L/h', decimals: 1 },
  vibrationRmsG: { unit: 'g', decimals: 3 },
};
const KEYS = Object.keys(PARAM_META);

const emptyBuffers = () => ({
  ideal: Object.fromEntries(KEYS.map((k) => [k, Array(BUFFER_SIZE).fill(null)])),
  actual: Object.fromEntries(KEYS.map((k) => [k, Array(BUFFER_SIZE).fill(null)])),
});

/**
 * For per-cylinder channels, follow the cylinder deviating most from its expected value,
 * so a single-cylinder fault (misfire EGT drop, CHT drift) is what gets plotted.
 */
function mostDeviatingCylinder(actualArr, expectedArr) {
  if (!Array.isArray(actualArr) || !Array.isArray(expectedArr)) return [null, null];
  let best = 0;
  let bestDev = -1;
  actualArr.forEach((val, i) => {
    const dev = isNum(val) && isNum(expectedArr[i]) ? Math.abs(val - expectedArr[i]) : -1;
    if (dev > bestDev) {
      bestDev = dev;
      best = i;
    }
  });
  return [actualArr[best] ?? null, expectedArr[best] ?? null];
}

/**
 * The ideal side is the server's `expected` block: in sandbox mode a fault-free physics twin run on
 * the same throttle/altitude/ambient inputs, in mission replay a healthy-fleet baseline for the
 * current phase, OAT and altitude. So the ideal line moves with flight conditions.
 */
function extractSample(telemetry) {
  const exp = telemetry?.expected;
  if (!exp || !isNum(telemetry.rpm)) return null;
  const [chtA, chtE] = mostDeviatingCylinder(telemetry.cht_c, exp.cht_c);
  const [egtA, egtE] = mostDeviatingCylinder(telemetry.egt_c, exp.egt_c);
  return {
    actual: {
      rpm: telemetry.rpm,
      cht: chtA,
      egt: egtA,
      oilPressureBar: telemetry.oil_pressure_bar,
      oilTempC: telemetry.oil_temp_c,
      fuelFlowLh: kgPerSecToLitresPerHour(telemetry.fuel_flow_kg_s),
      vibrationRmsG: telemetry.vibration_rms_g,
    },
    ideal: {
      rpm: exp.rpm,
      cht: chtE,
      egt: egtE,
      oilPressureBar: exp.oil_pressure_bar,
      oilTempC: exp.oil_temp_c,
      fuelFlowLh: kgPerSecToLitresPerHour(exp.fuel_flow_kg_s),
      vibrationRmsG: exp.vibration_rms_g,
    },
  };
}

const push = (arr, value) => [...arr.slice(1), isNum(value) ? value : null];

/**
 * 30-sample rolling buffers per parameter, sampled at ~1 Hz. Ideal and actual are pushed in the
 * same sample so the two series stay time-aligned. History restarts on reset or mode/mission switch.
 * Mounted at App level so sampling continues while other tabs are open.
 */
export function useTelemetryHistory(telemetry) {
  const [history, setHistory] = useState(emptyBuffers);
  const lastSampleRef = useRef(0);
  const lastStreamKeyRef = useRef(null);
  const lastSimTRef = useRef(null);

  useEffect(() => {
    if (!telemetry) return;

    const streamKey = `${telemetry.sim_mode}:${telemetry.replay?.mission_id ?? ''}`;
    const lastT = lastSimTRef.current;
    const restarted = streamKey !== lastStreamKeyRef.current || (isNum(lastT) && isNum(telemetry.t) && telemetry.t < lastT);
    lastStreamKeyRef.current = streamKey;
    lastSimTRef.current = telemetry.t;

    const now = Date.now();
    const sample = telemetry.is_running && now - lastSampleRef.current >= SAMPLE_INTERVAL_MS ? extractSample(telemetry) : null;
    if (!restarted && !sample) return;
    if (sample) lastSampleRef.current = now;

    setHistory((prev) => {
      const base = restarted ? emptyBuffers() : prev;
      if (!sample) return base;
      const next = { ideal: {}, actual: {} };
      KEYS.forEach((key) => {
        next.ideal[key] = push(base.ideal[key], sample.ideal[key]);
        next.actual[key] = push(base.actual[key], sample.actual[key]);
      });
      return next;
    });
  }, [telemetry]);

  const xLabels = ['T-30s', 'T-24s', 'T-18s', 'T-12s', 'T-6s', 'T-0s'];

  const params = {};
  KEYS.forEach((key) => {
    const meta = PARAM_META[key];
    const idealSeries = history.ideal[key];
    const actualSeries = history.actual[key];
    const currentIdeal = idealSeries[BUFFER_SIZE - 1];
    const currentValue = actualSeries[BUFFER_SIZE - 1];
    params[key] = {
      ...meta,
      key,
      idealSeries,
      actualSeries,
      currentIdeal,
      currentValue,
      deltaFromIdeal: isNum(currentValue) && isNum(currentIdeal)
        ? Number((currentValue - currentIdeal).toFixed(meta.decimals))
        : null,
    };
  });

  return { params, xLabels };
}
