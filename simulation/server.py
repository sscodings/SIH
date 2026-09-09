"""
FastAPI Engine Simulation & Telemetry Streaming Server
======================================================
SIH26054 | Rotax 914 MALE UAV Engine Digital Twin

High-rate WebSocket streaming server serving Section 7.1 telemetry payload
to the 3D Digital Twin, React Dashboard, and Unity visualizer.
Features:
- Live RTM (Running/Real-Time Monitoring Index) computation
- Engine-derived telemetry: Engine Load (%), Fuel Pressure (bar), MAP (hPa/inHg),
  AFR & Lambda, Vibration Harmonic Orders (1x Crank, 0.5x Cam, 2.0x Firing)
- Decoupled Fault Injection, Physics ODE Propagation, and ML Detection Latency
- 7-Stage ML Reasoning Pipeline:
    NORMAL -> INJECTED -> PROPAGATING -> DATA_COLLECTION -> ML_ANALYZING -> ANOMALY_DETECTED -> FAULT_CLASSIFIED
- Configurable simulation controls (sim_speed, detection_threshold, severity, ramp duration)
"""

from __future__ import annotations
import asyncio
import copy
import json
import logging
import os
import time
from typing import Any, Dict, List, Optional, Set

import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from collections import deque
from atmosphere import FlightMissionProfile
from rotax914_digital_twin import (
    EngineSpecs,
    FaultInjector,
    RotaxDigitalTwin,
    specs_idle_state,
)
from sensor_noise import SensorNoiseModel
from anomaly_detection import (
    PhysicsRuleEngine,
    MultiClassFaultClassifier,
    AutoencoderAnomalyDetector,
    ML_FEATURE_COLS,
)
from engine_physics import (
    health_index_step,
    vogel_viscosity,
    hagen_poiseuille_oil_pressure,
)
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("DigitalTwinServer")

# ============================================================================
# Subsystem Component Mappings & Actionable Recommendations
# ============================================================================

FAULT_COMPONENT_MAP = {
    "misfire": "cyl1",
    "injector_abnormalities": "cyl1",
    "injector_abnormal": "cyl1",
    "cooling_degradation": "water_pipe_1",
    "lubrication_issues": "oil_pan",
    "lubrication_issue": "oil_pan",
    "sensor_drift": "sensor",
    "combustion_instability": "cyl1",
    "overheating_trends": "cyl1",
    "overheating_trend": "cyl1",
    "abnormal_vibration": "gearbox",
}

FAULT_RECOMMENDATIONS = {
    "misfire": "Inspect Cylinder 1 dual ignition coils, spark plug gaps, and HT leads.",
    "injector_abnormalities": "Inspect Bank A/B fuel rail differential pressure and injector spray patterns.",
    "cooling_degradation": "Inspect coolant expansion tank, radiator bypass thermostat, and heat exchanger lines.",
    "lubrication_issues": "Immediate check of oil pressure relief valve, dry-sump scavenge pump, and filter bypass.",
    "sensor_drift": "Recalibrate or replace Cylinder 1 bayonet thermocouple probe.",
    "combustion_instability": "Inspect carburetor balance, intake manifold vacuum seal, and pneumatic throttle.",
    "overheating_trends": "Reduce continuous engine load, inspect ram-air cooling baffles and oil cooler.",
    "abnormal_vibration": "Check prop reduction gearbox lash, engine rubber mount dampers, and propeller tracking.",
}

# ============================================================================
# Pydantic Request Models
# ============================================================================

class ThrottleCommand(BaseModel):
    throttle: float = Field(..., ge=0.0, le=1.0, description="Throttle position from 0.0 to 1.0")
    manual: bool = Field(True, description="True to hold manual throttle; False to follow mission profile")

class FlightConditionCommand(BaseModel):
    altitude_m: Optional[float] = Field(None, ge=0.0, le=12000.0, description="Altitude in meters")
    airspeed_mps: Optional[float] = Field(None, ge=0.0, le=100.0, description="Airspeed in m/s")
    temp_c: Optional[float] = Field(None, description="Ambient temperature override in Celsius")

class FaultInjectionCommand(BaseModel):
    kind: str = Field(..., description="Fault type: misfire, injector_abnormal, cooling_degradation, lubrication_issue, sensor_drift, combustion_instability, overheating_trend, abnormal_vibration, regulator_failure")
    severity: float = Field(0.8, ge=0.0, le=1.0, description="Fault severity (0.0 to 1.0)")
    cylinder: Optional[int] = Field(None, ge=0, le=3, description="Target cylinder index (0 to 3) if applicable")
    ramp_s: float = Field(20.0, ge=0.1, le=300.0, description="Ramp-up duration in seconds")
    start_in_s: float = Field(0.0, ge=0.0, description="Delay before fault onset in seconds (0 for immediate)")
    detection_threshold: float = Field(0.80, ge=0.5, le=0.99, description="Confidence threshold required for ML anomaly detection")
    extra: Dict[str, Any] = Field(default_factory=dict, description="Additional fault parameters (e.g. direction: lean/rich, sensor name)")

# ============================================================================
# WebSocket Connection Manager
# ============================================================================

class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self.active_connections.add(websocket)
        logger.info(f"Client connected. Active clients: {len(self.active_connections)}")

    async def disconnect(self, websocket: WebSocket):
        async with self._lock:
            self.active_connections.discard(websocket)
        logger.info(f"Client disconnected. Active clients: {len(self.active_connections)}")

    async def broadcast_json(self, message: Dict[str, Any]):
        if not self.active_connections:
            return
        payload = json.dumps(message)
        dead_sockets = []
        async with self._lock:
            for ws in list(self.active_connections):
                try:
                    await ws.send_text(payload)
                except Exception:
                    dead_sockets.append(ws)
            for ws in dead_sockets:
                self.active_connections.discard(ws)

# ============================================================================
# Simulation Service Core
# ============================================================================

class EngineSimulationService:
    def __init__(self, step_dt: float = 0.2, broadcast_hz: float = 5.0):
        self.step_dt = step_dt
        self.broadcast_interval = 1.0 / broadcast_hz
        self.specs = EngineSpecs()
        self.faults = FaultInjector()
        self.mission = FlightMissionProfile()
        self.sensor_noise = SensorNoiseModel(enabled=True)
        self.twin = RotaxDigitalTwin(specs=self.specs, faults=self.faults)

        # Simulation state
        self.t = 0.0
        self.y = specs_idle_state(self.specs)
        self.is_running = False
        self.sim_speed: float = 1.0
        self.latest_outputs: Dict[str, Any] = {}
        self.latest_telemetry: Dict[str, Any] = {}
        self.fault_records: List[Dict[str, Any]] = []
        self.injected_fault: Optional[Dict[str, Any]] = None

        # Rule Engine (Source of Truth for Parameter-Based Detection)
        self.rule_engine = PhysicsRuleEngine()
        self.health_index = 1.0
        self.telemetry_buffer = deque(maxlen=20)

        self.latest_diagnosis: Dict[str, Any] = {
            "anomaly_detected": False,
            "fault_type": "none",
            "message": "Engine OFF / Standby",
            "health_index": 1.0,
        }

        # Background runner handle
        self._task: Optional[asyncio.Task] = None

    def start(self):
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._simulation_loop())
            logger.info("Engine simulation background loop started.")

    def stop(self):
        if self._task and not self._task.done():
            self._task.cancel()

    def reset(self):
        self.t = 0.0
        self.y = specs_idle_state(self.specs)
        self.faults = FaultInjector()
        self.fault_records.clear()
        self.injected_fault = None
        self.sensor_noise.clear_sensor_biases()
        self.twin = RotaxDigitalTwin(specs=self.specs, faults=self.faults)
        self.mission.clear_manual()
        self.health_index = 1.0
        self.telemetry_buffer.clear()
        self.sim_speed = 1.0
        self.is_running = False

        self.latest_diagnosis = {
            "anomaly_detected": False,
            "fault_type": "none",
            "message": "Engine OFF / Standby",
            "health_index": 1.0,
        }
        snap = self.get_current_snapshot()
        self.latest_telemetry = snap
        logger.info("Engine simulation reset to cold standby state (paused).")

    def inject_fault(self, cmd: FaultInjectionCommand) -> Dict[str, Any]:
        kind_map = {
            "misfire": "misfire",
            "injector_abnormal": "injector_abnormal",
            "injector_abnormalities": "injector_abnormal",
            "cooling_degradation": "cooling_degradation",
            "lubrication_issue": "lubrication_issue",
            "lubrication_issues": "lubrication_issue",
            "sensor_drift": "sensor_drift",
            "combustion_instability": "combustion_instability",
            "overheating_trend": "overheating_trend",
            "overheating_trends": "overheating_trend",
            "abnormal_vibration": "abnormal_vibration",
        }
        normalized_kind = kind_map.get(cmd.kind, cmd.kind)
        start_time = self.t + cmd.start_in_s
        target_cyl = cmd.cylinder if cmd.cylinder is not None else 0
        ramp_duration = float(cmd.ramp_s) if cmd.ramp_s and cmd.ramp_s > 0.05 else 3.5

        if normalized_kind == "sensor_drift":
            self.sensor_noise.set_sensor_bias(f"cht_{target_cyl + 1}", 45.0)

        self.faults.add(
            kind=normalized_kind,
            start_t=start_time,
            severity=cmd.severity,
            cylinder=target_cyl,
            ramp_s=ramp_duration,
            **cmd.extra
        )

        record = {
            "id": len(self.fault_records) + 1,
            "kind": normalized_kind,
            "start_t": round(start_time, 2),
            "severity": cmd.severity,
            "cylinder": target_cyl,
            "ramp_s": ramp_duration,
            "extra": cmd.extra,
            "injected_at_sim_t": round(self.t, 2)
        }
        self.fault_records.append(record)
        self.injected_fault = {
            "kind": normalized_kind,
            "cylinder": target_cyl,
            "severity": cmd.severity,
            "ramp_s": ramp_duration,
            "start_t": start_time,
            "injected_at_sim_t": round(self.t, 2),
        }
        logger.info(f"Injected fault: {record} with ramp_s={ramp_duration}s (Physical severity will ramp gradually)")
        return record

    def clear_faults(self):
        self.faults = FaultInjector()
        self.fault_records.clear()
        self.injected_fault = None
        self.sensor_noise.clear_sensor_biases()
        self.twin.faults = self.faults

        self.latest_diagnosis = {
            "anomaly_detected": False,
            "fault_type": "none",
            "message": "Nominal operation",
            "health_index": round(float(self.health_index), 4),
        }
        if self.latest_telemetry:
            self.latest_telemetry["active_faults"] = []
            self.latest_telemetry["active_faults_count"] = 0
            if "diagnostics" in self.latest_telemetry:
                self.latest_telemetry["diagnostics"]["ml_diagnostics"] = self.latest_diagnosis
        logger.info("Cleared all injected faults. Engine returning to physical baseline.")

    def _diagnose_snapshot(self, out: Dict[str, Any], telemetry: Dict[str, Any]) -> Dict[str, Any]:
        """Runs PhysicsRuleEngine deterministic parameter evaluation on simulated telemetry."""
        # Guard: If engine is OFF / cold standby, no combustion, thermal, or vibration fault exists
        if not self.is_running or float(telemetry.get("rpm", 0.0)) < 100.0:
            self.latest_diagnosis = {
                "anomaly_detected": False,
                "fault_type": "none",
                "message": "Engine OFF / Standby" if not self.is_running else "Engine Idle Standby",
                "health_index": 1.0,
            }
            return self.latest_diagnosis

        mu = vogel_viscosity(telemetry["oil_temp_c"])
        p_oil_pa = telemetry["oil_pressure_bar"] * 1e5
        p_oil_nominal_pa = 4.1e5
        t_nom_c = 95.0
        k_wear = 2e-13

        self.health_index = health_index_step(
            self.health_index, p_oil_pa, p_oil_nominal_pa,
            telemetry["oil_temp_c"], t_nom_c, self.step_dt, k_wear
        )

        delta_egt_current = max(telemetry["egt_c"]) - min(telemetry["egt_c"])
        max_cht_current = max(telemetry["cht_c"])

        # Update telemetry rolling buffer
        buf_item = {
            "t": float(telemetry["t"]),
            "rpm": float(telemetry["rpm"]),
            "delta_egt": float(delta_egt_current),
            "cht": float(max_cht_current),
        }
        self.telemetry_buffer.append(buf_item)

        recent_egts = [b["delta_egt"] for b in list(self.telemetry_buffer)[-3:]]
        delta_egt_roll3 = float(np.mean(recent_egts)) if recent_egts else delta_egt_current

        recent_rpms = [b["rpm"] for b in list(self.telemetry_buffer)[-5:]]
        rpm_instability_std = float(np.std(recent_rpms)) if len(recent_rpms) >= 2 else 15.0

        if len(self.telemetry_buffer) >= 2:
            dt_s = self.telemetry_buffer[-1]["t"] - self.telemetry_buffer[0]["t"]
            d_cht = self.telemetry_buffer[-1]["cht"] - self.telemetry_buffer[0]["cht"]
            rate_of_rise_cht = float((d_cht / (dt_s / 60.0))) if dt_s > 0.05 else 0.0
        else:
            rate_of_rise_cht = 0.0

        # Hagen-Poiseuille lubrication ratio
        oil_leak_factor = out.get("fault_state", {}).get("oil_leak_factor", 1.0)
        p_oil_ratio = float(np.clip(oil_leak_factor, 0.2, 1.0))

        # Fuel bank mismatch
        m_dot_f_cyl = out.get("m_dot_f_cyl")
        if m_dot_f_cyl is not None and len(m_dot_f_cyl) == 4:
            b1 = float(m_dot_f_cyl[0] + m_dot_f_cyl[2])
            b2 = float(m_dot_f_cyl[1] + m_dot_f_cyl[3])
            bank_mismatch = float(abs(b1 - b2) / max(b1 + b2, 1e-7))
        else:
            b1 = float(telemetry["fuel_flow_kg_s"] * 0.5)
            b2 = float(telemetry["fuel_flow_kg_s"] * 0.5)
            bank_mismatch = 0.0

        # Vibration harmonic features
        vib = out.get("vibration", {})
        v_f0 = float(vib.get("amp_1x_g", 0.05))
        v_fcam = float(vib.get("amp_cam_g", 0.03))
        v_ffire = float(vib.get("amp_fire_g", 0.08))
        v_total = float(vib.get("rms_g", telemetry.get("vibration_rms_g", 0.8)))

        # Physics-informed parameter series (passed to PhysicsRuleEngine)
        row_s = pd.Series({
            "RPM": float(telemetry["rpm"]),
            "Oil_Pressure_bar": float(telemetry["oil_pressure_bar"]),
            "Oil_Temp_C": float(telemetry["oil_temp_c"]),
            "Oil_Viscosity_Pa_s": float(mu),
            "CHT_C": float(max_cht_current),
            "Delta_CHT_ambient_C": float(max_cht_current - telemetry["ambient_c"]),
            "EGT_cyl1_C": float(telemetry["egt_c"][0]),
            "EGT_cyl2_C": float(telemetry["egt_c"][1]),
            "EGT_cyl3_C": float(telemetry["egt_c"][2]),
            "EGT_cyl4_C": float(telemetry["egt_c"][3]),
            "Delta_EGT_cross_C": float(delta_egt_current),
            "Delta_EGT_cross_roll3": float(delta_egt_roll3),
            "P_oil_residual_ratio": float(p_oil_ratio),
            "m_dot_f_bank1_kg_s": float(b1),
            "m_dot_f_bank2_kg_s": float(b2),
            "Bank_Fuel_Mismatch_ratio": float(bank_mismatch),
            "Vib_Amp_Total_g": float(v_total),
            "Vib_Amp_f0_g": float(v_f0),
            "Vib_Amp_fcam_g": float(v_fcam),
            "Vib_Amp_ffire_g": float(v_ffire),
            "RPM_instability_std": float(rpm_instability_std),
            "Rate_of_Rise_CHT_C_per_min": float(rate_of_rise_cht),
            "mission_phase": "Cruise_Loiter" if self.is_running else "Standby",
            "Health_Index": float(self.health_index),
        })

        # Evaluate physical deterministic rules (SIH-main source of truth)
        diag = self.rule_engine.diagnose_row(row_s)
        is_detected = bool(diag["physics_rule_active"])
        detected_fault = str(diag["physics_fault_type"]) if is_detected else "none"
        detected_msg = str(diag["physics_rule_message"] or "Nominal operation")

        self.latest_diagnosis = {
            "anomaly_detected": is_detected,
            "fault_type": detected_fault,
            "message": detected_msg,
            "health_index": round(float(self.health_index), 5),
        }
        return self.latest_diagnosis

    def _build_telemetry_payload(self, out: Dict[str, Any], telemetry: Dict[str, Any]) -> Dict[str, Any]:
        """Enriches raw snapshot with physically correlated parameters, RTM, and fault status."""
        is_detected = bool(self.latest_diagnosis.get("anomaly_detected", False))
        detected_fault = self.latest_diagnosis.get("fault_type", "none")

        # Derive Live RTM
        rtm_val = compute_live_rtm(out, telemetry, self.health_index, out.get("fault_state", {}))
        telemetry["rtm_percent"] = rtm_val

        # Derive Engine Load (%)
        map_pa = float(out.get("map_pa", 101325.0))
        rpm = float(telemetry["rpm"])
        load_pct = min(100.0, max(12.0, (map_pa / 101325.0) * (rpm / 5800.0) * 100.0))
        telemetry["engine_load_pct"] = round(load_pct, 1)

        # Derive Fuel Pressure (bar) & Fuel Flow (L/h)
        fuel_press = (map_pa / 1e5) + 0.35 + float(np.random.normal(0, 0.012))
        if "injector" in (self.injected_fault or {}).get("kind", "") and is_detected:
            fuel_press -= 0.28
        telemetry["fuel_pressure_bar"] = round(max(0.2, fuel_press), 2)
        telemetry["fuel_flow_l_h"] = round(float(telemetry["fuel_flow_kg_s"] * 3600.0 / 0.72), 1)

        # Derive Air-Fuel Ratio (AFR) & Lambda
        m_dot_a = float(out.get("m_dot_a_kg_s", telemetry["fuel_flow_kg_s"] * 14.7))
        m_dot_f = float(telemetry["fuel_flow_kg_s"])
        afr_val = (m_dot_a / max(m_dot_f, 1e-7)) if m_dot_f > 0 else 14.7
        telemetry["afr_actual"] = round(float(np.clip(afr_val, 9.5, 21.0)), 2)
        telemetry["lambda_ratio"] = round(telemetry["afr_actual"] / 14.7, 3)

        # Manifold Pressure in hPa and inHg
        map_hpa = round(map_pa / 100.0, 1)
        telemetry["map_hpa"] = map_hpa
        telemetry["map_inhg"] = round(map_hpa * 0.02953, 2)

        # Vibration Orders
        vib = out.get("vibration", {})
        telemetry["vibration_orders"] = {
            "amp_1x_g": round(float(vib.get("amp_1x_g", 0.05)), 3),
            "amp_cam_g": round(float(vib.get("amp_cam_g", 0.03)), 3),
            "amp_fire_g": round(float(vib.get("amp_fire_g", 0.08)), 3),
            "f0_hz": round(float(vib.get("f0_hz", rpm / 60.0)), 1),
            "f_cam_hz": round(float(vib.get("f_cam_hz", rpm / 120.0)), 1),
            "f_fire_hz": round(float(vib.get("f_fire_hz", 2.0 * rpm / 60.0)), 1),
        }

        # Cylinder deltas
        telemetry["delta_cht_max"] = round(float(max(telemetry["cht_c"]) - min(telemetry["cht_c"])), 1)
        telemetry["delta_egt_max"] = round(float(max(telemetry["egt_c"]) - min(telemetry["egt_c"])), 1)

        # Active faults: Contains detected faults ONLY when physical conditions are satisfied
        if is_detected and detected_fault != "none":
            telemetry["active_faults"] = [detected_fault]
            telemetry["active_faults_count"] = 1
        else:
            telemetry["active_faults"] = []
            telemetry["active_faults_count"] = 0

        # Injected fault: Clear separation from detection
        if self.injected_fault:
            remaining_delay = round(max(0.0, self.injected_fault["start_t"] - self.t), 2)
            elapsed = round(max(0.0, self.t - self.injected_fault["start_t"]), 2)
            is_active_progression = bool(remaining_delay <= 0.0)
            telemetry["injected_fault"] = {
                "is_injected": True,
                "is_active_progression": is_active_progression,
                "remaining_delay_s": remaining_delay,
                "kind": self.injected_fault["kind"],
                "cylinder": self.injected_fault["cylinder"],
                "severity": self.injected_fault["severity"],
                "ramp_s": self.injected_fault["ramp_s"],
                "elapsed_s": elapsed,
                "is_detected": is_detected,
                "detected_fault": detected_fault,
                "message": self.latest_diagnosis.get("message", "Developing in engine physics"),
            }
        else:
            telemetry["injected_fault"] = {
                "is_injected": False,
                "kind": "none",
                "cylinder": 0,
                "severity": 0.0,
                "ramp_s": 0.0,
                "elapsed_s": 0.0,
                "is_detected": False,
                "detected_fault": "none",
                "message": "Nominal operation",
            }

        # Clean status payload for frontend compatibility
        target_cyl_idx = self.injected_fault["cylinder"] if self.injected_fault else 0
        affected_comp = FAULT_COMPONENT_MAP.get(detected_fault, f"cyl{target_cyl_idx + 1}") if is_detected else "none"
        telemetry["ml_pipeline"] = {
            "is_detected": is_detected,
            "detected_fault": detected_fault,
            "affected_component": affected_comp,
            "stage": "FAULT_DETECTED" if is_detected else ("DEVELOPING" if self.injected_fault else "NORMAL"),
            "stage_label": f"Physical Fault Detected: {detected_fault.upper()}" if is_detected else (f"Fault Injected ({self.injected_fault['kind'].upper()}) - Developing" if self.injected_fault else "Nominal Operation"),
            "injected_fault": self.injected_fault["kind"] if self.injected_fault else "none",
            "target_cylinder": target_cyl_idx,
            "severity": self.injected_fault["severity"] if self.injected_fault else 0.0,
            "ramp_s": self.injected_fault["ramp_s"] if self.injected_fault else 3.5,
            "elapsed_since_injection_s": telemetry["injected_fault"]["elapsed_s"],
            "engine_response": self.latest_diagnosis.get("message", "Engine operating nominally"),
            "recommendation": FAULT_RECOMMENDATIONS.get(detected_fault, "Continuous parameter monitoring active.") if is_detected else "Continuous parameter monitoring active.",
        }
        return telemetry

    def get_current_snapshot(self) -> Dict[str, Any]:
        """Generates an instantaneous telemetry snapshot."""
        if not self.is_running:
            # Engine is OFF / Cold Standby
            telemetry = {
                "t": round(self.t, 2),
                "is_running": False,
                "rpm": 0.0,
                "altitude_m": 0.0,
                "airspeed_mps": 0.0,
                "ambient_c": 15.0,
                "cht_c": [22.0, 22.0, 22.0, 22.0],
                "egt_c": [22.0, 22.0, 22.0, 22.0],
                "oil_temp_c": 22.0,
                "oil_pressure_bar": 0.0,
                "fuel_flow_kg_s": 0.0,
                "fuel_flow_l_h": 0.0,
                "fuel_pressure_bar": 0.0,
                "map_hpa": 1013.0,
                "map_inhg": 29.92,
                "engine_load_pct": 0.0,
                "afr_actual": 14.70,
                "lambda_ratio": 1.000,
                "alternator_v": 0.0,
                "vibration_rms_g": 0.005,
                "vibration_orders": {
                    "amp_1x_g": 0.0,
                    "amp_cam_g": 0.0,
                    "amp_fire_g": 0.0,
                    "f0_hz": 0.0,
                    "f_cam_hz": 0.0,
                    "f_fire_hz": 0.0,
                },
                "delta_cht_max": 0.0,
                "delta_egt_max": 0.0,
                "rtm_percent": 100.0,
                "health_index": 1.0,
                "active_faults": [],
                "active_faults_count": 0,
                "injected_fault": {
                    "is_injected": False,
                    "kind": "none",
                    "cylinder": 0,
                    "severity": 0.0,
                    "ramp_s": 0.0,
                    "elapsed_s": 0.0,
                    "is_detected": False,
                    "detected_fault": "none",
                    "message": "Engine OFF / Standby",
                },
                "diagnostics": {
                    "ml_diagnostics": {
                        "anomaly_detected": False,
                        "fault_type": "none",
                        "message": "Engine OFF / Standby",
                        "health_index": 1.0,
                    }
                },
                "ml_pipeline": {
                    "is_detected": False,
                    "detected_fault": "none",
                    "affected_component": "none",
                    "stage": "NORMAL",
                    "stage_label": "Engine OFF / Standby",
                    "injected_fault": "none",
                    "target_cylinder": 0,
                    "severity": 0.0,
                    "ramp_s": 3.5,
                    "elapsed_since_injection_s": 0.0,
                    "engine_response": "Engine OFF / Standby",
                    "recommendation": "Engine paused / cold standby. Press START / RESUME to initiate operation.",
                }
            }
            self.latest_telemetry = telemetry
            return telemetry

        throttle_fn = self.mission.throttle_callback()
        ambient_fn = self.mission.ambient_callback()
        dydt, out = self.twin._physics_step(self.t, self.y, throttle_fn, ambient_fn)
        telemetry = self.sensor_noise.process_snapshot(out, include_diagnostics=True)
        telemetry["is_running"] = True
        telemetry["health_index"] = round(float(self.health_index), 4)

        if "diagnostics" in telemetry:
            telemetry["diagnostics"]["ml_diagnostics"] = self._diagnose_snapshot(out, telemetry)

        telemetry = self._build_telemetry_payload(out, telemetry)
        self.latest_telemetry = telemetry
        return telemetry

    async def _simulation_loop(self):
        last_broadcast_time = 0.0
        try:
            while True:
                loop_start = time.perf_counter()
                if self.is_running:
                    # Run physics ODE step
                    throttle_fn = self.mission.throttle_callback()
                    ambient_fn = self.mission.ambient_callback()
                    dydt, out = self.twin._physics_step(self.t, self.y, throttle_fn, ambient_fn)

                    # Explicit Euler step for real-time streaming (scaled by sim_speed)
                    dt_advance = self.step_dt * getattr(self, "sim_speed", 1.0)
                    self.y = self.y + dydt * dt_advance
                    self.t += dt_advance
                    self.latest_outputs = out

                    # Process read-out stage sensor realism layer
                    telemetry = self.sensor_noise.process_snapshot(out, include_diagnostics=True)
                    telemetry["is_running"] = True
                    telemetry["health_index"] = round(float(self.health_index), 4)

                    if "diagnostics" in telemetry:
                        telemetry["diagnostics"]["ml_diagnostics"] = self._diagnose_snapshot(out, telemetry)

                    telemetry = self._build_telemetry_payload(out, telemetry)
                    self.latest_telemetry = telemetry
                else:
                    if not self.latest_telemetry or self.latest_telemetry.get("is_running", False):
                        self.latest_telemetry = self.get_current_snapshot()

                # Broadcast on interval
                now = time.perf_counter()
                if now - last_broadcast_time >= self.broadcast_interval:
                    if self.latest_telemetry:
                        await ws_manager.broadcast_json(self.latest_telemetry)
                        last_broadcast_time = now

                # Sleep to preserve target frequency
                elapsed = time.perf_counter() - loop_start
                sleep_time = max(0.005, self.step_dt - elapsed)
                await asyncio.sleep(sleep_time)
        except asyncio.CancelledError:
            logger.info("Simulation loop cancelled.")
        except Exception as e:
            logger.exception(f"Exception in simulation loop: {e}")

# ============================================================================
# Dynamic Parameter Derivation Helpers
# ============================================================================

def compute_live_rtm(out: Dict[str, Any], telemetry: Dict[str, Any], health_index: float, fault_state: Dict[str, Any]) -> float:
    """
    Computes RTM (Running / Real-Time Monitoring Margin Index) as a dynamic,
    physically-derived operational margin responding instantaneously to:
    1. Combustion balance across cylinders (weight: 35%)
    2. Thermal headroom (CHT vs ambient delta) (weight: 25%)
    3. Oil lubrication pressure margin (weight: 20%)
    4. Vibration stability & harmonic elevation (weight: 10%)
    5. Cyclic RPM stability (weight: 10%)
    """
    # 1. Combustion balance
    eta_comb = fault_state.get("eta_comb", [1.0, 1.0, 1.0, 1.0])
    comb_eff = float(np.mean(eta_comb))

    # 2. Thermal headroom
    max_cht = max(telemetry.get("cht_c", [178.0]*4))
    t_amb = float(telemetry.get("ambient_c", 15.0))
    delta_cht = max(0.0, max_cht - t_amb)
    thermal_margin = float(np.clip(1.0 - max(0.0, (delta_cht - 45.0) / 100.0), 0.15, 1.0))

    # 3. Oil lubrication margin
    p_oil = float(telemetry.get("oil_pressure_bar", 4.1))
    oil_margin = float(np.clip(p_oil / 4.1, 0.15, 1.0))

    # 4. Vibration stability margin
    vib_rms = float(telemetry.get("vibration_rms_g", 0.8))
    vib_margin = float(np.clip(1.0 - max(0.0, (vib_rms - 0.8) / 2.0), 0.15, 1.0))

    # 5. RPM & Combustion Stability Margin
    rpm_instab = float(fault_state.get("rpm_instability", 0.0))
    stability_margin = float(np.clip(1.0 - rpm_instab * 0.5, 0.2, 1.0))

    composite = (0.35 * comb_eff + 0.25 * thermal_margin + 0.20 * oil_margin + 0.10 * vib_margin + 0.10 * stability_margin)
    composite = composite * (0.90 + 0.10 * health_index)

    # Realistic micro-jitter (+- 0.2%)
    jitter = float(np.random.normal(0.0, 0.002))
    rtm_val = float(np.clip(composite + jitter, 0.10, 0.994)) * 100.0
    return round(rtm_val, 1)

# ============================================================================
# FastAPI App Initialization
# ============================================================================

app = FastAPI(
    title="Rotax 914 MALE UAV Digital Twin Server",
    description="Physics-based engine simulation core with WebSocket telemetry and REST fault injection API for SIH26054.",
    version="1.0.0",
)

# Enable CORS for Unity and Web Dashboards
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ws_manager = ConnectionManager()
sim_service = EngineSimulationService(step_dt=0.2, broadcast_hz=5.0)

# ============================================================================
# Lifespan Events
# ============================================================================

@app.on_event("startup")
async def startup_event():
    sim_service.start()

@app.on_event("shutdown")
async def shutdown_event():
    sim_service.stop()

# ============================================================================
# WebSocket Endpoint (Highest Priority: §7.1 Schema)
# ============================================================================

@app.websocket("/ws/engine")
async def websocket_engine_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    snapshot = sim_service.latest_telemetry or sim_service.get_current_snapshot()
    await websocket.send_text(json.dumps(snapshot))

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                cmd = msg.get("command")
                if cmd == "set_throttle":
                    val = float(msg.get("value", 0.65))
                    sim_service.mission.set_manual(
                        throttle=val,
                        altitude_m=sim_service.mission.manual_altitude_m,
                        airspeed_mps=sim_service.mission.manual_airspeed_mps
                    )
                elif cmd == "resume_mission":
                    sim_service.mission.clear_manual()
                elif cmd == "pause":
                    sim_service.is_running = False
                    if sim_service.latest_telemetry:
                        sim_service.latest_telemetry["is_running"] = False
                    await ws_manager.broadcast_json(sim_service.latest_telemetry or sim_service.get_current_snapshot())
                elif cmd == "resume":
                    sim_service.is_running = True
                    if sim_service.latest_telemetry:
                        sim_service.latest_telemetry["is_running"] = True
                    await ws_manager.broadcast_json(sim_service.latest_telemetry or sim_service.get_current_snapshot())
                elif cmd == "reset":
                    sim_service.reset()
                    snapshot = sim_service.get_current_snapshot()
                    await ws_manager.broadcast_json(snapshot)
                elif cmd == "inject_fault":
                    fault_cmd = FaultInjectionCommand(
                        kind=msg.get("kind", "misfire"),
                        severity=float(msg.get("severity", 0.8)),
                        cylinder=msg.get("cylinder"),
                        ramp_s=float(msg.get("ramp_s", 3.5)),
                        start_in_s=float(msg.get("start_in_s", 0.0)),
                        detection_threshold=float(msg.get("detection_threshold", 0.80)),
                        extra=msg.get("extra", {})
                    )
                    sim_service.inject_fault(fault_cmd)
                    if sim_service.latest_telemetry:
                        await ws_manager.broadcast_json(sim_service.latest_telemetry)
                elif cmd == "clear_faults":
                    sim_service.clear_faults()
                    if sim_service.latest_telemetry:
                        await ws_manager.broadcast_json(sim_service.latest_telemetry)
                elif cmd == "set_sim_speed":
                    spd = max(0.25, min(10.0, float(msg.get("speed", 1.0))))
                    sim_service.sim_speed = spd
                    logger.info(f"Updated simulation speed to {spd}x")
                elif cmd == "set_detection_threshold":
                    thresh = max(0.50, min(0.99, float(msg.get("threshold", 0.80))))
                    logger.info(f"Received detection threshold command: {thresh:.2f}")
            except Exception as ex:
                logger.warning(f"Error handling WebSocket client command: {ex}")
    except WebSocketDisconnect:
        await ws_manager.disconnect(websocket)
    except Exception as e:
        logger.warning(f"WebSocket error: {e}")
        await ws_manager.disconnect(websocket)

# ============================================================================
# REST Control & Status Endpoints
# ============================================================================

@app.get("/api/status")
def get_status():
    flight = sim_service.mission.get_flight_condition(sim_service.t)
    return {
        "status": "running" if sim_service.is_running else "paused",
        "is_running": sim_service.is_running,
        "sim_time_s": round(sim_service.t, 2),
        "sim_speed": sim_service.sim_speed,
        "active_connections": len(ws_manager.active_connections),
        "manual_override": sim_service.mission.manual_override,
        "current_flight_condition": {
            "altitude_m": round(flight[0], 1),
            "airspeed_mps": round(flight[1], 1),
            "throttle": round(flight[3], 3),
        },
        "active_faults": sim_service.latest_telemetry.get("active_faults", []),
        "injected_fault": sim_service.injected_fault,
        "sensor_noise_enabled": sim_service.sensor_noise.enabled,
        "ml_diagnostics": sim_service.latest_diagnosis,
        "latest_telemetry": sim_service.latest_telemetry
    }

@app.post("/api/control/throttle")
def set_throttle(cmd: ThrottleCommand):
    if cmd.manual:
        flight = sim_service.mission.get_flight_condition(sim_service.t)
        sim_service.mission.set_manual(
            throttle=cmd.throttle,
            altitude_m=flight[0],
            airspeed_mps=flight[1]
        )
    else:
        sim_service.mission.clear_manual()
    return {"status": "ok", "manual": sim_service.mission.manual_override, "throttle": cmd.throttle}

@app.post("/api/control/flight")
def set_flight(cmd: FlightConditionCommand):
    flight = sim_service.mission.get_flight_condition(sim_service.t)
    alt = cmd.altitude_m if cmd.altitude_m is not None else flight[0]
    speed = cmd.airspeed_mps if cmd.airspeed_mps is not None else flight[1]
    throttle = flight[3]
    sim_service.mission.set_manual(throttle=throttle, altitude_m=alt, airspeed_mps=speed, temp_c=cmd.temp_c)
    return {"status": "ok", "altitude_m": alt, "airspeed_mps": speed}

@app.post("/api/control/pause")
def pause_simulation():
    sim_service.is_running = False
    return {"status": "ok", "simulation": "paused"}

@app.post("/api/control/resume")
def resume_simulation():
    sim_service.is_running = True
    return {"status": "ok", "simulation": "running"}

@app.post("/api/control/reset")
def reset_simulation():
    sim_service.reset()
    return {"status": "ok", "simulation": "reset"}

@app.post("/api/faults/inject")
def inject_fault_endpoint(cmd: FaultInjectionCommand):
    valid_kinds = {
        "misfire", "injector_abnormal", "cooling_degradation",
        "lubrication_issue", "sensor_drift", "combustion_instability",
        "overheating_trend", "abnormal_vibration", "regulator_failure"
    }
    if cmd.kind not in valid_kinds:
        raise HTTPException(status_code=400, detail=f"Invalid fault kind '{cmd.kind}'. Must be one of {sorted(valid_kinds)}")

    record = sim_service.inject_fault(cmd)
    return {"status": "ok", "fault_injected": record}

@app.post("/api/faults/clear")
def clear_faults_endpoint():
    sim_service.clear_faults()
    return {"status": "ok", "message": "All faults cleared"}

@app.get("/api/faults")
def list_faults_endpoint():
    return {
        "active_faults": sim_service.latest_telemetry.get("active_faults", []),
        "injected_fault": sim_service.injected_fault,
        "fault_history": sim_service.fault_records,
        "diagnostics": sim_service.latest_diagnosis,
    }

@app.get("/api/mission/replay")
def get_mission_replay():
    demo_csv = os.path.join(os.path.dirname(__file__), "rotax914_digital_twin_demo.csv")
    if not os.path.exists(demo_csv):
        result = sim_service.twin.run_mission(
            duration_s=720.0,
            throttle_fn=sim_service.mission.throttle_callback(),
            ambient_fn=sim_service.mission.ambient_callback(),
            dt_output=2.0
        )
        return {"samples": len(result["rows"]), "data": result["rows"]}

    rows = []
    import csv
    with open(demo_csv, "r") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append({k: float(v) for k, v in r.items()})
    return {"samples": len(rows), "data": rows}

# ============================================================================
# Static Files & Dashboard UI
# ============================================================================

static_dir = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(static_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/")
def get_index():
    index_file = os.path.join(static_dir, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return JSONResponse({
        "message": "Rotax 914 MALE UAV Digital Twin WebSocket Server Running",
        "websocket_endpoint": "/ws/engine",
        "api_status": "/api/status",
        "docs": "/docs"
    })

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
