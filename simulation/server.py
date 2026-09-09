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
        logger.info("Engine simulation reset to cold/idle state.")

    def inject_fault(self, cmd: FaultInjectionCommand) -> Dict[str, Any]:
        kind_map = {
            "lubrication_issue": "lubrication_issues",
            "lubrication_issues": "lubrication_issues",
            "injector_abnormal": "injector_abnormalities",
            "injector_abnormalities": "injector_abnormalities",
            "overheating_trend": "overheating_trends",
            "overheating_trends": "overheating_trends",
        }
        normalized_kind = kind_map.get(cmd.kind, cmd.kind)
        start_time = self.t + cmd.start_in_s
        target_cyl = cmd.cylinder if cmd.cylinder is not None else 0

        if normalized_kind == "sensor_drift":
            self.sensor_noise.set_sensor_bias(f"cht_{target_cyl + 1}", 45.0)

        self.faults.add(
            kind=normalized_kind,
            start_t=start_time,
            severity=cmd.severity,
            cylinder=target_cyl,
            ramp_s=min(cmd.ramp_s, 2.0),
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
        self.cached_layer3_recon = 0.0
        logger.info("Cleared all injected faults.")

    def _diagnose_snapshot(self, out: Dict[str, Any], telemetry: Dict[str, Any]) -> Dict[str, Any]:
        """Runs Physics rules (Layer 1), Supervised Classifier (Layer 2), and Autoencoder (Layer 3)."""
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

        # Layers 2 & 3: Run once per second (every 1.0s) or immediately upon fault injection
        now = time.perf_counter()
        if (now - self.last_ml_eval_time >= 1.0) and self.classifier is not None and self.autoencoder is not None:
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

        self.latest_diagnosis = {
            # existing Layer 1 fields — keep exactly as-is
            "anomaly_detected": bool(diag["physics_rule_active"]),
            "fault_type": str(diag["physics_fault_type"]),
            "message": str(diag["physics_rule_message"] or "Nominal operation"),
            "health_index": round(float(self.health_index), 5),
            # NEW Layer 2 fields
            "layer2_predicted_fault": self.cached_layer2_pred,
            "layer2_confidence": self.cached_layer2_conf,
            # NEW Layer 3 fields
            "layer3_anomaly_detected": self.cached_layer3_anom,
            "layer3_reconstruction_error": self.cached_layer3_recon,
        }
        return self.latest_diagnosis

    def get_current_snapshot(self) -> Dict[str, Any]:
        """Generates an instantaneous telemetry snapshot without advancing time."""
        throttle_fn = self.mission.throttle_callback()
        ambient_fn = self.mission.ambient_callback()
        dydt, out = self.twin._physics_step(self.t, self.y, throttle_fn, ambient_fn)
        telemetry = self.sensor_noise.process_snapshot(out, include_diagnostics=True)
        telemetry["is_running"] = self.is_running
        telemetry["active_faults_count"] = len(self.fault_records)
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
                    # Run physics ODE step
                    throttle_fn = self.mission.throttle_callback()
                    ambient_fn = self.mission.ambient_callback()
                    dydt, out = self.twin._physics_step(self.t, self.y, throttle_fn, ambient_fn)

                    # Explicit Euler step for real-time streaming
                    self.y = self.y + dydt * self.step_dt
                    self.t += self.step_dt
                    self.latest_outputs = out

                    # Process read-out stage sensor realism layer
                    telemetry = self.sensor_noise.process_snapshot(out, include_diagnostics=True)
                    telemetry["is_running"] = self.is_running
                    telemetry["active_faults_count"] = len(self.fault_records)
                    if "diagnostics" in telemetry:
                        telemetry["diagnostics"]["ml_diagnostics"] = self._diagnose_snapshot(out, telemetry)
                    self.latest_telemetry = telemetry
                else:
                    if self.latest_telemetry:
                        self.latest_telemetry["is_running"] = False

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
                        ramp_s=float(msg.get("ramp_s", 20.0)),
                        start_in_s=float(msg.get("start_in_s", 0.0)),
                        extra=msg.get("extra", {})
                    )
                    sim_service.inject_fault(fault_cmd)
                    if sim_service.latest_telemetry:
                        sim_service.latest_telemetry["active_faults_count"] = len(sim_service.fault_records)
                        await ws_manager.broadcast_json(sim_service.latest_telemetry)
                elif cmd == "clear_faults":
                    sim_service.clear_faults()
                    if sim_service.latest_telemetry:
                        sim_service.latest_telemetry["active_faults_count"] = 0
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
        "active_faults": sim_service.fault_records,
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

@app.post("/api/faults/inject")
def inject_fault_endpoint(cmd: FaultInjectionCommand):
    """
    Inject one of the 8 PS faults:
    misfire, injector_abnormal, cooling_degradation, lubrication_issue,
    sensor_drift, combustion_instability, overheating_trend,
    abnormal_vibration, regulator_failure.
    """
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
    return {"active_faults": sim_service.fault_records}

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
