"""
Atmosphere Simulation & Flight Mission Profile Module
=====================================================
SIH26054 | MALE UAV Aero Piston Engine Digital Twin

Provides atmospheric physics (ISA troposphere model) and mission profile
generators (altitude, airspeed, throttle) representing realistic MALE UAV
flight phases:
- Taxi / Pre-flight Idle
- Takeoff & High-Rate Climb (up to 3,000m - 5,000m)
- Medium Altitude Long Endurance Cruise / Loiter
- Tactical Surveillance Dash
- Descent & Approach
"""

from __future__ import annotations
import math
from dataclasses import dataclass
from typing import Optional, Tuple, Callable


@dataclass
class AtmosphereState:
    altitude_m: float
    airspeed_mps: float
    temp_c: float
    temp_k: float
    pressure_pa: float
    density_kg_m3: float


def isa_troposphere(
    altitude_m: float,
    sea_level_temp_c: float = 15.0,
    sea_level_pressure_pa: float = 101325.0,
    temp_offset_c: float = 0.0
) -> AtmosphereState:
    """
    Computes ambient atmospheric parameters using International Standard Atmosphere (ISA)
    up to 11,000m (troposphere).
    """
    alt = max(0.0, min(altitude_m, 11000.0))
    t0 = sea_level_temp_c + 273.15 + temp_offset_c
    lapse_rate = 0.0065  # K/m
    g = 9.80665          # m/s^2
    r_air = 287.05       # J/(kg*K)

    t_k = t0 - lapse_rate * alt
    p_pa = sea_level_pressure_pa * math.pow(t_k / t0, g / (r_air * lapse_rate))
    rho = p_pa / (r_air * t_k)
    t_c = t_k - 273.15

    return AtmosphereState(
        altitude_m=altitude_m,
        airspeed_mps=0.0,
        temp_c=t_c,
        temp_k=t_k,
        pressure_pa=p_pa,
        density_kg_m3=rho
    )


class FlightMissionProfile:
    """
    Simulates realistic MALE UAV (Heron / Rotax 914) mission profiles.
    Allows either continuous time-based mission profiles or dynamic override states.
    """

    def __init__(self, mission_type: str = "surveillance_patrol"):
        self.mission_type = mission_type
        # Manual override controls
        self.manual_override = False
        self.manual_throttle = 0.65
        self.manual_altitude_m = 3000.0
        self.manual_airspeed_mps = 35.0
        self.manual_temp_override_c: Optional[float] = None

    def set_manual(self, throttle: float, altitude_m: float, airspeed_mps: float, temp_c: Optional[float] = None):
        self.manual_override = True
        self.manual_throttle = max(0.0, min(1.0, throttle))
        self.manual_altitude_m = max(0.0, altitude_m)
        self.manual_airspeed_mps = max(0.0, airspeed_mps)
        self.manual_temp_override_c = temp_c

    def clear_manual(self):
        self.manual_override = False

    def get_flight_condition(self, t: float) -> Tuple[float, float, Optional[float], float]:
        """
        Returns (altitude_m, airspeed_mps, ambient_temp_override_c, throttle)
        """
        if self.manual_override:
            return (
                self.manual_altitude_m,
                self.manual_airspeed_mps,
                self.manual_temp_override_c,
                self.manual_throttle
            )

        # Accelerated interactive demo mission
        # 0 - 4s: Idle warmup on runway (alt = 0m)
        # 4 - 20s: Takeoff roll & initial climb (alt climbs 0 -> 1500m)
        # 20 - 40s: Climb to cruise altitude (alt climbs 1500 -> 3000m)
        # 40 - 480s: High-altitude cruise / surveillance loiter (alt = 3000m, speed = 35 m/s)
        # 480 - 600s: Controlled descent
        # 600s+: Approach
        if t < 4.0:
            alt = 0.0
            speed = 5.0
            throttle = 0.20
        elif t < 20.0:
            progress = (t - 4.0) / 16.0
            alt = 1500.0 * progress
            speed = 10.0 + 25.0 * progress
            throttle = 0.25 + 0.75 * progress
        elif t < 40.0:
            progress = (t - 20.0) / 20.0
            alt = 1500.0 + 1500.0 * progress
            speed = 35.0
            throttle = 0.95
        elif t < 480.0:
            alt = 3000.0
            speed = 35.0
            throttle = 0.65
        elif t < 600.0:
            progress = (t - 480.0) / 120.0
            alt = 3000.0 * (1.0 - progress)
            speed = 35.0 - 15.0 * progress
            throttle = 0.65 - 0.50 * progress
        else:
            alt = 0.0
            speed = 15.0
            throttle = 0.20

        return (alt, speed, None, throttle)

    def ambient_callback(self) -> Callable[[float], Tuple[float, float, Optional[float]]]:
        """Provides the ambient_fn(t) callback required by RotaxDigitalTwin."""
        return lambda t: self.get_flight_condition(t)[:3]

    def throttle_callback(self) -> Callable[[float], float]:
        """Provides the throttle_fn(t) callback required by RotaxDigitalTwin."""
        return lambda t: self.get_flight_condition(t)[3]
