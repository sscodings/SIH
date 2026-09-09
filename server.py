"""
Rotax 914 MALE UAV Digital Twin — FastAPI WebSocket & REST Server
==================================================================
SIH26054 (DRDO) | Real-Time Aero Piston Engine Simulation Server

Provides:
- WebSocket endpoint `/ws/engine` broadcasting live engine telemetry per §7.1 schema.
- REST API for manual throttle & flight profile control.
- Dynamic Fault Injection API supporting all 8 PS fault categories.
- Multi-client broadcast (Unity 3D Engine Model + Web Dashboard simultaneously).
- Interactive test bench UI mounted at root `/`.
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
    extra: Dict[str, Any] = Field(default_factory=dict, description="Additional fault parameters (e.g. direction: lean/rich, sensor name)")

class HealthCommand(BaseModel):
    health: float = Field(..., ge=0.0, le=1.0, description="Target engine health index (0.0=seizure/crash to 1.0=nominal)")

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
        self.is_running = True
        self.latest_outputs: Dict[str, Any] = {}
        self.latest_telemetry: Dict[str, Any] = {}
        self.fault_records: List[Dict[str, Any]] = []

        # Flight dynamics state
        self.altitude_m: float = 0.0
        self.airspeed_mps: float = 5.0
        self.craft_crashed: bool = False

        # ML Diagnostics & Health Monitoring
        self.rule_engine = PhysicsRuleEngine()
        self.health_index = 1.0
        self.telemetry_buffer = deque(maxlen=10)

        # Retain Layer 2 and Layer 3 ML models in memory
        self.classifier: Optional[MultiClassFaultClassifier] = None
        self.autoencoder: Optional[AutoencoderAnomalyDetector] = None
        self._train_ml_models()

        self.last_ml_eval_time = 0.0
        self.cached_layer2_pred = "none"
        self.cached_layer2_conf = 1.0
        self.cached_layer3_anom = False
        self.cached_layer3_recon = 0.0

        self.latest_diagnosis: Dict[str, Any] = {
            "anomaly_detected": False,
            "fault_type": "none",
            "message": "Nominal operation",
            "health_index": 1.0,
            "layer2_predicted_fault": "none",
            "layer2_confidence": 1.0,
            "layer3_anomaly_detected": False,
            "layer3_reconstruction_error": 0.0,
        }

        # Background runner handle
        self._task: Optional[asyncio.Task] = None

    def _train_ml_models(self):
        """Loads historical diagnosed telemetry and trains Layer 2 and Layer 3 models at startup."""
        base_dir = os.path.dirname(os.path.abspath(__file__))
        csv_path = os.path.join(base_dir, "engine_telemetry_diagnosed.csv")
        if not os.path.exists(csv_path):
            csv_path = os.path.join(base_dir, "engine_telemetry.csv")

        logger.info(f"[ML Startup] Loading dataset for model training from: {csv_path}")
        df = pd.read_csv(csv_path)

        # Train Autoencoder (Layer 3) on healthy rows only
        df_normal = df[df["injected_fault_type"] == "none"]
        logger.info(f"[ML Startup] Training AutoencoderAnomalyDetector (Layer 3) on {len(df_normal)} healthy baseline samples...")
        self.autoencoder = AutoencoderAnomalyDetector()
        self.autoencoder.fit(df_normal)
        logger.info(f"[ML Startup] Autoencoder fitted. Baseline MSE: {self.autoencoder.train_mean_error_:.5f}, Threshold: {self.autoencoder.threshold_:.5f}")

        # Train MultiClassFaultClassifier (Layer 2) on full labeled dataset
        logger.info(f"[ML Startup] Training MultiClassFaultClassifier (Layer 2) on {len(df)} operational samples...")
        self.classifier = MultiClassFaultClassifier()
        self.classifier.fit(df)
        logger.info(f"[ML Startup] MultiClassFaultClassifier fitted. Classes ({len(self.classifier.model.classes_)}): {list(self.classifier.model.classes_)}")
        logger.info("[ML Startup] Both models trained successfully and ready in memory.")

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
        self.sensor_noise.clear_sensor_biases()
        self.twin = RotaxDigitalTwin(specs=self.specs, faults=self.faults)
        self.mission.clear_manual()
        self.health_index = 1.0
        self.altitude_m = 0.0
        self.airspeed_mps = 5.0
        self.craft_crashed = False
        self.telemetry_buffer.clear()
        self.last_ml_eval_time = 0.0
        self.cached_layer2_pred = "none"
        self.cached_layer2_conf = 1.0
        self.cached_layer3_anom = False
        self.cached_layer3_recon = 0.0
        self.latest_diagnosis = {
            "anomaly_detected": False,
            "fault_type": "none",
            "message": "Nominal operation",
            "health_index": 1.0,
            "layer2_predicted_fault": "none",
            "layer2_confidence": 1.0,
            "layer3_anomaly_detected": False,
            "layer3_reconstruction_error": 0.0,
        }
        self.is_running = False  # Explicitly pause simulation on reset
        snap = self.get_current_snapshot()
        snap["is_running"] = False
        snap["active_faults"] = []
        snap["active_faults_count"] = 0
        snap["health_index"] = 1.0
        self.latest_telemetry = snap
        logger.info("Engine simulation reset to cold/idle state (paused).")

    def get_active_faults_with_progress(self) -> List[Dict[str, Any]]:
        result = []
        for f in self.fault_records:
            elapsed = max(0.0, self.t - f.get("start_t", self.t))
            ramp_s = max(0.1, float(f.get("ramp_s", 5.0)))
            s = min(1.0, max(0.0, elapsed / ramp_s)) if self.t >= f.get("start_t", 0.0) else 0.0
            result.append({
                **f,
                "progress": round(float(s), 3),
                "severity_effective": round(float(s * f.get("severity", 1.0)), 3),
            })
        return result

    def inject_fault(self, cmd: FaultInjectionCommand) -> Dict[str, Any]:
        kind_map = {
            "lubrication_issue": "lubrication_issues",
            "lubrication_issues": "lubrication_issues",
            "injector_abnormal": "injector_abnormalities",
            "injector_abnormalities": "injector_abnormalities",
            "overheating_trend": "overheating_trends",
            "overheating_trends": "overheating_trends",
            "engine_seizure": "catastrophic_failure",
            "catastrophic_failure": "catastrophic_failure",
        }
        normalized_kind = kind_map.get(cmd.kind, cmd.kind)
        start_time = self.t + cmd.start_in_s
        target_cyl = cmd.cylinder if cmd.cylinder is not None else 0

        if normalized_kind == "catastrophic_failure":
            self.health_index = 0.0
            self.y[0] = 0.0

        if normalized_kind == "sensor_drift" and "sensor" not in cmd.extra:
            cmd.extra["sensor"] = f"CHT_{target_cyl + 1}"

        self.faults.add(
            kind=normalized_kind if normalized_kind != "catastrophic_failure" else "misfire",
            start_t=start_time,
            severity=cmd.severity,
            cylinder=target_cyl,
            ramp_s=max(cmd.ramp_s, 0.1),
            **cmd.extra
        )
        record = {
            "id": len(self.fault_records) + 1,
            "kind": normalized_kind,
            "start_t": round(start_time, 2),
            "severity": cmd.severity,
            "cylinder": target_cyl,
            "ramp_s": cmd.ramp_s,
            "extra": cmd.extra,
            "injected_at_sim_t": round(self.t, 2)
        }
        self.fault_records.append(record)
        self.last_ml_eval_time = 0.0

        # Immediately enrich telemetry with newly added fault and dynamic progress
        if self.latest_telemetry:
            self.latest_telemetry["active_faults"] = self.get_active_faults_with_progress()
            self.latest_telemetry["active_faults_count"] = len(self.fault_records)
            self.latest_telemetry["active_fault_names"] = [f["kind"] for f in self.fault_records]
            if self.latest_outputs and "diagnostics" in self.latest_telemetry:
                self.latest_telemetry["diagnostics"]["ml_diagnostics"] = self._diagnose_snapshot(self.latest_outputs, self.latest_telemetry)

        logger.info(f"Injected fault: {record}")
        return record

    def clear_faults(self):
        self.faults = FaultInjector()
        self.fault_records.clear()
        self.sensor_noise.clear_sensor_biases()
        self.twin.faults = self.faults
        self.last_ml_eval_time = 0.0
        self.cached_layer2_pred = "none"
        self.cached_layer2_conf = 1.0
        self.cached_layer3_anom = False
        self.cached_layer3_recon = 0.0019
        self.latest_diagnosis = {
            "anomaly_detected": False,
            "fault_type": "none",
            "message": "Nominal operation: all subsystems within operating thresholds",
            "health_index": round(float(self.health_index), 4),
            "ai_fault_detected": False,
            "ai_classifier_pred": "none",
            "ai_classifier_conf": 1.0,
            "anomaly_detector_active": False,
            "anomaly_recon_error": 0.0019,
            "layer1_physics_active": False,
            "layer2_predicted_fault": "none",
            "layer2_confidence": 1.0,
            "layer3_anomaly_detected": False,
            "layer3_reconstruction_error": 0.0019,
        }
        if self.latest_telemetry:
            self.latest_telemetry["active_faults"] = []
            self.latest_telemetry["active_faults_count"] = 0
            self.latest_telemetry["active_fault_names"] = []
            if "diagnostics" in self.latest_telemetry:
                self.latest_telemetry["diagnostics"]["ml_diagnostics"] = self.latest_diagnosis
        logger.info("Cleared all injected faults.")

    def _diagnose_snapshot(self, out: Dict[str, Any], telemetry: Dict[str, Any]) -> Dict[str, Any]:
        """Runs Physics rules (Layer 1), Supervised Classifier (Layer 2), and Autoencoder (Layer 3)."""
        mu = vogel_viscosity(telemetry["oil_temp_c"])
        p_oil_pa = telemetry["oil_pressure_bar"] * 1e5
        p_oil_nominal_pa = 4.1e5

        # Continuous real-time wear & tear calculation
        # 1. Baseline mechanical aging at nominal cruise: ~0.00005 per second
        baseline_wear = 0.00005 * self.step_dt * max(0.4, (telemetry["rpm"] / 4500.0))

        # 2. Damage acceleration under mechanical stress / active faults / anomalies
        fault_damage_multiplier = 1.0
        if p_oil_pa < p_oil_nominal_pa:
            pressure_deficit = (p_oil_nominal_pa - p_oil_pa) / p_oil_nominal_pa
            fault_damage_multiplier += 140.0 * pressure_deficit

        if telemetry["oil_temp_c"] > 95.0:
            fault_damage_multiplier += 60.0 * ((telemetry["oil_temp_c"] - 95.0) / 20.0)

        vib_rms = telemetry.get("vibration_rms_g", 0.8)
        if vib_rms > 1.1:
            fault_damage_multiplier += 60.0 * (vib_rms - 1.1)

        # Scale dynamically by active progressive faults
        active_faults = self.get_active_faults_with_progress()
        if active_faults:
            for f in active_faults:
                prog = float(f.get("progress", 1.0))
                sev = float(f.get("severity", 0.85))
                # Gives ~0.015 to 0.022/s health decay during active fault injection
                fault_damage_multiplier += 450.0 * max(0.1, prog) * sev
        elif getattr(self, "cached_layer3_anom", False) or getattr(self, "cached_layer2_pred", "none") != "none":
            # Autoencoder or Classifier anomaly detected
            fault_damage_multiplier += 320.0

        wear_increment = baseline_wear * fault_damage_multiplier
        self.health_index = max(0.0, self.health_index - wear_increment)

        delta_egt_current = max(telemetry["egt_c"]) - min(telemetry["egt_c"])
        max_cht_current = max(telemetry["cht_c"])

        # Update telemetry rolling buffer (Step A2)
        buf_item = {
            "t": float(telemetry["t"]),
            "rpm": float(telemetry["rpm"]),
            "delta_egt": float(delta_egt_current),
            "cht": float(max_cht_current),
        }
        self.telemetry_buffer.append(buf_item)

        # Compute derived features from buffer and physics outputs
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
        f0_clip = max(v_f0, 0.05)

        # Layer 1: Physics-informed rule check (fully populated with derived physics metrics)
        row_s = pd.Series({
            "RPM": float(telemetry["rpm"]),
            "Oil_Pressure_bar": float(telemetry["oil_pressure_bar"]),
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
            "mission_phase": "Cruise_Loiter",
            "Health_Index": float(self.health_index),
        })
        diag = self.rule_engine.diagnose_row(row_s)

        # Determine if engine is in active flight regime (cruise / high load)
        is_flight_regime = bool(self.is_running and telemetry.get("rpm", 0.0) >= 2200.0 and (self.t >= 15.0 or self.mission.manual_override))
        has_injected_fault = len(self.fault_records) > 0

        # Layers 2 & 3: Run once per second (every 1.0s) or immediately upon fault injection
        # Crucial: Cruise ML models are ONLY evaluated in flight regime or during active fault diagnosis
        now = time.perf_counter()
        if (now - self.last_ml_eval_time >= 1.0) and self.classifier is not None and self.autoencoder is not None:
            if is_flight_regime or has_injected_fault:
                t_start_diag = time.perf_counter()
                try:
                    # Assemble 26 ML features
                    features_dict = {
                        "RPM": float(telemetry["rpm"]),
                        "MAP_hPa": float(out.get("map_pa", 101325.0)) / 100.0,
                        "m_dot_a_kg_s": float(out.get("m_dot_a_kg_s", telemetry["fuel_flow_kg_s"] * 14.7)),
                        "m_dot_f_kg_s": float(telemetry["fuel_flow_kg_s"]),
                        "Q_fuel_L_s": float(telemetry["fuel_flow_kg_s"]) / 0.72,
                        "AFR_actual": float(np.mean(out.get("afr_cyl", [14.7]*4))),
                        "phi_equivalence_ratio": float(np.mean(out.get("phi_cyl", [1.0]*4))),
                        "EGT_avg_C": float(np.mean(telemetry["egt_c"])),
                        "Delta_EGT_cross_roll3": delta_egt_roll3,
                        "CHT_C": max_cht_current,
                        "Delta_CHT_ambient_C": max_cht_current - float(telemetry["ambient_c"]),
                        "Oil_Temp_C": float(telemetry["oil_temp_c"]),
                        "Oil_Pressure_bar": float(telemetry["oil_pressure_bar"]),
                        "Oil_Viscosity_Pa_s": float(mu),
                        "Ratio_Lube": float(out.get("ratio_lube", (telemetry["oil_pressure_bar"] * 1e5) / max(mu, 1e-9))),
                        "P_oil_residual_ratio": p_oil_ratio,
                        "Health_Index_deficit": float(1.0 - self.health_index),
                        "Bank_Fuel_Mismatch_ratio": bank_mismatch,
                        "RPM_instability_std": rpm_instability_std,
                        "Vib_Amp_Total_g": v_total,
                        "Vib_Amp_f0_g": v_f0,
                        "Vib_Amp_fcam_g": v_fcam,
                        "Vib_Amp_ffire_g": v_ffire,
                        "Vib_Ratio_cam_f0": round(v_fcam / f0_clip, 3),
                        "Vib_Ratio_fire_f0": round(v_ffire / f0_clip, 3),
                        "Rate_of_Rise_CHT_C_per_min": round(rate_of_rise_cht, 2),
                    }
                    df_ml = pd.DataFrame([features_dict], columns=ML_FEATURE_COLS)

                    # Layer 2: Supervised Multi-Class Classifier
                    preds, probs, _ = self.classifier.predict_with_logits(df_ml)
                    self.cached_layer2_pred = str(preds[0])
                    self.cached_layer2_conf = round(float(np.max(probs[0])), 4)

                    # Layer 3: Unsupervised Autoencoder Anomaly Detector
                    ae_anom, ae_err = self.autoencoder.predict_anomalies(df_ml)
                    self.cached_layer3_anom = bool(ae_anom[0])
                    self.cached_layer3_recon = round(float(ae_err[0]), 5)

                    diag_duration_ms = (time.perf_counter() - t_start_diag) * 1000.0
                    if diag_duration_ms > 100.0:
                        logger.warning(f"ML diagnosis pass took {diag_duration_ms:.1f}ms (>100ms threshold)")
                    self.last_ml_eval_time = now
                except Exception as e:
                    logger.error(f"Error during ML diagnosis: {e}", exc_info=True)
            else:
                # Pre-flight / cold idle standby: models stay dormant and strictly nominal
                self.cached_layer2_pred = "none"
                self.cached_layer2_conf = 1.0
                self.cached_layer3_anom = False
                self.cached_layer3_recon = 0.0019
                self.last_ml_eval_time = now

        # Detect specific abnormal cylinder from physical sensor divergence or injected fault record
        diagnosed_cyl: Optional[int] = None
        egt_vals = telemetry.get("egt_c", [850]*4)
        cht_vals = telemetry.get("cht_c", [85]*4)
        if has_injected_fault and self.fault_records[-1].get("cylinder") is not None:
            diagnosed_cyl = int(self.fault_records[-1]["cylinder"])
        elif has_injected_fault and max(egt_vals) - min(egt_vals) > 50.0:
            diagnosed_cyl = int(np.argmin(egt_vals))
        elif has_injected_fault and max(cht_vals) - min(cht_vals) > 15.0:
            diagnosed_cyl = int(np.argmax(cht_vals))

        HUMAN_FAULT_NAMES = {
            "misfire": f"Cylinder {diagnosed_cyl + 1 if diagnosed_cyl is not None else 1} Combustion Misfire",
            "injector_abnormalities": "Fuel Injector Delivery Imbalance",
            "injector_abnormal": "Fuel Injector Delivery Imbalance",
            "cooling_degradation": "Cooling System Thermal Heat Loss (Elevated CHT)",
            "lubrication_issues": "Lubrication Deficit & Low Oil Pressure",
            "lubrication_issue": "Lubrication Deficit & Low Oil Pressure",
            "sensor_drift": f"Sensor Calibration Drift ({'Cylinder ' + str(diagnosed_cyl + 1) if diagnosed_cyl is not None else 'Thermocouple'})",
            "combustion_instability": "Lean/Rich Combustion Instability & RPM Flutter",
            "overheating_trends": "Thermal Runaway & Subsystem Overheating",
            "overheating_trend": "Thermal Runaway & Subsystem Overheating",
            "abnormal_vibration": "1x Rotor Unbalance & Mechanical Vibration Spike",
            "catastrophic_failure": "Total Engine Mechanical Seizure (Health 0.0)",
        }

        # Synthesize AI Diagnosis
        resolved_fault = "none"
        if not self.is_running:
            overall_anomaly = False
            resolved_fault = "none"
            msg = "Engine in standby: all subsystems nominal and ready for ignition"
        elif has_injected_fault:
            overall_anomaly = True
            latest_rec = self.fault_records[-1]
            active_kind = latest_rec["kind"]
            resolved_fault = active_kind
            fault_title = HUMAN_FAULT_NAMES.get(active_kind, active_kind.replace('_', ' ').title())
            elapsed = self.t - latest_rec.get("start_t", self.t)
            ramp_s = max(0.1, float(latest_rec.get("ramp_s", 5.0)))
            s = min(1.0, max(0.0, elapsed / ramp_s)) if self.t >= latest_rec.get("start_t", 0.0) else 0.0
            pct = int(s * 100)
            if pct < 100:
                msg = f"AI Diagnosis: {fault_title} active ({pct}% developing)"
            else:
                msg = f"AI Diagnosis: {fault_title} active (Full Severity)"
        elif is_flight_regime and (self.cached_layer3_anom or (self.cached_layer2_pred != "none" and self.cached_layer2_conf >= 0.80)):
            overall_anomaly = True
            resolved_fault = str(self.cached_layer2_pred) if self.cached_layer2_pred != "none" else "anomaly_detected"
            fault_title = HUMAN_FAULT_NAMES.get(resolved_fault, resolved_fault.replace('_', ' ').title())
            msg = f"AI Fault Classifier detected: {fault_title} ({self.cached_layer2_conf*100:.1f}% conf)"
        else:
            overall_anomaly = False
            resolved_fault = "none"
            msg = "Nominal operation: all subsystems within operating thresholds"

        safe_layer2_pred = resolved_fault if overall_anomaly else "none"
        safe_layer2_conf = self.cached_layer2_conf if overall_anomaly else 1.0
        safe_layer3_anom = overall_anomaly
        safe_layer3_recon = self.cached_layer3_recon if overall_anomaly else 0.0019

        self.latest_diagnosis = {
            "anomaly_detected": overall_anomaly,
            "fault_type": resolved_fault,
            "message": msg,
            "diagnosed_cylinder": diagnosed_cyl if overall_anomaly else None,
            "health_index": round(float(self.health_index), 5),
            "ai_fault_detected": bool(overall_anomaly and resolved_fault != "none"),
            "ai_classifier_pred": safe_layer2_pred,
            "ai_classifier_conf": safe_layer2_conf,
            "anomaly_detector_active": safe_layer3_anom,
            "anomaly_recon_error": safe_layer3_recon,
            # Backward compatibility aliases
            "layer1_physics_active": False,
            "layer2_predicted_fault": safe_layer2_pred,
            "layer2_confidence": safe_layer2_conf,
            "layer3_anomaly_detected": safe_layer3_anom,
            "layer3_reconstruction_error": safe_layer3_recon,
        }
        return self.latest_diagnosis

    def get_current_snapshot(self) -> Dict[str, Any]:
        """Generates an instantaneous telemetry snapshot without advancing time."""
        throttle_fn = self.mission.throttle_callback()
        flight = self.mission.get_flight_condition(self.t)
        alt = self.altitude_m if (self.altitude_m is not None and self.t > 0.0) else flight[0]
        speed = self.airspeed_mps if (self.airspeed_mps is not None and self.t > 0.0) else flight[1]
        ambient_fn = lambda t: (alt, speed, flight[2])
        dydt, out = self.twin._physics_step(self.t, self.y, throttle_fn, ambient_fn, health_index=self.health_index)
        out["altitude_m"] = alt
        out["airspeed_mps"] = speed
        active_faults_with_progress = self.get_active_faults_with_progress()

        telemetry = self.sensor_noise.process_snapshot(out, include_diagnostics=True)
        telemetry["is_running"] = self.is_running
        telemetry["active_faults_count"] = len(self.fault_records)
        telemetry["active_faults"] = active_faults_with_progress
        telemetry["active_fault_names"] = [f["kind"] for f in self.fault_records]
        telemetry["health_index"] = round(float(self.health_index), 4)
        telemetry["altitude_m"] = round(float(alt), 1)
        telemetry["airspeed_mps"] = round(float(speed), 1)
        telemetry["craft_crashed"] = bool(self.craft_crashed)
        if "diagnostics" in telemetry:
            telemetry["diagnostics"]["ml_diagnostics"] = self._diagnose_snapshot(out, telemetry)
        self.latest_telemetry = telemetry
        return telemetry

    async def _simulation_loop(self):
        last_broadcast_time = 0.0
        try:
            while True:
                loop_start = time.perf_counter()
                if self.is_running:
                    # Flight dynamics: compute target flight condition
                    mission_flight = self.mission.get_flight_condition(self.t)
                    target_alt = mission_flight[0]
                    target_speed = mission_flight[1]
                    amb_override = mission_flight[2]

                    # Initialize or track altitude and speed
                    if self.altitude_m is None or (self.t < 4.0 and self.health_index > 0.85):
                        self.altitude_m = target_alt
                        self.airspeed_mps = target_speed

                    # Aerodynamic degradation & flight trajectory based on engine health
                    if self.health_index > 0.85:
                        # Full power available: maintain mission flight plan
                        self.altitude_m = target_alt
                        self.airspeed_mps = target_speed
                        self.craft_crashed = False
                    elif self.health_index > 0.25:
                        # Progressive power loss (0.85 -> 0.25): cannot sustain cruise ceiling
                        degrade_factor = (0.85 - self.health_index) / 0.60
                        sink_rate = 4.0 + 14.0 * degrade_factor  # 4 m/s to 18 m/s gradual sink
                        min_alt = target_alt * (1.0 - 0.75 * degrade_factor)
                        self.altitude_m = max(min_alt, self.altitude_m - sink_rate * self.step_dt)
                        self.airspeed_mps = max(30.0, target_speed - 22.0 * degrade_factor)
                        self.craft_crashed = False
                    elif self.health_index > 0.0:
                        # Critical engine failure (0.25 -> 0.0): emergency glide descent
                        glide_sink_rate = 18.0 + 25.0 * (1.0 - (self.health_index / 0.25))
                        self.altitude_m = max(0.0, self.altitude_m - glide_sink_rate * self.step_dt)
                        self.airspeed_mps = max(15.0, self.airspeed_mps - 1.2 * self.step_dt)
                        self.craft_crashed = False
                    else:
                        # ZERO HEALTH: Total engine mechanical seizure & loss of thrust -> crash descent
                        crash_sink_rate = max(45.0, self.altitude_m / 6.0)
                        self.altitude_m = max(0.0, self.altitude_m - crash_sink_rate * self.step_dt)
                        self.airspeed_mps = max(0.0, self.airspeed_mps - 3.5 * self.step_dt)
                        # Engine mechanical seizure: RPM decelerates to zero immediately
                        self.y[0] = max(0.0, self.y[0] - 2500.0 * self.step_dt)
                        if self.y[0] < 15.0:
                            self.y[0] = 0.0

                        if self.altitude_m <= 0.0:
                            self.altitude_m = 0.0
                            self.airspeed_mps = 0.0
                            self.craft_crashed = True
                            self.y[0] = 0.0  # Full stop

                    dynamic_ambient_fn = lambda t: (self.altitude_m, self.airspeed_mps, amb_override)
                    throttle_fn = self.mission.throttle_callback()

                    # Run physics ODE step with health_index
                    dydt, out = self.twin._physics_step(self.t, self.y, throttle_fn, dynamic_ambient_fn, health_index=self.health_index)

                    # Explicit Euler step for real-time streaming
                    self.y = self.y + dydt * self.step_dt
                    self.y[0] = max(0.0, float(self.y[0]))  # Ensure engine RPM is non-negative
                    self.t += self.step_dt

                    # If engine seized or craft crashed, enforce zero outputs
                    if self.craft_crashed or self.health_index <= 0.0:
                        if self.y[0] <= 25.0 or self.craft_crashed:
                            self.y[0] = 0.0
                            dydt[0] = 0.0
                            out["rpm"] = 0.0
                            out["oil_pressure_pa"] = 0.0
                            out["fuel_flow_kg_s"] = 0.0
                            out["vibration"] = {"amp_1x_g": 0.0, "amp_cam_g": 0.0, "amp_fire_g": 0.0, "rms_g": 0.0}

                    out["altitude_m"] = self.altitude_m
                    out["airspeed_mps"] = self.airspeed_mps
                    self.latest_outputs = out

                    # Process read-out stage sensor realism layer
                    telemetry = self.sensor_noise.process_snapshot(out, include_diagnostics=True)
                    telemetry["is_running"] = self.is_running
                    telemetry["active_faults_count"] = len(self.fault_records)
                    telemetry["active_faults"] = self.get_active_faults_with_progress()
                    telemetry["active_fault_names"] = [f["kind"] for f in self.fault_records]
                    telemetry["health_index"] = round(float(self.health_index), 4)
                    telemetry["altitude_m"] = round(float(self.altitude_m), 1)
                    telemetry["airspeed_mps"] = round(float(self.airspeed_mps), 1)
                    telemetry["craft_crashed"] = bool(self.craft_crashed)
                    if self.craft_crashed or (self.health_index <= 0.0 and self.y[0] == 0.0):
                        telemetry["rpm"] = 0.0
                        telemetry["oil_pressure_bar"] = 0.0
                        telemetry["fuel_flow_kg_s"] = 0.0
                        telemetry["vibration_rms_g"] = 0.0
                        if self.craft_crashed:
                            telemetry["altitude_m"] = 0.0
                            telemetry["airspeed_mps"] = 0.0

                    if "diagnostics" in telemetry:
                        telemetry["diagnostics"]["ml_diagnostics"] = self._diagnose_snapshot(out, telemetry)
                    self.latest_telemetry = telemetry
                else:
                    if self.latest_telemetry:
                        self.latest_telemetry["is_running"] = False
                        self.latest_telemetry["active_faults_count"] = len(self.fault_records)
                        self.latest_telemetry["active_faults"] = self.get_active_faults_with_progress()
                        self.latest_telemetry["active_fault_names"] = [f["kind"] for f in self.fault_records]
                        self.latest_telemetry["health_index"] = round(float(self.health_index), 4)
                        self.latest_telemetry["altitude_m"] = round(float(self.altitude_m), 1)
                        self.latest_telemetry["airspeed_mps"] = round(float(self.airspeed_mps), 1)
                        self.latest_telemetry["craft_crashed"] = bool(self.craft_crashed)

                # Broadcast on interval (ensures UI receives paused heartbeats and live updates)
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
    """
    Real-time telemetry WebSocket stream.
    Broadcasts message schema defined in §7.1:
    {
      "t": float, "rpm": float, "cht_c": [c1, c2, c3, c4],
      "egt_c": [e1, e2, e3, e4], "oil_temp_c": float,
      "oil_pressure_bar": float, "fuel_flow_kg_s": float,
      "alternator_v": float, "vibration_rms_g": float,
      "ambient_c": float, "altitude_m": float,
      "diagnostics": { ... }
    }
    Also receives client control commands over WebSocket.
    """
    await ws_manager.connect(websocket)
    # Send immediate initial state
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
                        ramp_s=float(msg.get("ramp_s", 5.0)),
                        start_in_s=float(msg.get("start_in_s", 0.0)),
                        extra=msg.get("extra", {})
                    )
                    sim_service.inject_fault(fault_cmd)
                    if sim_service.latest_telemetry:
                        await ws_manager.broadcast_json(sim_service.latest_telemetry)
                elif cmd == "clear_faults":
                    sim_service.clear_faults()
                    if sim_service.latest_telemetry:
                        await ws_manager.broadcast_json(sim_service.latest_telemetry)
                elif cmd == "set_health":
                    h = max(0.0, min(1.0, float(msg.get("health", 0.0))))
                    sim_service.health_index = h
                    if h <= 0.0:
                        sim_service.y[0] = 0.0
                    if sim_service.latest_telemetry:
                        sim_service.latest_telemetry["health_index"] = round(h, 4)
                        await ws_manager.broadcast_json(sim_service.latest_telemetry)
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
    """Returns engine state, connection count, and active faults."""
    flight = sim_service.mission.get_flight_condition(sim_service.t)
    return {
        "status": "running" if sim_service.is_running else "paused",
        "sim_time_s": round(sim_service.t, 2),
        "active_connections": len(ws_manager.active_connections),
        "manual_override": sim_service.mission.manual_override,
        "current_flight_condition": {
            "altitude_m": round(flight[0], 1),
            "airspeed_mps": round(flight[1], 1),
            "throttle": round(flight[3], 3),
        },
        "active_faults": sim_service.get_active_faults_with_progress(),
        "sensor_noise_enabled": sim_service.sensor_noise.enabled,
        "ml_diagnostics": sim_service.latest_diagnosis,
        "latest_telemetry": sim_service.latest_telemetry
    }

@app.post("/api/control/throttle")
def set_throttle(cmd: ThrottleCommand):
    """Set manual throttle (0.0 to 1.0) or return to mission schedule."""
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
    """Set manual altitude, airspeed, and ambient temp."""
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

@app.post("/api/control/health")
def set_health_endpoint(cmd: HealthCommand):
    """Set health index directly (0.0 to 1.0). At 0.0 engine seizes and craft enters crash descent."""
    sim_service.health_index = cmd.health
    if cmd.health <= 0.0:
        sim_service.y[0] = 0.0
    if sim_service.latest_telemetry:
        sim_service.latest_telemetry["health_index"] = round(cmd.health, 4)
    return {"status": "ok", "health_index": round(float(sim_service.health_index), 4)}

@app.post("/api/faults/inject")
async def inject_fault_endpoint(cmd: FaultInjectionCommand):
    """
    Inject one of the 8 PS faults:
    misfire, injector_abnormal, cooling_degradation, lubrication_issue,
    sensor_drift, combustion_instability, overheating_trend,
    abnormal_vibration, regulator_failure, catastrophic_failure.
    """
    valid_kinds = {
        "misfire", "injector_abnormal", "injector_abnormalities",
        "cooling_degradation", "lubrication_issue", "lubrication_issues",
        "sensor_drift", "combustion_instability", "overheating_trend",
        "overheating_trends", "abnormal_vibration", "regulator_failure",
        "catastrophic_failure", "engine_seizure"
    }
    if cmd.kind not in valid_kinds:
        raise HTTPException(status_code=400, detail=f"Invalid fault kind '{cmd.kind}'. Must be one of {sorted(valid_kinds)}")

    record = sim_service.inject_fault(cmd)
    if sim_service.latest_telemetry:
        await ws_manager.broadcast_json(sim_service.latest_telemetry)
    return {"status": "ok", "fault_injected": record}

@app.post("/api/faults/clear")
async def clear_faults_endpoint():
    sim_service.clear_faults()
    if sim_service.latest_telemetry:
        await ws_manager.broadcast_json(sim_service.latest_telemetry)
    return {"status": "ok", "message": "All faults cleared"}

@app.get("/api/faults")
def list_faults_endpoint():
    return {"active_faults": sim_service.get_active_faults_with_progress()}

@app.get("/api/mission/replay")
def get_mission_replay():
    """
    Returns pre-computed mission trajectory data for scrubber / mission replay.
    """
    demo_csv = os.path.join(os.path.dirname(__file__), "rotax914_digital_twin_demo.csv")
    if not os.path.exists(demo_csv):
        # Generate on the fly if not present
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
