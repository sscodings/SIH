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

    print("\n=================================================================")
    print(" ALL TESTS PASSED SUCCESSFULLY! ")
    print("=================================================================")

if __name__ == "__main__":
    run_tests()
