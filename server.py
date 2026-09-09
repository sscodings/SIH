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

from atmosphere import FlightMissionProfile
from rotax914_digital_twin import (
    EngineSpecs,
    FaultInjector,
    RotaxDigitalTwin,
    specs_idle_state,
)
from sensor_noise import SensorNoiseModel
from anomaly_detection import PhysicsRuleEngine
from engine_physics import health_index_step, vogel_viscosity
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
        self.latest_diagnosis: Dict[str, Any] = {
            "anomaly_detected": False,
            "fault_type": "none",
            "message": "Nominal operation",
            "health_index": 1.0
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
        self.sensor_noise.clear_sensor_biases()
        self.twin = RotaxDigitalTwin(specs=self.specs, faults=self.faults)
        self.mission.clear_manual()
        self.health_index = 1.0
        self.latest_diagnosis = {
            "anomaly_detected": False,
            "fault_type": "none",
            "message": "Nominal operation",
            "health_index": 1.0
        }
        logger.info("Engine simulation reset to cold/idle state.")

    def inject_fault(self, cmd: FaultInjectionCommand) -> Dict[str, Any]:
        start_time = self.t + cmd.start_in_s
        self.faults.add(
            kind=cmd.kind,
            start_t=start_time,
            severity=cmd.severity,
            cylinder=cmd.cylinder,
            ramp_s=cmd.ramp_s,
            **cmd.extra
        )
        record = {
            "id": len(self.fault_records) + 1,
            "kind": cmd.kind,
            "start_t": round(start_time, 2),
            "severity": cmd.severity,
            "cylinder": cmd.cylinder,
            "ramp_s": cmd.ramp_s,
            "extra": cmd.extra,
            "injected_at_sim_t": round(self.t, 2)
        }
        self.fault_records.append(record)
        logger.info(f"Injected fault: {record}")
        return record

    def clear_faults(self):
        self.faults = FaultInjector()
        self.fault_records.clear()
        self.sensor_noise.clear_sensor_biases()
        self.twin.faults = self.faults
        logger.info("Cleared all injected faults.")

    def _diagnose_snapshot(self, out: Dict[str, Any], telemetry: Dict[str, Any]) -> Dict[str, Any]:
        """Runs the ML team's physics rules and updates the dynamic health/wear index."""
        mu = vogel_viscosity(telemetry["oil_temp_c"])
        p_oil_pa = telemetry["oil_pressure_bar"] * 1e5
        p_oil_nominal_pa = 4.1e5
        t_nom_c = 95.0
        k_wear = 2e-13

        self.health_index = health_index_step(
            self.health_index, p_oil_pa, p_oil_nominal_pa,
            telemetry["oil_temp_c"], t_nom_c, self.step_dt, k_wear
        )

        row_s = pd.Series({
            "RPM": telemetry["rpm"],
            "Oil_Pressure_bar": telemetry["oil_pressure_bar"],
            "Oil_Viscosity_Pa_s": mu,
            "CHT_C": max(telemetry["cht_c"]),
            "Delta_CHT_ambient_C": max(telemetry["cht_c"]) - telemetry["ambient_c"],
            "EGT_cyl1_C": telemetry["egt_c"][0],
            "EGT_cyl2_C": telemetry["egt_c"][1],
            "EGT_cyl3_C": telemetry["egt_c"][2],
            "EGT_cyl4_C": telemetry["egt_c"][3],
            "Delta_EGT_cross_C": max(telemetry["egt_c"]) - min(telemetry["egt_c"]),
            "mission_phase": "Cruise_Loiter",
            "Health_Index": self.health_index,
        })
        diag = self.rule_engine.diagnose_row(row_s)
        self.latest_diagnosis = {
            "anomaly_detected": bool(diag["physics_rule_active"]),
            "fault_type": str(diag["physics_fault_type"]),
            "message": str(diag["physics_rule_message"] or "Nominal operation"),
            "health_index": round(float(self.health_index), 5),
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

                    # Broadcast on interval
                    now = time.perf_counter()
                    if now - last_broadcast_time >= self.broadcast_interval:
                        await ws_manager.broadcast_json(telemetry)
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
                elif cmd == "resume":
                    sim_service.is_running = True
                elif cmd == "reset":
                    sim_service.reset()
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
                elif cmd == "clear_faults":
                    sim_service.clear_faults()
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
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
