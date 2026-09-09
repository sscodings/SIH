"""
Sensor Noise & Realism Layer
============================
SIH26054 | MALE UAV Aero Piston Engine Digital Twin

Implements the read-out stage sensor realism layer:
- Adds physical instrumentation noise (Gaussian jitter) and quantization.
- Implements sensor calibration drift and sensor failure modes purely at
  the measurement stage, preserving true engine physics.
- Enables downstream ML models to distinguish between:
    1. Genuine engine physical anomalies (CHT rising, EGT dropping, oil pressure falling)
    2. Sensor drift / measurement corruption (sensor reading changes, engine physically fine)
"""

from __future__ import annotations
import copy
from typing import Dict, Any, Optional
import numpy as np


class SensorNoiseModel:
    """
    Applies Gaussian measurement noise, quantization, and sensor calibration biases.
    All transformations occur at the read-out stage and never modify the underlying ODE state.
    """

    def __init__(self, enabled: bool = True, seed: int = 42):
        self.enabled = enabled
        self.rng = np.random.default_rng(seed)

        # Standard deviations for typical aero transducers
        self.noise_stds = {
            "rpm": 8.0,              # Optical/magnetic crank pickup [RPM]
            "cht": 0.8,              # Bayonet thermocouple [°C]
            "egt": 2.5,              # K-type thermocouple [°C]
            "oil_temp": 0.5,         # RTD/thermistor probe [°C]
            "oil_pressure": 0.04,    # Piezoresistive pressure transducer [bar]
            "fuel_flow": 0.00003,    # Turbine flowmeter [kg/s]
            "alternator_v": 0.08,    # Voltage divider / ADC [V]
            "vibration_rms": 0.005,  # MEMS/piezo accelerometer [g]
            "ambient_temp": 0.3,     # OAT probe [°C]
            "altitude": 2.0,         # Barometric altimeter [m]
        }

        # Active sensor-only faults / biases (does NOT affect engine physics)
        self.sensor_biases: Dict[str, float] = {}

    def set_sensor_bias(self, channel: str, bias: float):
        """Sets a permanent or developing calibration drift on a specific sensor."""
        self.sensor_biases[channel] = bias

    def clear_sensor_biases(self):
        self.sensor_biases.clear()

    def process_snapshot(self, out: Dict[str, Any], include_diagnostics: bool = True) -> Dict[str, Any]:
        """
        Takes raw physics output dictionary from RotaxDigitalTwin._physics_step
        and generates the telemetry payload with sensor noise applied.
        """
        # True physics baseline
        t = round(float(out["t"]), 2)
        true_rpm = float(out["rpm"])
        true_cht = [float(v) for v in out["cht_c"]]
        true_egt = [float(v) for v in out["egt_c"]]
        true_oil_temp = float(out["oil_temp_c"])
        true_oil_press_bar = float(out["oil_pressure_pa"]) / 1e5
        true_fuel_flow = float(out["fuel_flow_kg_s"])
        true_alt_v = float(out["alternator_v"])
        true_vib_rms = float(out["vibration"]["rms_g"])
        true_amb_c = float(out["t_ambient_c"])
        true_alt_m = float(out["altitude_m"])

        # Check if physics engine reported any sensor_drift from FaultInjector
        drift_dict = out.get("fault_state", {}).get("sensor_drift", {})

        if not self.enabled:
            measured_rpm = true_rpm
            measured_cht = copy.copy(true_cht)
            measured_egt = copy.copy(true_egt)
            measured_oil_temp = true_oil_temp
            measured_oil_press_bar = true_oil_press_bar
            measured_fuel_flow = true_fuel_flow
            measured_alt_v = true_alt_v
            measured_vib_rms = true_vib_rms
            measured_amb_c = true_amb_c
            measured_alt_m = true_alt_m
        else:
            # Apply Gaussian noise + sensor biases (suppressed when engine stopped or craft on ground)
            if true_rpm > 25.0:
                measured_rpm = max(0.0, true_rpm + self.rng.normal(0, self.noise_stds["rpm"]))
            else:
                measured_rpm = 0.0

            # CHT with per-cylinder noise & potential drift
            measured_cht = []
            for i, c in enumerate(true_cht):
                bias = self.sensor_biases.get(f"cht_{i+1}", 0.0) + drift_dict.get(f"CHT_{i+1}", 0.0)
                measured_cht.append(c + bias + self.rng.normal(0, self.noise_stds["cht"]))

            # EGT with per-cylinder noise & potential drift
            measured_egt = []
            for i, e in enumerate(true_egt):
                bias = self.sensor_biases.get(f"egt_{i+1}", 0.0) + drift_dict.get(f"EGT_{i+1}", 0.0)
                measured_egt.append(e + bias + self.rng.normal(0, self.noise_stds["egt"]))

            bias_ot = self.sensor_biases.get("oil_temp", 0.0) + drift_dict.get("oil_temp", 0.0)
            measured_oil_temp = true_oil_temp + bias_ot + self.rng.normal(0, self.noise_stds["oil_temp"])

            bias_op = self.sensor_biases.get("oil_pressure", 0.0) + drift_dict.get("oil_pressure", 0.0)
            if true_oil_press_bar > 0.05:
                measured_oil_press_bar = max(0.0, true_oil_press_bar + bias_op + self.rng.normal(0, self.noise_stds["oil_pressure"]))
            else:
                measured_oil_press_bar = 0.0

            if true_fuel_flow > 1e-4:
                measured_fuel_flow = max(0.0, true_fuel_flow + self.rng.normal(0, self.noise_stds["fuel_flow"]))
            else:
                measured_fuel_flow = 0.0

            measured_alt_v = max(0.0, true_alt_v + self.rng.normal(0, self.noise_stds["alternator_v"]))

            if true_rpm > 25.0:
                measured_vib_rms = max(0.0, true_vib_rms + self.rng.normal(0, self.noise_stds["vibration_rms"]))
            else:
                measured_vib_rms = 0.0

            measured_amb_c = true_amb_c + self.rng.normal(0, self.noise_stds["ambient_temp"])

            if true_alt_m > 1.0:
                measured_alt_m = max(0.0, true_alt_m + self.rng.normal(0, self.noise_stds["altitude"]))
            else:
                measured_alt_m = 0.0

        # Format to exact Section 7.1 JSON schema
        telemetry = {
            "t": t,
            "rpm": round(measured_rpm, 1),
            "cht_c": [round(v, 1) for v in measured_cht],
            "egt_c": [round(v, 1) for v in measured_egt],
            "oil_temp_c": round(measured_oil_temp, 1),
            "oil_pressure_bar": round(measured_oil_press_bar, 2),
            "fuel_flow_kg_s": round(measured_fuel_flow, 5),
            "alternator_v": round(measured_alt_v, 2),
            "vibration_rms_g": round(measured_vib_rms, 3),
            "ambient_c": round(measured_amb_c, 1),
            "altitude_m": round(measured_alt_m, 1),
        }

        # Diagnostics for dashboard / ML layer
        if include_diagnostics:
            telemetry["diagnostics"] = {
                "throttle": round(float(out.get("throttle", 0.0)), 3),
                "airspeed_mps": round(float(out.get("airspeed_mps", 0.0)), 1),
                "map_pa": round(float(out.get("map_pa", 101325.0)), 1),
                "ratio_lube": round(float(out.get("ratio_lube", 0.0)), 3),
                "delta_cht_ambient": [round(float(v), 1) for v in out.get("delta_cht_ambient", [0.0]*4)],
                "true_physics": {
                    "rpm": round(true_rpm, 1),
                    "cht_c": [round(v, 1) for v in true_cht],
                    "egt_c": [round(v, 1) for v in true_egt],
                    "oil_temp_c": round(true_oil_temp, 1),
                    "oil_pressure_bar": round(true_oil_press_bar, 2),
                }
            }

        return telemetry
