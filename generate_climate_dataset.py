"""
Synthetic Atmospheric/Climate Dataset Generator
for Rotax 914F Digital Twin Project (MALE UAV)

Generates physically-plausible time-series atmospheric data for multiple
UAV missions, using the International Standard Atmosphere (ISA) model as
the baseline, with per-mission ISA deviations (hot/standard/cold day),
realistic mission altitude profiles, and weather-driven noise layered on top.

Output: one CSV with all missions (long format), 1 row per minute per mission.
"""

import numpy as np
import pandas as pd
from datetime import datetime, timedelta

# ----------------------------------------------------------------------
# 1. PHYSICAL CONSTANTS (ISA model, troposphere: 0-11,000 m / 0-36,089 ft)
# ----------------------------------------------------------------------
T0_K = 288.15          # ISA sea-level temperature (K) = 15 deg C
P0_HPA = 1013.25        # ISA sea-level pressure (hPa)
LAPSE_RATE = 0.0065      # K per meter (troposphere)
G = 9.80665              # m/s^2
R_AIR = 287.05           # J/(kg*K) specific gas constant for dry air
FT_TO_M = 0.3048

def isa_temperature_pressure(altitude_ft, isa_deviation_c=0.0):
    """
    Returns (temperature_C, pressure_hPa) at a given altitude using the
    ISA troposphere model, shifted by a constant ISA deviation
    (e.g. +15 for a 'hot day', -10 for a 'cold day').
    Valid up to 25,000 ft (well within the 36,089 ft troposphere limit).
    """
    h_m = altitude_ft * FT_TO_M
    t0_shifted = T0_K + isa_deviation_c  # shift whole profile by deviation
    temp_k = t0_shifted - LAPSE_RATE * h_m
    # Pressure still follows the standard exponent (deviation mainly shifts temp,
    # small secondary effect on pressure is neglected for this simplified model)
    pressure_hpa = P0_HPA * (1 - (LAPSE_RATE * h_m) / T0_K) ** (G / (R_AIR * LAPSE_RATE))
    temp_c = temp_k - 273.15
    return temp_c, pressure_hpa


def air_density(temp_c, pressure_hpa, rel_humidity_pct=0.0):
    """
    Approximate moist air density (kg/m^3) using ideal gas law with a
    simple humidity correction (water vapor is less dense than dry air).
    """
    temp_k = temp_c + 273.15
    pressure_pa = pressure_hpa * 100.0

    # Saturation vapor pressure (Tetens' formula, hPa)
    es = 6.1078 * 10 ** ((7.5 * temp_c) / (temp_c + 237.3))
    e = (rel_humidity_pct / 100.0) * es  # actual vapor pressure, hPa
    e_pa = e * 100.0

    # Moist air density
    r_v = 461.495  # specific gas constant for water vapor J/(kg*K)
    density = (pressure_pa - e_pa) / (R_AIR * temp_k) + e_pa / (r_v * temp_k)
    return density


# ----------------------------------------------------------------------
# 2. MISSION PROFILE GENERATION
# ----------------------------------------------------------------------
MISSION_TYPES = ["ISR_Patrol", "Maritime_Surveillance", "Communication_Relay", "Border_Recon"]
WEATHER_PROFILES = {
    # name: (isa_deviation_c, humidity_base_pct, humidity_var, wind_base_kt, wind_var)
    "Standard_Day":  (0.0, 45, 10, 12, 5),
    "Hot_Desert":    (20.0, 15, 8, 8, 6),
    "Cold_Winter":   (-15.0, 55, 12, 18, 8),
    "Maritime_Humid":(5.0, 80, 10, 15, 10),
    "Monsoon":       (2.0, 90, 8, 20, 12),
}


def generate_altitude_profile(n_samples, cruise_alt_ft, climb_minutes, descent_minutes,
                                loiter_variation_ft=1500, rng=None):
    """
    Builds a realistic altitude-vs-time profile:
    Taxi/Takeoff (flat, low alt) -> Climb (linear ramp) -> Cruise/Loiter
    (long plateau with slow drift +- variation, simulating ISR altitude
    changes) -> Descent (linear ramp down) -> Landing.
    """
    rng = rng or np.random.default_rng()
    alt = np.zeros(n_samples)

    takeoff_pad = 3  # minutes on ground before climb
    climb_end = takeoff_pad + climb_minutes
    descent_start = n_samples - descent_minutes

    # Ground / takeoff
    alt[:takeoff_pad] = rng.uniform(0, 50, takeoff_pad)

    # Climb (smooth ramp with slight noise)
    climb_len = climb_end - takeoff_pad
    alt[takeoff_pad:climb_end] = np.linspace(0, cruise_alt_ft, climb_len) \
        + rng.normal(0, 40, climb_len)

    # Cruise / loiter -- slow random walk around cruise altitude (ISR altitude changes)
    cruise_len = descent_start - climb_end
    walk = np.cumsum(rng.normal(0, 25, cruise_len))
    walk = walk - walk.mean()
    walk = np.clip(walk, -loiter_variation_ft, loiter_variation_ft)
    alt[climb_end:descent_start] = cruise_alt_ft + walk

    # Descent (smooth ramp down)
    alt[descent_start:] = np.linspace(alt[descent_start - 1], 0, n_samples - descent_start) \
        + rng.normal(0, 30, n_samples - descent_start)

    alt = np.clip(alt, 0, None)
    return alt


def mission_phase_labels(n_samples, climb_minutes, descent_minutes, takeoff_pad=3):
    phases = np.empty(n_samples, dtype=object)
    climb_end = takeoff_pad + climb_minutes
    descent_start = n_samples - descent_minutes
    phases[:1] = "Taxi"
    phases[1:takeoff_pad] = "Takeoff"
    phases[takeoff_pad:climb_end] = "Climb"
    phases[climb_end:descent_start] = "Cruise_Loiter"
    phases[descent_start:n_samples - 1] = "Descent"
    phases[-1:] = "Landing"
    return phases


# ----------------------------------------------------------------------
# 3. FULL MISSION GENERATOR
# ----------------------------------------------------------------------
def generate_mission(mission_id, rng, start_time=None):
    mission_type = rng.choice(MISSION_TYPES)
    weather_name = rng.choice(list(WEATHER_PROFILES.keys()))
    isa_dev, hum_base, hum_var, wind_base, wind_var = WEATHER_PROFILES[weather_name]

    duration_hr = rng.uniform(8, 20)          # long-endurance mission
    n_samples = int(duration_hr * 60)          # 1 sample per minute
    cruise_alt_ft = rng.uniform(8000, 25000)   # up to MALE ceiling
    climb_minutes = int(np.clip(cruise_alt_ft / 1000 * 2.2, 15, 45))
    descent_minutes = int(climb_minutes * 0.8)

    start_time = start_time or (datetime(2026, 1, 1) + timedelta(days=int(mission_id)))
    timestamps = [start_time + timedelta(minutes=i) for i in range(n_samples)]

    altitude_ft = generate_altitude_profile(
        n_samples, cruise_alt_ft, climb_minutes, descent_minutes, rng=rng
    )
    phases = mission_phase_labels(n_samples, climb_minutes, descent_minutes)

    # ISA baseline temp/pressure from altitude, then add short-term turbulence noise
    temp_c, pressure_hpa = isa_temperature_pressure(altitude_ft, isa_dev)
    temp_c = temp_c + rng.normal(0, 0.6, n_samples)          # sensor/atmos noise
    pressure_hpa = pressure_hpa + rng.normal(0, 0.8, n_samples)

    # Humidity: base level + slow random walk + altitude decay (drier at altitude)
    hum_walk = np.cumsum(rng.normal(0, 1.0, n_samples))
    hum_walk -= hum_walk.mean()
    altitude_dryness = np.clip(altitude_ft / 25000, 0, 1) * 20  # drier up high
    relative_humidity_pct = np.clip(
        hum_base + hum_walk * (hum_var / 10) - altitude_dryness, 2, 100
    )

    # Wind: base + gust noise, plus stronger winds at altitude
    wind_altitude_boost = (altitude_ft / 25000) * 10
    wind_speed_kt = np.clip(
        wind_base + wind_altitude_boost + rng.normal(0, wind_var / 3, n_samples), 0, None
    )
    wind_relative_angle_deg = rng.uniform(0, 360, n_samples)

    air_density_kg_m3 = air_density(temp_c, pressure_hpa, relative_humidity_pct)

    df = pd.DataFrame({
        "mission_id": mission_id,
        "mission_type": mission_type,
        "weather_profile": weather_name,
        "timestamp": timestamps,
        "elapsed_min": np.arange(n_samples),
        "mission_phase": phases,
        "altitude_ft": altitude_ft.round(1),
        "OAT_C": temp_c.round(2),
        "pressure_hPa": pressure_hpa.round(2),
        "air_density_kg_m3": air_density_kg_m3.round(4),
        "relative_humidity_pct": relative_humidity_pct.round(1),
        "wind_speed_kt": wind_speed_kt.round(1),
        "wind_relative_angle_deg": wind_relative_angle_deg.round(1),
    })
    return df


# ----------------------------------------------------------------------
# 4. GENERATE ALL MISSIONS
# ----------------------------------------------------------------------
if __name__ == "__main__":
    N_MISSIONS = 15
    rng_master = np.random.default_rng(42)  # reproducible

    all_missions = []
    for i in range(1, N_MISSIONS + 1):
        mission_rng = np.random.default_rng(1000 + i)
        df = generate_mission(mission_id=i, rng=mission_rng)
        all_missions.append(df)

    full_df = pd.concat(all_missions, ignore_index=True)
    out_path = "/home/claude/dt_project/climate_dataset.csv"
    full_df.to_csv(out_path, index=False)

    print(f"Generated {N_MISSIONS} missions, {len(full_df)} total rows")
    print(f"Saved to {out_path}")
    print("\nPer-mission summary:")
    summary = full_df.groupby("mission_id").agg(
        mission_type=("mission_type", "first"),
        weather=("weather_profile", "first"),
        duration_min=("elapsed_min", "max"),
        max_alt_ft=("altitude_ft", "max"),
        min_OAT_C=("OAT_C", "min"),
        max_OAT_C=("OAT_C", "max"),
        min_pressure_hPa=("pressure_hPa", "min"),
    )
    print(summary.to_string())
