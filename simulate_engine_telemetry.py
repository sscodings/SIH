"""
Simulate Rotax 914F engine telemetry from the existing climate_dataset.csv,
using the physics formulas in engine_physics.py (sourced from
Rotax914_ML_Formulas.pdf).

For each mission, steps forward minute-by-minute (matches the climate
dataset's 1-sample/minute resolution), integrating the CHT and oil-temp
ODEs, and computing all other parameters algebraically at each step.

Output: engine_telemetry.csv, one row per climate_dataset.csv row, joined
on mission_id + timestamp.

A small number of missions are given an injected fault (see FAULT_MISSIONS)
to demonstrate the anomaly-detection formulas from Section 5 -- these are
clearly labeled so they can be used as ML training labels later.
"""

import numpy as np
import pandas as pd
from engine_physics import (
    RPM_TARGET, POWER_FRACTION, AFR_TARGET, RATED_RPM,
    compute_map_pa, compute_air_mass_flow, compute_fuel_density,
    compute_afr_phi, compute_egt, step_cht, step_oil_temp,
    vogel_viscosity, hagen_poiseuille_oil_pressure, vibration_frequencies,
    cylinder_egt_spread, health_index_step,
)

DT_S = 60.0  # 1-minute sampling, matches climate dataset

# Nominal oil pressure for health-index reference (mid of confirmed 3.5-4.8 bar range)
P_OIL_NOMINAL_PA = 4.1e5
T_OIL_NOM_C = 95.0
K_WEAR = 2e-13  # ASSUMED wear-rate calibration constant, tuned so a 15-20hr mission
                 # with a real fault shows visible but non-catastrophic health decline

# Which missions get an injected fault, and what kind (for later ML labeling)
FAULT_MISSIONS = {
    5: "lubrication_degradation",   # oil pressure will be artificially suppressed
    11: "cooling_degradation",      # h_eff reduced mid-mission -> rising CHT
    13: "misfire",                  # large EGT cylinder spread injected
}


def simulate_mission(df_mission, rng):
    df_mission = df_mission.sort_values("elapsed_min").reset_index(drop=True)
    n = len(df_mission)
    mission_id = df_mission["mission_id"].iloc[0]
    fault_type = FAULT_MISSIONS.get(mission_id, None)

    # State variables carried across timesteps
    cht_c = df_mission["OAT_C"].iloc[0] + 20.0  # start near ambient + warm-up margin
    oil_temp_c = df_mission["OAT_C"].iloc[0] + 15.0
    health_index = 1.0

    rows = []
    for i in range(n):
        row = df_mission.iloc[i]
        phase = row["mission_phase"]
        oat_c = row["OAT_C"]
        pressure_hpa = row["pressure_hPa"]
        air_density = row["air_density_kg_m3"]
        altitude_ft = row["altitude_ft"]
        wind_kt = row["wind_speed_kt"]

        rpm = RPM_TARGET.get(phase, 3000) + rng.normal(0, 30)
        power_fraction = POWER_FRACTION.get(phase, 0.3)

        # --- Section 1: combustion / AFR ---
        map_pa = compute_map_pa(altitude_ft, pressure_hpa, power_fraction)
        t_airbox_k = (oat_c + 273.15) + 25 * power_fraction  # turbo compression heating, ASSUMED
        m_dot_a = compute_air_mass_flow(map_pa, rpm, t_airbox_k)

        afr_target = AFR_TARGET.get(phase, 13.0)
        m_dot_f = m_dot_a / afr_target
        rho_fuel = compute_fuel_density(oat_c)  # fuel temp approximated as OAT
        q_fuel_lps = (m_dot_f / rho_fuel) * 1000.0  # back out volumetric flow, L/s

        afr_actual, phi = compute_afr_phi(m_dot_a, m_dot_f)
        egt_avg = compute_egt(phi, power_fraction)

        # --- Section 2: CHT (integrate ODE), with optional cooling-degradation fault ---
        wind_effective = wind_kt
        if fault_type == "cooling_degradation" and row["elapsed_min"] > n * 0.4:
            wind_effective = wind_kt * 0.35  # simulate blocked fins / coolant fault
        cht_c = step_cht(cht_c, oat_c, m_dot_f, DT_S, wind_effective, air_density)
        delta_cht_ambient = cht_c - oat_c

        # --- Oil temp lag ---
        oil_temp_c = step_oil_temp(oil_temp_c, cht_c, oat_c, DT_S)

        # --- Section 3: lubrication ---
        mu = vogel_viscosity(oil_temp_c)
        p_oil_pa = hagen_poiseuille_oil_pressure(mu, rpm)
        if fault_type == "lubrication_degradation" and row["elapsed_min"] > n * 0.3:
            p_oil_pa *= 0.55  # simulate pump wear / leak
        ratio_lube = p_oil_pa / mu

        # --- Section 4: vibration ---
        f0, f_cam, f_fire, f_gear = vibration_frequencies(rpm)

        # --- Section 5: ML diagnostic features ---
        misfire_fault_active = (fault_type == "misfire" and row["elapsed_min"] > n * 0.5)
        cyl_egts, delta_egt_cross = cylinder_egt_spread(egt_avg, rng, fault_mode=misfire_fault_active)
        health_index = health_index_step(
            health_index, p_oil_pa, P_OIL_NOMINAL_PA, oil_temp_c, T_OIL_NOM_C, DT_S, K_WEAR
        )

        rows.append({
            "mission_id": mission_id,
            "timestamp": row["timestamp"],
            "elapsed_min": row["elapsed_min"],
            "mission_phase": phase,
            "RPM": round(rpm, 1),
            "MAP_hPa": round(map_pa / 100.0, 2),
            "m_dot_a_kg_s": round(m_dot_a, 5),
            "m_dot_f_kg_s": round(m_dot_f, 6),
            "Q_fuel_L_s": round(q_fuel_lps, 5),
            "AFR_actual": round(afr_actual, 3),
            "phi_equivalence_ratio": round(phi, 3),
            "EGT_avg_C": round(egt_avg, 1),
            "EGT_cyl1_C": round(cyl_egts[0], 1),
            "EGT_cyl2_C": round(cyl_egts[1], 1),
            "EGT_cyl3_C": round(cyl_egts[2], 1),
            "EGT_cyl4_C": round(cyl_egts[3], 1),
            "Delta_EGT_cross_C": round(delta_egt_cross, 1),
            "CHT_C": round(cht_c, 2),
            "Delta_CHT_ambient_C": round(delta_cht_ambient, 2),
            "Oil_Temp_C": round(oil_temp_c, 2),
            "Oil_Pressure_bar": round(p_oil_pa / 1e5, 3),
            "Oil_Viscosity_Pa_s": round(mu, 6),
            "Ratio_Lube": round(ratio_lube, 2),
            "Vib_f0_Hz": round(f0, 2),
            "Vib_fcam_Hz": round(f_cam, 2),
            "Vib_ffire_Hz": round(f_fire, 2),
            "Vib_fgear_Hz": round(f_gear, 2),
            "Health_Index": round(health_index, 5),
            "injected_fault_type": fault_type if (
                fault_type and row["elapsed_min"] > n * (0.3 if fault_type == "lubrication_degradation"
                                                            else 0.4 if fault_type == "cooling_degradation"
                                                            else 0.5)
            ) else "none",
        })

    return pd.DataFrame(rows)


if __name__ == "__main__":
    climate_df = pd.read_csv("/home/claude/dt_project/climate_dataset.csv")
    rng_master = np.random.default_rng(7)

    all_engine = []
    for mission_id, df_mission in climate_df.groupby("mission_id"):
        mission_rng = np.random.default_rng(2000 + int(mission_id))
        engine_df = simulate_mission(df_mission, mission_rng)
        all_engine.append(engine_df)

    engine_full = pd.concat(all_engine, ignore_index=True)

    # Rate of Rise diagnostic (Section 2.2) computed post-hoc per mission
    engine_full["Rate_of_Rise_CHT_C_per_min"] = (
        engine_full.groupby("mission_id")["CHT_C"].diff().fillna(0)
    ).round(3)

    out_path = "/home/claude/dt_project/engine_telemetry.csv"
    engine_full.to_csv(out_path, index=False)

    print(f"Generated engine telemetry: {len(engine_full)} rows across {climate_df['mission_id'].nunique()} missions")
    print(f"Saved to {out_path}\n")

    print("Fault injection summary:")
    print(engine_full[engine_full.injected_fault_type != "none"]
          .groupby(["mission_id", "injected_fault_type"]).size().to_string())

    print("\nSample stats (should sit within confirmed real-world ranges):")
    print(engine_full[["CHT_C", "Oil_Temp_C", "Oil_Pressure_bar", "EGT_avg_C", "Delta_EGT_cross_C"]].describe().to_string())
