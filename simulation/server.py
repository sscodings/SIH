"""
Rotax 914 MALE UAV Digital Twin — FastAPI WebSocket & REST Server
==================================================================
SIH26054 (DRDO) | Real-Time Aero Piston Engine Simulation Server

Two simulation modes share one WebSocket stream (`sim_mode` in every payload):

- "sandbox": free-running physics twin (rotax914_digital_twin + atmosphere) with the
  manual fault-injection API. Anomalies are detected by comparing measured telemetry
  against a fault-free "expected" twin run in parallel on the same inputs.
- "mission_replay": streams one of the 15 recorded missions from
  engine_telemetry_diagnosed.csv + climate_dataset.csv in time order, with the
  Layer 1/2/3 diagnosis (physics rules, classifier, autoencoder) run live on each row.

Also provides REST control endpoints and the interactive test bench UI at `/`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import time
from typing import Any, Dict, List, Optional, Set

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

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

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("DigitalTwinServer")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ============================================================================
# Tunable demo constants
# ============================================================================

# Sandbox health-index wear model, in health units per second.
BASELINE_WEAR_PER_S = 2.0e-6    # healthy aging while the engine turns: ~0.4% per 30 min
FAULT_WEAR_PER_S = 2.5e-3       # one severity-1.0 fault at 100% development
DEFAULT_FAULT_RAMP_S = 35.0     # seconds for an injected fault to develop from 0% to 100%
# Relative engine damage per fault kind. Measurement/electrical faults don't wear the engine.
FAULT_WEAR_WEIGHT = {
    "misfire": 1.0,
    "injector_abnormalities": 0.8,
    "cooling_degradation": 1.0,
    "lubrication_issues": 1.2,
    "sensor_drift": 0.0,
    "combustion_instability": 1.0,
    "overheating_trends": 0.9,
    "abnormal_vibration": 1.0,
    "regulator_failure": 0.0,
    "catastrophic_failure": 12.0,
}

# Sandbox anomaly detection: |measured - expected twin| limits (~10x sensor-noise sigma).
# A channel alarms only after exceeding its limit for RESIDUAL_PERSIST_TICKS consecutive steps.
RESIDUAL_LIMITS = {
    "rpm": 80.0,
    "cht_c": 8.0,
    "egt_c": 25.0,
    "oil_temp_c": 5.0,
    "oil_pressure_bar": 0.3,
    "fuel_flow_kg_s": 3.0e-4,
    "vibration_rms_g": 0.05,
    "alternator_v": 0.8,
}
RESIDUAL_PERSIST_TICKS = 5

# Mission replay pacing: recorded minutes streamed per real second.
DEFAULT_REPLAY_SPEED = 1.0

# Mission replay health: the recorded Health_Index barely moves (1.0 -> 0.999), so once the
# diagnosis has flagged an anomaly for REPLAY_PERSIST_MIN consecutive recorded minutes, health
# glides toward a per-fault floor, reaching it at landing if the anomaly persists.
REPLAY_HEALTH_FLOOR = {
    "lubrication_issues": 0.70,
    "cooling_degradation": 0.72,
    "overheating_trends": 0.75,
    "misfire": 0.75,
    "abnormal_vibration": 0.75,
    "combustion_instability": 0.78,
    "injector_abnormalities": 0.80,
    "sensor_drift": 0.97,   # measurement fault: the engine itself is not being damaged
}
REPLAY_HEALTH_FLOOR_DEFAULT = 0.85
REPLAY_PERSIST_MIN = 3          # one-row blips (e.g. autoencoder on the single Landing row) don't wear the engine
REPLAY_MIN_GLIDE_MIN = 30.0     # a late-starting anomaly can't collapse health in the final minutes

# Health Summary flight record: detections of the same fault closer together than this form one issue.
ISSUE_MERGE_GAP_S = 180.0
FUEL_DENSITY_KG_L = 0.72        # matches the dashboard's kg/s -> L/h conversion

FAULT_KIND_ALIASES = {
    "lubrication_issue": "lubrication_issues",
    "injector_abnormal": "injector_abnormalities",
    "overheating_trend": "overheating_trends",
    "engine_seizure": "catastrophic_failure",
}
VALID_FAULT_KINDS = set(FAULT_WEAR_WEIGHT) | set(FAULT_KIND_ALIASES)
CYLINDER_FAULTS = {"misfire", "sensor_drift"}

HUMAN_FAULT_NAMES = {
    "injector_abnormalities": "Fuel Injector Delivery Imbalance",
    "cooling_degradation": "Cooling System Heat-Rejection Loss",
    "lubrication_issues": "Lubrication Deficit & Low Oil Pressure",
    "combustion_instability": "Combustion Instability & RPM Flutter",
    "overheating_trends": "Thermal Overheating Trend",
    "abnormal_vibration": "1x Rotor Unbalance Vibration",
    "regulator_failure": "Voltage Regulator Failure",
    "catastrophic_failure": "Catastrophic Mechanical Failure",
    "unclassified_anomaly": "Unclassified Anomaly",
    "twin_residual_deviation": "Deviation From Healthy Twin",
}


def human_fault_name(kind: str, cylinder: Optional[int] = None) -> str:
    cyl = f"Cylinder {cylinder + 1}" if cylinder is not None else None
    if kind == "misfire":
        return f"{cyl} Combustion Misfire" if cyl else "Combustion Misfire"
    if kind == "sensor_drift":
        return f"Sensor Calibration Drift ({cyl + ' CHT' if cyl else 'thermocouple'})"
    return HUMAN_FAULT_NAMES.get(kind, kind.replace("_", " ").title())


def _num(value: Any, digits: int) -> Optional[float]:
    """JSON-safe rounded float (NaN/None -> None, since JSON.parse rejects NaN)."""
    if value is None:
        return None
    v = float(value)
    return None if math.isnan(v) else round(v, digits)


# ============================================================================
# Recorded 15-mission dataset
# ============================================================================

CLIMATE_COLS = [
    "mission_id", "elapsed_min", "mission_type", "weather_profile", "altitude_ft", "OAT_C",
    "pressure_hPa", "air_density_kg_m3", "relative_humidity_pct", "wind_speed_kt", "wind_relative_angle_deg",
]


def load_mission_dataset() -> pd.DataFrame:
    engine = pd.read_csv(os.path.join(BASE_DIR, "engine_telemetry_diagnosed.csv"))
    climate = pd.read_csv(os.path.join(BASE_DIR, "climate_dataset.csv"), usecols=CLIMATE_COLS)
    return engine.merge(climate, on=["mission_id", "elapsed_min"], how="left", validate="one_to_one")


def build_mission_catalog(df: pd.DataFrame) -> List[Dict[str, Any]]:
    catalog = []
    for mission_id, g in df.groupby("mission_id"):
        faulted = g[g["injected_fault_type"] != "none"]
        catalog.append({
            "mission_id": int(mission_id),
            "mission_type": str(g["mission_type"].iloc[0]),
            "weather_profile": str(g["weather_profile"].iloc[0]),
            "duration_min": int(g["elapsed_min"].max()),
            "fault_type": str(faulted["injected_fault_type"].iloc[0]) if len(faulted) else "none",
            "fault_onset_min": int(faulted["elapsed_min"].min()) if len(faulted) else None,
            "fault_end_min": int(faulted["elapsed_min"].max()) if len(faulted) else None,
        })
    return catalog


# Expected-payload key -> dataset column predicted by the fleet baseline.
BASELINE_TARGETS = {
    "rpm": "RPM",
    "cht_c": "CHT_C",
    "egt_c": "EGT_avg_C",
    "oil_temp_c": "Oil_Temp_C",
    "oil_pressure_bar": "Oil_Pressure_bar",
    "fuel_flow_kg_s": "m_dot_f_kg_s",
    "vibration_rms_g": "Vib_Amp_Total_g",
}


class FleetBaseline:
    """Healthy-fleet expectation for replayed rows: per mission phase, each parameter is a
    linear function of outside air temperature and altitude, fitted on fault-free rows."""

    def __init__(self, df: pd.DataFrame):
        healthy = df[df["injected_fault_type"] == "none"]
        self.coefs: Dict[str, Dict[str, np.ndarray]] = {}
        for phase, g in healthy.groupby("mission_phase"):
            X = np.column_stack([np.ones(len(g)), g["OAT_C"], g["altitude_ft"] / 1000.0])
            self.coefs[phase] = {
                key: np.linalg.lstsq(X, g[col].to_numpy(), rcond=None)[0]
                for key, col in BASELINE_TARGETS.items()
            }

    def expected(self, phase: str, oat_c: float, altitude_ft: float) -> Optional[Dict[str, Any]]:
        coefs = self.coefs.get(phase)
        if coefs is None:
            return None
        x = np.array([1.0, oat_c, altitude_ft / 1000.0])
        v = {key: max(0.0, float(x @ b)) for key, b in coefs.items()}
        return {
            "rpm": round(v["rpm"], 1),
            "cht_c": [round(v["cht_c"], 1)] * 4,
            "egt_c": [round(v["egt_c"], 1)] * 4,
            "oil_temp_c": round(v["oil_temp_c"], 1),
            "oil_pressure_bar": round(v["oil_pressure_bar"], 2),
            "fuel_flow_kg_s": round(v["fuel_flow_kg_s"], 5),
            "vibration_rms_g": round(v["vibration_rms_g"], 3),
            "alternator_v": None,
            "source": "fleet_baseline",
        }


def expected_from_physics(out: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "rpm": round(float(out["rpm"]), 1),
        "cht_c": [round(float(v), 1) for v in out["cht_c"]],
        "egt_c": [round(float(v), 1) for v in out["egt_c"]],
        "oil_temp_c": round(float(out["oil_temp_c"]), 1),
        "oil_pressure_bar": round(float(out["oil_pressure_pa"]) / 1e5, 2),
        "fuel_flow_kg_s": round(float(out["fuel_flow_kg_s"]), 5),
        "vibration_rms_g": round(float(out["vibration"]["rms_g"]), 3),
        "alternator_v": round(float(out["alternator_v"]), 2),
        "source": "physics_twin",
    }


# ============================================================================
# Whole-flight record (Health Summary)
# ============================================================================

# Flight-summary channel -> decimals reported. CHT/EGT are the hottest cylinder, as on the dashboard.
FLIGHT_CHANNELS = {
    "rpm": 0,
    "cht_c": 1,
    "egt_c": 1,
    "oil_temp_c": 1,
    "oil_pressure_bar": 2,
    "fuel_flow_lh": 1,
    "vibration_rms_g": 3,
    "altitude_m": 0,
}


def _hottest(values) -> Optional[float]:
    vals = [float(v) for v in values if v is not None and not math.isnan(float(v))]
    return max(vals) if vals else None


def flight_sample_from_row(row: Dict[str, Any]) -> Dict[str, Optional[float]]:
    return {
        "rpm": row["RPM"],
        "cht_c": row["CHT_C"],
        "egt_c": _hottest(row[f"EGT_cyl{i}_C"] for i in range(1, 5)),
        "oil_temp_c": row["Oil_Temp_C"],
        "oil_pressure_bar": row["Oil_Pressure_bar"],
        "fuel_flow_lh": float(row["m_dot_f_kg_s"]) * 3600.0 / FUEL_DENSITY_KG_L,
        "vibration_rms_g": row["Vib_Amp_Total_g"],
        "altitude_m": float(row["altitude_ft"]) * 0.3048,
    }


def flight_sample_from_telemetry(tel: Dict[str, Any]) -> Dict[str, Optional[float]]:
    return {
        "rpm": tel["rpm"],
        "cht_c": _hottest(tel["cht_c"]),
        "egt_c": _hottest(tel["egt_c"]),
        "oil_temp_c": tel["oil_temp_c"],
        "oil_pressure_bar": tel["oil_pressure_bar"],
        "fuel_flow_lh": float(tel["fuel_flow_kg_s"]) * 3600.0 / FUEL_DENSITY_KG_L,
        "vibration_rms_g": tel["vibration_rms_g"],
        "altitude_m": tel["altitude_m"],
    }


class FlightRecorder:
    """Whole-flight record behind the Health Summary: per-channel average/min/max, fuel used,
    health trend and the issues the diagnosis raised, fed one sample at a time."""

    def __init__(self, sample_dt: float, confirm_samples: int):
        self.sample_dt = sample_dt
        # An episode counts as an issue once flagged for this many consecutive samples; shorter ones are transient alerts.
        self.confirm_samples = confirm_samples
        self.t_last: Optional[float] = None
        self.sums = dict.fromkeys(FLIGHT_CHANNELS, 0.0)
        self.counts = dict.fromkeys(FLIGHT_CHANNELS, 0)
        self.mins: Dict[str, float] = {}
        self.maxs: Dict[str, float] = {}
        self.fuel_used_l = 0.0
        self.health_start: Optional[float] = None
        self.health_min: Optional[float] = None
        self.health_now: Optional[float] = None
        self.episodes: List[Dict[str, Any]] = []
        self._latest_episode: Dict[str, Dict[str, Any]] = {}

    def add(self, t: float, sample: Dict[str, Optional[float]], diag: Dict[str, Any], health: float):
        self.t_last = t
        for key, value in sample.items():
            if value is None or math.isnan(float(value)):
                continue
            value = float(value)
            self.sums[key] += value
            self.counts[key] += 1
            self.mins[key] = min(self.mins.get(key, value), value)
            self.maxs[key] = max(self.maxs.get(key, value), value)
            if key == "fuel_flow_lh":
                self.fuel_used_l += value * self.sample_dt / 3600.0

        health = float(health)
        if self.health_start is None:
            self.health_start = health
        self.health_min = health if self.health_min is None else min(self.health_min, health)
        self.health_now = health

        if diag["anomaly_detected"]:
            self._track_issue(t, diag, health)

    def _track_issue(self, t: float, diag: Dict[str, Any], health: float):
        kind = diag["fault_type"]
        episode = self._latest_episode.get(kind)
        if episode is None or t - episode["last_t"] > ISSUE_MERGE_GAP_S:
            episode = {"kind": kind, "first_t": t, "last_t": None, "flagged_s": 0.0, "run": 0, "confirmed": False,
                       "sources": set(), "cylinders": set(), "health_at_onset": health}
            self.episodes.append(episode)
            self._latest_episode[kind] = episode
        consecutive = episode["last_t"] is not None and abs(t - episode["last_t"] - self.sample_dt) < self.sample_dt / 2
        episode["run"] = episode["run"] + 1 if consecutive else 1
        episode["confirmed"] = episode["confirmed"] or episode["run"] >= self.confirm_samples
        episode["last_t"] = t
        episode["flagged_s"] += self.sample_dt
        episode["health_latest"] = health
        if diag.get("detection_source"):
            episode["sources"].add(diag["detection_source"])
        if diag.get("diagnosed_cylinder") is not None:
            episode["cylinders"].add(int(diag["diagnosed_cylinder"]))

    def summary(self, complete: bool) -> Dict[str, Any]:
        stats = {}
        for key, digits in FLIGHT_CHANNELS.items():
            n = self.counts[key]
            stats[key] = None if n == 0 else {
                "avg": round(self.sums[key] / n, digits),
                "min": round(self.mins[key], digits),
                "max": round(self.maxs[key], digits),
            }

        issues = []
        for ep in self.episodes:
            if not ep["confirmed"]:
                continue
            cylinders = sorted(ep["cylinders"])
            issues.append({
                "fault_type": ep["kind"],
                "label": human_fault_name(ep["kind"], cylinders[0] if len(cylinders) == 1 else None),
                "cylinders": [c + 1 for c in cylinders],
                "first_t_s": round(ep["first_t"], 1),
                "last_t_s": round(ep["last_t"], 1),
                "flagged_s": round(ep["flagged_s"], 1),
                "active": ep["last_t"] == self.t_last,
                "detected_by": sorted(ep["sources"]),
                "health_at_onset": round(ep["health_at_onset"], 4),
                "health_latest": round(ep["health_latest"], 4),
            })

        rounded = lambda v: None if v is None else round(v, 4)
        return {
            "flight_time_s": round(self.t_last, 1) if self.t_last is not None else 0.0,
            "complete": bool(complete),
            "stats": stats,
            "fuel_used_l": round(self.fuel_used_l, 1),
            "health": {"start": rounded(self.health_start), "min": rounded(self.health_min), "now": rounded(self.health_now)},
            "issues": issues,
            "transient_alerts": sum(1 for ep in self.episodes if not ep["confirmed"]),
            "issue_min_s": round(self.confirm_samples * self.sample_dt, 1),
            "recorded_label": None,
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
    kind: str = Field(..., description="Fault type: misfire, injector_abnormal, cooling_degradation, lubrication_issue, sensor_drift, combustion_instability, overheating_trend, abnormal_vibration, regulator_failure, catastrophic_failure")
    severity: float = Field(0.8, ge=0.0, le=1.0, description="Fault severity (0.0 to 1.0)")
    cylinder: Optional[int] = Field(None, ge=0, le=3, description="Target cylinder index (0 to 3) if applicable")
    ramp_s: float = Field(DEFAULT_FAULT_RAMP_S, ge=0.1, le=300.0, description="Seconds for the fault to develop from 0% to 100%")
    start_in_s: float = Field(0.0, ge=0.0, description="Delay before fault onset in seconds (0 for immediate)")
    extra: Dict[str, Any] = Field(default_factory=dict, description="Additional fault parameters (e.g. direction: lean/rich, sensor name)")

class HealthCommand(BaseModel):
    health: float = Field(..., ge=0.0, le=1.0, description="Target engine health index (0.0=seizure/crash to 1.0=nominal)")

class MissionSelectCommand(BaseModel):
    mission_id: int = Field(..., ge=1, description="Recorded mission to replay (1-15)")
    speed: Optional[float] = Field(None, gt=0.0, le=120.0, description="Recorded minutes streamed per real second")

class ReplaySpeedCommand(BaseModel):
    speed: float = Field(..., gt=0.0, le=120.0, description="Recorded minutes streamed per real second")

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
        self.mission = FlightMissionProfile()
        self.sensor_noise = SensorNoiseModel(enabled=True)
        self.rule_engine = PhysicsRuleEngine()
        self.fault_records: List[Dict[str, Any]] = []
        self.residual_counts: Dict[str, int] = {}
        self.latest_outputs: Dict[str, Any] = {}
        self.latest_telemetry: Dict[str, Any] = {}

        # Recorded dataset: trains Layer 2/3 and backs mission-replay mode.
        logger.info("[Startup] Loading 15-mission engine + climate dataset...")
        self.dataset = load_mission_dataset()
        self.classifier: Optional[MultiClassFaultClassifier] = None
        self.autoencoder: Optional[AutoencoderAnomalyDetector] = None
        self._train_ml_models()
        self.fleet_baseline = FleetBaseline(self.dataset)
        self.mission_catalog = build_mission_catalog(self.dataset)
        self.mission_info = {m["mission_id"]: m for m in self.mission_catalog}
        self.mission_rows = {
            int(mission_id): g.sort_values("elapsed_min").to_dict("records")
            for mission_id, g in self.dataset.groupby("mission_id")
        }

        self.sim_mode = "sandbox"
        self.replay_mission_id: Optional[int] = None
        self.replay_cursor_min = 0.0
        self.replay_speed = DEFAULT_REPLAY_SPEED
        self._replay_cache: Dict[int, tuple] = {}
        self._replay_recorder: Optional[list] = None   # [mission_id, last fed row, FlightRecorder]

        self._task: Optional[asyncio.Task] = None
        self.reset()

    def _train_ml_models(self):
        df = self.dataset
        df_normal = df[df["injected_fault_type"] == "none"]
        logger.info(f"[ML Startup] Training AutoencoderAnomalyDetector (Layer 3) on {len(df_normal)} healthy baseline samples...")
        self.autoencoder = AutoencoderAnomalyDetector()
        self.autoencoder.fit(df_normal)
        logger.info(f"[ML Startup] Autoencoder fitted. Baseline MSE: {self.autoencoder.train_mean_error_:.5f}, Threshold: {self.autoencoder.threshold_:.5f}")

        logger.info(f"[ML Startup] Training MultiClassFaultClassifier (Layer 2) on {len(df)} operational samples...")
        self.classifier = MultiClassFaultClassifier()
        self.classifier.fit(df)
        logger.info(f"[ML Startup] MultiClassFaultClassifier fitted. Classes ({len(self.classifier.model.classes_)}): {list(self.classifier.model.classes_)}")

    def start(self):
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._simulation_loop())
            logger.info("Engine simulation background loop started.")

    def stop(self):
        if self._task and not self._task.done():
            self._task.cancel()

    # ------------------------------------------------------------------
    # Mode & state control
    # ------------------------------------------------------------------

    def _reset_sandbox_state(self):
        self.t = 0.0
        self.y = specs_idle_state(self.specs)
        self.y_expected = self.y.copy()
        self.faults = FaultInjector()
        self.twin = RotaxDigitalTwin(specs=self.specs, faults=self.faults)
        self.expected_twin = RotaxDigitalTwin(specs=self.specs, faults=FaultInjector())
        self.fault_records.clear()
        self.residual_counts.clear()
        self.sensor_noise.clear_sensor_biases()
        self.mission.clear_manual()
        self.health_index = 1.0
        self.altitude_m = 0.0
        self.airspeed_mps = 5.0
        self.craft_crashed = False
        # The residual detector is already persistence-filtered, so every sandbox detection episode is an issue.
        self.flight_recorder = FlightRecorder(sample_dt=self.step_dt, confirm_samples=1)

    def reset(self):
        """Cold/paused state. Sandbox: engine back on the runway. Replay: rewind to minute 0."""
        self.is_running = False
        if self.sim_mode == "mission_replay":
            self.replay_cursor_min = 0.0
        else:
            self._reset_sandbox_state()
        self.latest_telemetry = self.get_current_snapshot()
        logger.info(f"Simulation reset ({self.sim_mode}, paused).")

    def select_sandbox(self):
        self.sim_mode = "sandbox"
        self.replay_mission_id = None
        self.reset()

    def select_mission(self, mission_id: int, speed: Optional[float] = None):
        if mission_id not in self.mission_rows:
            raise KeyError(mission_id)
        self._reset_sandbox_state()
        self.sim_mode = "mission_replay"
        self.replay_mission_id = mission_id
        self.replay_cursor_min = 0.0
        if speed is not None:
            self.replay_speed = float(speed)
        self.is_running = True
        self.latest_telemetry = self.get_current_snapshot()
        logger.info(f"Mission replay started: mission {mission_id} at {self.replay_speed} recorded min/s.")

    def set_replay_speed(self, speed: float):
        self.replay_speed = float(speed)
        if self.latest_telemetry.get("replay"):
            self.latest_telemetry["replay"]["speed"] = self.replay_speed

    # ------------------------------------------------------------------
    # Sandbox fault injection
    # ------------------------------------------------------------------

    def get_active_faults_with_progress(self) -> List[Dict[str, Any]]:
        result = []
        for f in self.fault_records:
            elapsed = self.t - f["start_t"]
            progress = min(1.0, max(0.0, elapsed / max(0.1, float(f["ramp_s"]))))
            result.append({
                **f,
                "progress": round(progress, 3),
                "severity_effective": round(progress * f["severity"], 3),
            })
        return result

    def inject_fault(self, cmd: FaultInjectionCommand) -> Dict[str, Any]:
        kind = FAULT_KIND_ALIASES.get(cmd.kind, cmd.kind)
        start_time = self.t + cmd.start_in_s
        target_cyl = cmd.cylinder if cmd.cylinder is not None else 0

        if kind == "sensor_drift" and "sensor" not in cmd.extra:
            cmd.extra["sensor"] = f"CHT_{target_cyl + 1}"

        # Catastrophic failure is driven by its high wear weight; physically it presents as a misfire.
        self.faults.add(
            kind="misfire" if kind == "catastrophic_failure" else kind,
            start_t=start_time,
            severity=cmd.severity,
            cylinder=target_cyl,
            ramp_s=cmd.ramp_s,
            **cmd.extra
        )
        record = {
            "id": len(self.fault_records) + 1,
            "kind": kind,
            "start_t": round(start_time, 2),
            "severity": cmd.severity,
            "cylinder": target_cyl,
            "ramp_s": cmd.ramp_s,
            "extra": cmd.extra,
            "injected_at_sim_t": round(self.t, 2),
        }
        self.fault_records.append(record)

        if self.latest_telemetry:
            self.latest_telemetry["active_faults"] = self.get_active_faults_with_progress()
            self.latest_telemetry["active_faults_count"] = len(self.fault_records)
            self.latest_telemetry["active_fault_names"] = [f["kind"] for f in self.fault_records]

        logger.info(f"Injected fault: {record}")
        return record

    def clear_faults(self):
        """Maintenance reset: removes all faults and snaps the engine state back onto its healthy twin."""
        self.faults = FaultInjector()
        self.twin.faults = self.faults
        self.fault_records.clear()
        self.residual_counts.clear()
        self.sensor_noise.clear_sensor_biases()
        self.y = self.y_expected.copy()
        self.latest_telemetry = self.get_current_snapshot()
        logger.info("Cleared all injected faults.")

    def set_health(self, health: float):
        self.health_index = health
        if health <= 0.0:
            self.y[0] = 0.0
        if self.latest_telemetry:
            self.latest_telemetry["health_index"] = round(health, 4)

    # ------------------------------------------------------------------
    # Diagnosis
    # ------------------------------------------------------------------

    def _make_diagnosis(self, *, anomaly: bool, fault_type: str, message: str, health: float,
                        cylinder: Optional[int] = None, source: Optional[str] = None,
                        residuals: Optional[Dict[str, float]] = None,
                        l1_active: bool = False, l1_message: Optional[str] = None,
                        ml_available: bool = False, l2_pred: Optional[str] = None,
                        l2_conf: Optional[float] = None, l3_anom: Optional[bool] = None,
                        l3_err: Optional[float] = None) -> Dict[str, Any]:
        return {
            "anomaly_detected": bool(anomaly),
            "fault_type": fault_type,
            "message": message,
            "diagnosed_cylinder": cylinder,
            "detection_source": source,
            "health_index": round(float(health), 5),
            "residual_channels": residuals or {},
            "layer1_physics_active": bool(l1_active),
            "layer1_message": l1_message,
            "ml_layers_available": ml_available,
            "layer2_predicted_fault": l2_pred,
            "layer2_confidence": l2_conf,
            "layer3_anomaly_detected": l3_anom,
            "layer3_reconstruction_error": l3_err,
            "layer3_threshold": round(float(self.autoencoder.threshold_), 5),
        }

    def _diagnose_sandbox(self, telemetry: Dict[str, Any], update_detector: bool) -> Dict[str, Any]:
        """Twin-residual detector: a channel alarms once |measured - expected| stays above its limit."""
        if not self.is_running:
            return self._make_diagnosis(
                anomaly=False, fault_type="none", health=self.health_index,
                message="Engine in standby: all subsystems nominal and ready for ignition",
            )

        exp = telemetry["expected"]
        channels = [
            ("RPM", "rpm", telemetry["rpm"], exp["rpm"]),
            ("OIL_T", "oil_temp_c", telemetry["oil_temp_c"], exp["oil_temp_c"]),
            ("OIL_P", "oil_pressure_bar", telemetry["oil_pressure_bar"], exp["oil_pressure_bar"]),
            ("FUEL", "fuel_flow_kg_s", telemetry["fuel_flow_kg_s"], exp["fuel_flow_kg_s"]),
            ("VIB", "vibration_rms_g", telemetry["vibration_rms_g"], exp["vibration_rms_g"]),
            ("ALT_V", "alternator_v", telemetry["alternator_v"], exp["alternator_v"]),
        ]
        for i in range(4):
            channels.append((f"CHT{i + 1}", "cht_c", telemetry["cht_c"][i], exp["cht_c"][i]))
            channels.append((f"EGT{i + 1}", "egt_c", telemetry["egt_c"][i], exp["egt_c"][i]))

        flagged: Dict[str, float] = {}
        scores: Dict[str, float] = {}
        for label, key, actual, expected in channels:
            residual = float(actual) - float(expected)
            if update_detector:
                over = abs(residual) > RESIDUAL_LIMITS[key]
                self.residual_counts[label] = (self.residual_counts.get(label, 0) + 1) if over else 0
            if self.residual_counts.get(label, 0) >= RESIDUAL_PERSIST_TICKS:
                flagged[label] = round(residual, 5 if key == "fuel_flow_kg_s" else 2)
                scores[label] = abs(residual) / RESIDUAL_LIMITS[key]

        if not flagged:
            return self._make_diagnosis(
                anomaly=False, fault_type="none", health=self.health_index,
                message="Nominal: all channels within digital-twin residual limits",
            )

        # Attribute to one cylinder only when its CHT/EGT residual clearly dominates the others.
        cyl_scores: Dict[int, float] = {}
        for label, score in scores.items():
            if label[:3] in ("CHT", "EGT"):
                idx = int(label[3]) - 1
                cyl_scores[idx] = max(cyl_scores.get(idx, 0.0), score)
        ranked_cyls = sorted(cyl_scores.items(), key=lambda kv: kv[1], reverse=True)
        residual_cyl = None
        if ranked_cyls and (len(ranked_cyls) == 1 or ranked_cyls[0][1] >= 2.0 * ranked_cyls[1][1]):
            residual_cyl = ranked_cyls[0][0]

        top = sorted(scores, key=scores.get, reverse=True)[:3]
        evidence = ", ".join(self._format_residual(label, flagged[label]) for label in top)

        developing = [f for f in self.get_active_faults_with_progress() if f["progress"] > 0.0]
        if developing:
            latest = developing[-1]
            fault_type = latest["kind"]
            cylinder = latest["cylinder"] if fault_type in CYLINDER_FAULTS else None
            message = (f"Twin residual alarm ({evidence}) - consistent with injected "
                       f"{human_fault_name(fault_type, cylinder)}, {int(latest['progress'] * 100)}% developed")
        else:
            fault_type = "twin_residual_deviation"
            cylinder = residual_cyl
            message = f"Twin residual alarm ({evidence}) - engine deviating from its healthy twin"

        return self._make_diagnosis(
            anomaly=True, fault_type=fault_type, message=message, health=self.health_index,
            cylinder=cylinder, source="twin_residual", residuals=flagged,
            l1_active=True, l1_message=f"Residual limits exceeded: {evidence}",
        )

    @staticmethod
    def _format_residual(label: str, r: float) -> str:
        if label == "RPM":
            return f"RPM {r:+.0f}"
        if label == "OIL_P":
            return f"OIL_P {r:+.2f} bar"
        if label == "FUEL":
            return f"FUEL {r * 3600 / 0.72:+.1f} L/h"
        if label == "VIB":
            return f"VIB {r:+.2f} g"
        if label == "ALT_V":
            return f"ALT {r:+.1f} V"
        return f"{label} {r:+.0f} C"

    def _diagnose_replay_row(self, row: Dict[str, Any], l2_pred: str, l2_conf: float,
                             l3_anom: bool, l3_err: float) -> Dict[str, Any]:
        """Consensus of Layer 1 physics rules with precomputed Layer 2/3 outputs for one recorded row."""
        l1 = self.rule_engine.diagnose_row(pd.Series(row))
        if l1["physics_rule_active"]:
            fault_type, source = l1["physics_fault_type"], "physics_rule"
        elif l2_pred != "none":
            fault_type, source = l2_pred, "ml_classifier"
        elif l3_anom:
            fault_type, source = "unclassified_anomaly", "autoencoder"
        else:
            fault_type, source = "none", None

        cylinder = None
        if fault_type == "misfire":
            egts = np.array([row[f"EGT_cyl{i}_C"] for i in range(1, 5)], dtype=float)
            cylinder = int(np.argmax(np.abs(egts - np.median(egts))))

        if source == "physics_rule":
            message = f"Physics rule: {l1['physics_rule_message']}"
        elif source == "ml_classifier":
            message = f"AI classifier: {human_fault_name(fault_type, cylinder)} ({l2_conf * 100:.1f}% conf)"
        elif source == "autoencoder":
            message = f"Autoencoder novelty alarm (recon error {l3_err:.3f} > {self.autoencoder.threshold_:.3f})"
        else:
            message = "Nominal: physics rules, classifier and autoencoder all within limits"

        return self._make_diagnosis(
            anomaly=source is not None, fault_type=fault_type, message=message,
            health=float(row["Health_Index"]), cylinder=cylinder, source=source,
            l1_active=l1["physics_rule_active"], l1_message=l1["physics_rule_message"],
            ml_available=True, l2_pred=l2_pred, l2_conf=l2_conf, l3_anom=l3_anom, l3_err=l3_err,
        )

    def _replay_track(self, mission_id: int) -> tuple:
        """Per-row diagnosis and health for a mission, computed once (Layer 2/3 run vectorized)."""
        if mission_id not in self._replay_cache:
            rows = self.mission_rows[mission_id]
            features = pd.DataFrame([[r[c] for c in ML_FEATURE_COLS] for r in rows], columns=ML_FEATURE_COLS)
            preds, probs, _ = self.classifier.predict_with_logits(features)
            ae_anom, ae_err = self.autoencoder.predict_anomalies(features)
            diags = [
                self._diagnose_replay_row(row, str(preds[i]), round(float(np.max(probs[i])), 4),
                                          bool(ae_anom[i]), round(float(ae_err[i]), 5))
                for i, row in enumerate(rows)
            ]

            health, run, track = 1.0, 0, []
            last_min = len(rows) - 1
            for i, (row, diag) in enumerate(zip(rows, diags)):
                run = run + 1 if diag["anomaly_detected"] else 0
                if run >= REPLAY_PERSIST_MIN:
                    floor = REPLAY_HEALTH_FLOOR.get(diag["fault_type"], REPLAY_HEALTH_FLOOR_DEFAULT)
                    if health > floor:
                        health -= (health - floor) / max(REPLAY_MIN_GLIDE_MIN, last_min - i + 1)
                track.append(round(min(float(row["Health_Index"]), health), 5))
            self._replay_cache[mission_id] = (diags, track)
        return self._replay_cache[mission_id]

    def _replay_flight_summary(self, idx: int) -> Dict[str, Any]:
        """Whole-flight summary for recorded minutes 0..idx, fed forward incrementally as the replay advances."""
        mission_id = self.replay_mission_id
        if self._replay_recorder is None or self._replay_recorder[0] != mission_id or self._replay_recorder[1] > idx:
            self._replay_recorder = [mission_id, -1, FlightRecorder(sample_dt=60.0, confirm_samples=REPLAY_PERSIST_MIN)]
        _, fed, recorder = self._replay_recorder
        rows = self.mission_rows[mission_id]
        diags, track = self._replay_track(mission_id)
        for i in range(fed + 1, idx + 1):
            recorder.add(float(rows[i]["elapsed_min"]) * 60.0, flight_sample_from_row(rows[i]), diags[i], track[i])
        self._replay_recorder[1] = idx

        info = self.mission_info[mission_id]
        summary = recorder.summary(complete=self.replay_cursor_min >= info["duration_min"])
        onset = info["fault_onset_min"]
        reached = onset is not None and int(rows[idx]["elapsed_min"]) >= onset
        summary["recorded_label"] = {
            "fault_type": info["fault_type"] if reached else "none",
            "label": human_fault_name(info["fault_type"]) if reached else None,
            "onset_min": onset if reached else None,
        }
        return summary

    # ------------------------------------------------------------------
    # Sandbox physics step
    # ------------------------------------------------------------------

    def _update_flight_dynamics(self, target_alt: float, target_speed: float):
        """Health-limited flight path: full power holds the plan, degraded power sinks, zero health crashes."""
        if self.health_index > 0.85:
            self.altitude_m = target_alt
            self.airspeed_mps = target_speed
            self.craft_crashed = False
        elif self.health_index > 0.25:
            degrade_factor = (0.85 - self.health_index) / 0.60
            sink_rate = 4.0 + 14.0 * degrade_factor
            min_alt = target_alt * (1.0 - 0.75 * degrade_factor)
            self.altitude_m = max(min_alt, self.altitude_m - sink_rate * self.step_dt)
            self.airspeed_mps = max(30.0, target_speed - 22.0 * degrade_factor)
            self.craft_crashed = False
        elif self.health_index > 0.0:
            glide_sink_rate = 18.0 + 25.0 * (1.0 - (self.health_index / 0.25))
            self.altitude_m = max(0.0, self.altitude_m - glide_sink_rate * self.step_dt)
            self.airspeed_mps = max(15.0, self.airspeed_mps - 1.2 * self.step_dt)
            self.craft_crashed = False
        else:
            crash_sink_rate = max(45.0, self.altitude_m / 6.0)
            self.altitude_m = max(0.0, self.altitude_m - crash_sink_rate * self.step_dt)
            self.airspeed_mps = max(0.0, self.airspeed_mps - 3.5 * self.step_dt)
            self.y[0] = max(0.0, self.y[0] - 2500.0 * self.step_dt)
            if self.y[0] < 15.0:
                self.y[0] = 0.0
            if self.altitude_m <= 0.0:
                self.altitude_m = 0.0
                self.airspeed_mps = 0.0
                self.craft_crashed = True
                self.y[0] = 0.0

    def _apply_wear(self, rpm: float):
        rate = BASELINE_WEAR_PER_S * max(0.4, rpm / 4500.0) if rpm > 0.0 else 0.0
        for f in self.get_active_faults_with_progress():
            # progress^2: the first ~30% of the ramp does almost no damage; damage accelerates as the fault matures.
            rate += FAULT_WEAR_WEIGHT.get(f["kind"], 1.0) * FAULT_WEAR_PER_S * f["severity"] * f["progress"] ** 2
        self.health_index = max(0.0, self.health_index - rate * self.step_dt)

    def _sandbox_inputs(self):
        amb_override = self.mission.get_flight_condition(self.t)[2]
        return (
            self.mission.throttle_callback(),
            lambda t: (self.altitude_m, self.airspeed_mps, amb_override),
        )

    def _step_sandbox(self):
        target_alt, target_speed, _, _ = self.mission.get_flight_condition(self.t)
        self._update_flight_dynamics(target_alt, target_speed)
        throttle_fn, ambient_fn = self._sandbox_inputs()

        dydt, out = self.twin._physics_step(self.t, self.y, throttle_fn, ambient_fn, health_index=self.health_index)
        dydt_exp, out_exp = self.expected_twin._physics_step(self.t, self.y_expected, throttle_fn, ambient_fn, health_index=1.0)

        self.y = self.y + dydt * self.step_dt
        self.y[0] = max(0.0, float(self.y[0]))
        self.y_expected = self.y_expected + dydt_exp * self.step_dt
        self.y_expected[0] = max(0.0, float(self.y_expected[0]))
        self.t += self.step_dt

        if self.craft_crashed or self.health_index <= 0.0:
            if self.y[0] <= 25.0 or self.craft_crashed:
                self.y[0] = 0.0
                out["rpm"] = 0.0
                out["oil_pressure_pa"] = 0.0
                out["fuel_flow_kg_s"] = 0.0
                out["vibration"] = {"amp_1x_g": 0.0, "amp_cam_g": 0.0, "amp_fire_g": 0.0, "rms_g": 0.0}

        self._apply_wear(float(out["rpm"]))
        self.latest_outputs = out
        self.latest_telemetry = self._build_sandbox_telemetry(out, out_exp, update_detector=True)

    def _build_sandbox_telemetry(self, out: Dict[str, Any], out_exp: Dict[str, Any], update_detector: bool) -> Dict[str, Any]:
        out["altitude_m"] = self.altitude_m
        out["airspeed_mps"] = self.airspeed_mps
        telemetry = self.sensor_noise.process_snapshot(out, include_diagnostics=True)
        telemetry.update({
            "sim_mode": "sandbox",
            "is_running": self.is_running,
            "mission_phase": self.mission.get_phase(self.t),
            "active_faults_count": len(self.fault_records),
            "active_faults": self.get_active_faults_with_progress(),
            "active_fault_names": [f["kind"] for f in self.fault_records],
            "health_index": round(float(self.health_index), 4),
            "altitude_m": round(float(self.altitude_m), 1),
            "airspeed_mps": round(float(self.airspeed_mps), 1),
            "craft_crashed": bool(self.craft_crashed),
            "expected": expected_from_physics(out_exp),
            "environment": {
                "source": "isa_model",
                "temp_c": telemetry["ambient_c"],
                "pressure_hpa": round(float(out["p_ambient_pa"]) / 100.0, 1),
                "density_kg_m3": round(float(out["p_ambient_pa"]) / (287.05 * (float(out["t_ambient_c"]) + 273.15)), 4),
                "humidity_pct": None,
                "wind_speed_kt": None,
                "wind_dir_deg": None,
                "weather_profile": None,
            },
            "recorded_fault": None,
            "replay": None,
        })
        if self.craft_crashed or (self.health_index <= 0.0 and self.y[0] == 0.0):
            telemetry["rpm"] = 0.0
            telemetry["oil_pressure_bar"] = 0.0
            telemetry["fuel_flow_kg_s"] = 0.0
            telemetry["vibration_rms_g"] = 0.0
            if self.craft_crashed:
                telemetry["altitude_m"] = 0.0
                telemetry["airspeed_mps"] = 0.0
        diag = self._diagnose_sandbox(telemetry, update_detector)
        telemetry["diagnostics"]["ml_diagnostics"] = diag
        if update_detector and not self.craft_crashed:
            self.flight_recorder.add(self.t, flight_sample_from_telemetry(telemetry), diag, self.health_index)
        telemetry["flight_summary"] = self.flight_recorder.summary(complete=self.craft_crashed)
        return telemetry

    # ------------------------------------------------------------------
    # Mission replay step
    # ------------------------------------------------------------------

    def _step_replay(self):
        last_min = float(self.mission_info[self.replay_mission_id]["duration_min"])
        self.replay_cursor_min = min(last_min, self.replay_cursor_min + self.replay_speed * self.step_dt)
        if self.replay_cursor_min >= last_min:
            self.is_running = False
        self.latest_telemetry = self._build_replay_telemetry()

    def _build_replay_telemetry(self) -> Dict[str, Any]:
        rows = self.mission_rows[self.replay_mission_id]
        idx = min(int(self.replay_cursor_min), len(rows) - 1)
        row = rows[idx]
        diags, track = self._replay_track(self.replay_mission_id)
        health = track[idx]
        # Rule messages quote the recorded Health_Index; show the replay health the dashboard displays.
        quote_health = lambda text: re.sub(r"HI=[0-9.]+", f"HI={health:.3f}", text) if text else text
        diag = {
            **diags[idx],
            "health_index": health,
            "message": quote_health(diags[idx]["message"]),
            "layer1_message": quote_health(diags[idx]["layer1_message"]),
        }
        info = self.mission_info[self.replay_mission_id]

        cht = _num(row["CHT_C"], 1)
        recorded_kind = str(row["injected_fault_type"])
        altitude_m = float(row["altitude_ft"]) * 0.3048
        return {
            "t": round(self.replay_cursor_min * 60.0, 1),
            "rpm": _num(row["RPM"], 1),
            # The dataset records one CHT channel; it is shown on all four cylinders rather than invented per cylinder.
            "cht_c": [cht] * 4,
            "egt_c": [_num(row[f"EGT_cyl{i}_C"], 1) for i in range(1, 5)],
            "oil_temp_c": _num(row["Oil_Temp_C"], 1),
            "oil_pressure_bar": _num(row["Oil_Pressure_bar"], 2),
            "fuel_flow_kg_s": _num(row["m_dot_f_kg_s"], 5),
            "alternator_v": None,
            "vibration_rms_g": _num(row["Vib_Amp_Total_g"], 3),
            "ambient_c": _num(row["OAT_C"], 1),
            "altitude_m": round(altitude_m, 1),
            "airspeed_mps": None,
            "sim_mode": "mission_replay",
            "is_running": self.is_running,
            "mission_phase": str(row["mission_phase"]),
            "health_index": health,
            "active_faults": [],
            "active_faults_count": 0,
            "active_fault_names": [],
            "craft_crashed": False,
            "expected": self.fleet_baseline.expected(str(row["mission_phase"]), float(row["OAT_C"]), float(row["altitude_ft"])),
            "environment": {
                "source": "climate_dataset",
                "temp_c": _num(row["OAT_C"], 1),
                "pressure_hpa": _num(row["pressure_hPa"], 1),
                "density_kg_m3": _num(row["air_density_kg_m3"], 4),
                "humidity_pct": _num(row["relative_humidity_pct"], 1),
                "wind_speed_kt": _num(row["wind_speed_kt"], 1),
                "wind_dir_deg": _num(row["wind_relative_angle_deg"], 0),
                "weather_profile": str(row["weather_profile"]),
            },
            "recorded_fault": {
                "kind": recorded_kind,
                "active": recorded_kind != "none",
                "onset_min": info["fault_onset_min"],
            },
            "replay": {
                "mission_id": self.replay_mission_id,
                "mission_type": info["mission_type"],
                "weather_profile": info["weather_profile"],
                "elapsed_min": int(row["elapsed_min"]),
                "duration_min": info["duration_min"],
                "timestamp": str(row["timestamp"]),
                "speed": self.replay_speed,
                "complete": self.replay_cursor_min >= info["duration_min"],
            },
            "diagnostics": {
                "throttle": None,
                "airspeed_mps": None,
                "map_pa": _num(float(row["MAP_hPa"]) * 100.0, 1),
                "ratio_lube": _num(row["Ratio_Lube"], 3),
                "delta_cht_ambient": [_num(row["Delta_CHT_ambient_C"], 1)] * 4,
                "ml_diagnostics": diag,
            },
            "flight_summary": self._replay_flight_summary(idx),
        }

    # ------------------------------------------------------------------
    # Snapshot & loop
    # ------------------------------------------------------------------

    def get_current_snapshot(self) -> Dict[str, Any]:
        """Instantaneous telemetry for the current mode without advancing time."""
        if self.sim_mode == "mission_replay":
            return self._build_replay_telemetry()
        throttle_fn, ambient_fn = self._sandbox_inputs()
        _, out = self.twin._physics_step(self.t, self.y, throttle_fn, ambient_fn, health_index=self.health_index)
        _, out_exp = self.expected_twin._physics_step(self.t, self.y_expected, throttle_fn, ambient_fn, health_index=1.0)
        return self._build_sandbox_telemetry(out, out_exp, update_detector=False)

    async def _simulation_loop(self):
        last_broadcast_time = 0.0
        try:
            while True:
                loop_start = time.perf_counter()
                if self.is_running:
                    if self.sim_mode == "mission_replay":
                        self._step_replay()
                    else:
                        self._step_sandbox()
                elif self.latest_telemetry:
                    self.latest_telemetry["is_running"] = False

                now = time.perf_counter()
                if now - last_broadcast_time >= self.broadcast_interval and self.latest_telemetry:
                    await ws_manager.broadcast_json(self.latest_telemetry)
                    last_broadcast_time = now

                elapsed = time.perf_counter() - loop_start
                await asyncio.sleep(max(0.005, self.step_dt - elapsed))
        except asyncio.CancelledError:
            logger.info("Simulation loop cancelled.")
        except Exception as e:
            logger.exception(f"Exception in simulation loop: {e}")

# ============================================================================
# FastAPI App Initialization
# ============================================================================

app = FastAPI(
    title="Rotax 914 MALE UAV Digital Twin Server",
    description="Physics-based engine simulation core with WebSocket telemetry, REST fault injection and 15-mission replay for SIH26054.",
    version="1.1.0",
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


def _require_sandbox(action: str):
    if sim_service.sim_mode != "sandbox":
        raise HTTPException(status_code=409, detail=f"{action} is only available in sandbox mode (currently replaying a recorded mission).")

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
    plus "sim_mode", "mission_phase", "expected" (ideal values for current conditions),
    "environment", "replay" and "recorded_fault".
    Also receives client control commands over WebSocket.
    """
    await ws_manager.connect(websocket)
    snapshot = sim_service.latest_telemetry or sim_service.get_current_snapshot()
    await websocket.send_text(json.dumps(snapshot))

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                cmd = msg.get("command")
                sandbox = sim_service.sim_mode == "sandbox"
                if cmd == "set_throttle" and sandbox:
                    val = float(msg.get("value", 0.65))
                    sim_service.mission.set_manual(
                        throttle=val,
                        altitude_m=sim_service.mission.manual_altitude_m,
                        airspeed_mps=sim_service.mission.manual_airspeed_mps
                    )
                elif cmd == "resume_mission" and sandbox:
                    sim_service.mission.clear_manual()
                elif cmd == "pause":
                    sim_service.is_running = False
                    sim_service.latest_telemetry["is_running"] = False
                elif cmd == "resume":
                    sim_service.is_running = True
                    sim_service.latest_telemetry["is_running"] = True
                elif cmd == "reset":
                    sim_service.reset()
                elif cmd == "inject_fault" and sandbox:
                    sim_service.inject_fault(FaultInjectionCommand(
                        kind=msg.get("kind", "misfire"),
                        severity=float(msg.get("severity", 0.8)),
                        cylinder=msg.get("cylinder"),
                        ramp_s=float(msg.get("ramp_s", DEFAULT_FAULT_RAMP_S)),
                        start_in_s=float(msg.get("start_in_s", 0.0)),
                        extra=msg.get("extra", {})
                    ))
                elif cmd == "clear_faults" and sandbox:
                    sim_service.clear_faults()
                elif cmd == "set_health" and sandbox:
                    sim_service.set_health(max(0.0, min(1.0, float(msg.get("health", 0.0)))))
                elif cmd == "select_mission":
                    speed = msg.get("speed")
                    sim_service.select_mission(int(msg["mission_id"]), float(speed) if speed is not None else None)
                elif cmd == "select_sandbox":
                    sim_service.select_sandbox()
                elif cmd == "set_replay_speed":
                    sim_service.set_replay_speed(max(0.01, min(120.0, float(msg["speed"]))))
                else:
                    logger.warning(f"Ignored WebSocket command '{cmd}' in {sim_service.sim_mode} mode")
                    continue
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
        "sim_mode": sim_service.sim_mode,
        "sim_time_s": round(sim_service.t, 2),
        "active_connections": len(ws_manager.active_connections),
        "manual_override": sim_service.mission.manual_override,
        "current_flight_condition": {
            "altitude_m": round(flight[0], 1),
            "airspeed_mps": round(flight[1], 1),
            "throttle": round(flight[3], 3),
        },
        "replay": sim_service.latest_telemetry.get("replay"),
        "active_faults": sim_service.get_active_faults_with_progress(),
        "sensor_noise_enabled": sim_service.sensor_noise.enabled,
        "ml_diagnostics": sim_service.latest_telemetry.get("diagnostics", {}).get("ml_diagnostics"),
        "latest_telemetry": sim_service.latest_telemetry
    }

@app.get("/api/missions")
def list_missions():
    """The 15 recorded missions available for replay (duration, labelled fault, weather profile)."""
    return {
        "missions": sim_service.mission_catalog,
        "sim_mode": sim_service.sim_mode,
        "active_mission_id": sim_service.replay_mission_id,
        "replay_speed": sim_service.replay_speed,
    }

@app.post("/api/control/select_mission")
async def select_mission_endpoint(cmd: MissionSelectCommand):
    """Switch to mission-replay mode and start streaming the recorded mission from minute 0."""
    try:
        sim_service.select_mission(cmd.mission_id, cmd.speed)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown mission_id {cmd.mission_id}")
    await ws_manager.broadcast_json(sim_service.latest_telemetry)
    return {"status": "ok", "sim_mode": sim_service.sim_mode, "mission_id": cmd.mission_id, "replay_speed": sim_service.replay_speed}

@app.post("/api/control/select_sandbox")
async def select_sandbox_endpoint():
    """Return to the free-running physics sandbox (cold, paused)."""
    sim_service.select_sandbox()
    await ws_manager.broadcast_json(sim_service.latest_telemetry)
    return {"status": "ok", "sim_mode": sim_service.sim_mode}

@app.post("/api/control/replay_speed")
def set_replay_speed_endpoint(cmd: ReplaySpeedCommand):
    sim_service.set_replay_speed(cmd.speed)
    return {"status": "ok", "replay_speed": sim_service.replay_speed}

@app.post("/api/control/throttle")
def set_throttle(cmd: ThrottleCommand):
    """Set manual throttle (0.0 to 1.0) or return to mission schedule."""
    _require_sandbox("Manual throttle")
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
    _require_sandbox("Manual flight condition")
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
    _require_sandbox("Setting health")
    sim_service.set_health(cmd.health)
    return {"status": "ok", "health_index": round(float(sim_service.health_index), 4)}

@app.post("/api/faults/inject")
async def inject_fault_endpoint(cmd: FaultInjectionCommand):
    """
    Inject one of the 8 PS faults (plus regulator_failure / catastrophic_failure).
    The fault develops from 0% to 100% over `ramp_s` seconds.
    """
    _require_sandbox("Fault injection")
    if cmd.kind not in VALID_FAULT_KINDS:
        raise HTTPException(status_code=400, detail=f"Invalid fault kind '{cmd.kind}'. Must be one of {sorted(VALID_FAULT_KINDS)}")

    record = sim_service.inject_fault(cmd)
    await ws_manager.broadcast_json(sim_service.latest_telemetry)
    return {"status": "ok", "fault_injected": record}

@app.post("/api/faults/clear")
async def clear_faults_endpoint():
    _require_sandbox("Clearing faults")
    sim_service.clear_faults()
    await ws_manager.broadcast_json(sim_service.latest_telemetry)
    return {"status": "ok", "message": "All faults cleared"}

@app.get("/api/faults")
def list_faults_endpoint():
    return {"active_faults": sim_service.get_active_faults_with_progress()}

@app.get("/api/mission/replay")
def get_mission_replay():
    """
    Returns the pre-computed single demo trajectory (rotax914_digital_twin_demo.csv) for a scrubber.
    For the 15 recorded missions, use /api/missions and /api/control/select_mission.
    """
    demo_csv = os.path.join(BASE_DIR, "rotax914_digital_twin_demo.csv")
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

static_dir = os.path.join(BASE_DIR, "static")
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
