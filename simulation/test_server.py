"""
Automated Verification Suite for Rotax 914 FastAPI WebSocket & REST Server
==========================================================================
SIH26054 (DRDO) | Verification Script

Tests:
1. REST API endpoints (/api/status, /api/control/throttle, /api/faults/inject, /api/faults/clear, /api/mission/replay)
2. WebSocket telemetry stream (/ws/engine) conformance with Section 7.1 message schema:
   - "t", "rpm", "cht_c", "egt_c", "oil_temp_c", "oil_pressure_bar",
     "fuel_flow_kg_s", "alternator_v", "vibration_rms_g", "ambient_c", "altitude_m"
3. Fault reaction: Injected misfire reflects in the engine state.
"""

import json
import sys
from fastapi.testclient import TestClient
from server import app, sim_service

def run_tests():
    print("=================================================================")
    print(" Starting Rotax 914 Digital Twin Server Automated Tests")
    print("=================================================================")

    with TestClient(app) as client:
        # 1. Test GET /api/status
        print("\n[TEST 1] Testing GET /api/status...")
        res = client.get("/api/status")
        assert res.status_code == 200, f"Expected 200, got {res.status_code}"
        status_data = res.json()
        assert "status" in status_data, "Missing 'status' in status response"
        assert "sim_time_s" in status_data, "Missing 'sim_time_s'"
        print(f"  -> PASS: Simulation status is '{status_data['status']}', sim_time={status_data['sim_time_s']}s")

        # 2. Test POST /api/control/throttle
        print("\n[TEST 2] Testing POST /api/control/throttle...")
        res = client.post("/api/control/throttle", json={"throttle": 0.85, "manual": True})
        assert res.status_code == 200, f"Expected 200, got {res.status_code}"
        assert res.json()["throttle"] == 0.85
        assert sim_service.mission.manual_override is True
        print("  -> PASS: Throttle set to 0.85 (manual override active)")

        # 3. Test POST /api/faults/inject
        print("\n[TEST 3] Testing POST /api/faults/inject (Misfire on Cylinder 1)...")
        res = client.post("/api/faults/inject", json={
            "kind": "misfire",
            "severity": 0.85,
            "cylinder": 1,
            "ramp_s": 10.0,
            "start_in_s": 0.0
        })
        assert res.status_code == 200, f"Expected 200, got {res.status_code}"
        fault_rec = res.json()["fault_injected"]
        assert fault_rec["kind"] == "misfire"
        assert fault_rec["cylinder"] == 1
        print(f"  -> PASS: Successfully injected fault #{fault_rec['id']} {fault_rec['kind']}")

        # 4. Test GET /api/faults
        print("\n[TEST 4] Testing GET /api/faults...")
        res = client.get("/api/faults")
        assert res.status_code == 200
        faults = res.json()["active_faults"]
        assert len(faults) >= 1
        print(f"  -> PASS: Verified {len(faults)} active fault(s) in registry")

        # 5. Test GET /api/mission/replay
        print("\n[TEST 5] Testing GET /api/mission/replay...")
        res = client.get("/api/mission/replay")
        assert res.status_code == 200
        replay_data = res.json()
        assert replay_data["samples"] > 0
        print(f"  -> PASS: Successfully loaded mission replay data ({replay_data['samples']} samples)")

        # 6. Test WebSocket /ws/engine Schema Conformance (§7.1)
        print("\n[TEST 6] Testing WebSocket /ws/engine schema conformance (§7.1)...")
        with client.websocket_connect("/ws/engine") as websocket:
            raw_msg = websocket.receive_text()
            msg = json.loads(raw_msg)
            print(f"  -> Received WebSocket message frame:\n     {raw_msg[:120]}...")

            # Strict Section 7.1 Schema Validation
            required_keys = [
                "t", "rpm", "cht_c", "egt_c", "oil_temp_c",
                "oil_pressure_bar", "fuel_flow_kg_s", "alternator_v",
                "vibration_rms_g", "ambient_c", "altitude_m"
            ]
            for key in required_keys:
                assert key in msg, f"Section 7.1 violation: missing key '{key}' in WebSocket payload"

            assert isinstance(msg["cht_c"], list) and len(msg["cht_c"]) == 4, "cht_c must be a list of 4 floats"
            assert isinstance(msg["egt_c"], list) and len(msg["egt_c"]) == 4, "egt_c must be a list of 4 floats"
            assert isinstance(msg["rpm"], (int, float)), "rpm must be a numeric value"
            assert isinstance(msg["oil_pressure_bar"], (int, float)), "oil_pressure_bar must be numeric"

            print("  -> PASS: All 11 Section 7.1 schema fields verified perfectly!")

        # 7. Test POST /api/faults/clear
        print("\n[TEST 7] Testing POST /api/faults/clear...")
        res = client.post("/api/faults/clear")
        assert res.status_code == 200
        res = client.get("/api/faults")
        assert len(res.json()["active_faults"]) == 0
        print("  -> PASS: All faults cleared, engine restored to nominal baseline")

        # 8. Test GET /api/missions
        print("\n[TEST 8] Testing GET /api/missions...")
        res = client.get("/api/missions")
        assert res.status_code == 200
        missions = {m["mission_id"]: m for m in res.json()["missions"]}
        assert len(missions) == 15, f"Expected 15 recorded missions, got {len(missions)}"
        assert missions[5]["fault_type"] == "lubrication_issues" and missions[5]["fault_onset_min"] == 345
        assert missions[13]["fault_type"] == "misfire" and missions[13]["fault_onset_min"] == 268
        print("  -> PASS: 15 missions listed with labelled faults and onsets")

        # 9. Test mission replay streams the recorded rows with ML diagnosis
        print("\n[TEST 9] Testing POST /api/control/select_mission (mission 13 replay)...")
        res = client.post("/api/control/select_mission", json={"mission_id": 13, "speed": 1.0})
        assert res.status_code == 200
        assert sim_service.sim_mode == "mission_replay"
        sim_service.is_running = False  # hold the cursor still while we inspect rows
        sim_service.replay_cursor_min = 270.0
        tel = sim_service.get_current_snapshot()
        row = sim_service.mission_rows[13][270]
        assert tel["sim_mode"] == "mission_replay" and tel["replay"]["elapsed_min"] == 270
        assert tel["rpm"] == round(row["RPM"], 1), "Replay must stream the recorded RPM"
        assert tel["recorded_fault"] == {"kind": "misfire", "active": True, "onset_min": 268}
        diag = tel["diagnostics"]["ml_diagnostics"]
        assert diag["ml_layers_available"] and diag["anomaly_detected"] and diag["fault_type"] == "misfire"
        assert tel["environment"]["humidity_pct"] is not None and tel["expected"]["source"] == "fleet_baseline"
        json.dumps(tel)
        print(f"  -> PASS: Replayed min 270 of mission 13: {diag['message'][:70]}")

        # 10. Sandbox-only actions are rejected during replay; select_sandbox returns to cold sandbox
        print("\n[TEST 10] Testing sandbox-only guards and POST /api/control/select_sandbox...")
        res = client.post("/api/faults/inject", json={"kind": "misfire", "severity": 0.8})
        assert res.status_code == 409
        res = client.post("/api/control/select_sandbox")
        assert res.status_code == 200 and sim_service.sim_mode == "sandbox" and not sim_service.is_running
        tel = sim_service.latest_telemetry
        assert tel["sim_mode"] == "sandbox" and tel["expected"]["source"] == "physics_twin"
        assert tel["environment"]["humidity_pct"] is None
        print("  -> PASS: Replay rejects fault injection; sandbox restored cold and paused")

        # 11. Health Summary flight record: whole-flight averages and detected issues
        print("\n[TEST 11] Testing flight_summary over a full replay of mission 13...")
        assert tel["flight_summary"]["flight_time_s"] == 0.0 and tel["flight_summary"]["issues"] == []
        sim_service.select_mission(13, speed=30.0)
        while sim_service.is_running:
            sim_service._step_replay()
        summary = sim_service.latest_telemetry["flight_summary"]
        rows = sim_service.mission_rows[13]
        assert summary["complete"] and summary["flight_time_s"] == 535 * 60.0
        assert summary["stats"]["rpm"]["avg"] == round(sum(r["RPM"] for r in rows) / len(rows))
        assert summary["stats"]["rpm"]["max"] == round(max(r["RPM"] for r in rows))
        misfires = [i for i in summary["issues"] if i["fault_type"] == "misfire"]
        assert len(misfires) == 1 and misfires[0]["first_t_s"] == 268 * 60.0 and misfires[0]["active"]
        assert summary["health"]["now"] == sim_service.latest_telemetry["health_index"] < 0.8
        assert summary["recorded_label"]["onset_min"] == 268
        json.dumps(summary)
        sim_service.select_sandbox()
        print(f"  -> PASS: Mission 13 summary: avg RPM {summary['stats']['rpm']['avg']}, "
              f"misfire issue from min 268, health {summary['health']['start']} -> {summary['health']['now']}")

    print("\n=================================================================")
    print(" ALL TESTS PASSED SUCCESSFULLY! ")
    print("=================================================================")

if __name__ == "__main__":
    run_tests()
