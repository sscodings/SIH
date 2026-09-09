"""
Rotax 914F Digital Twin — Physics-Based Engine Simulation Core
================================================================
SIH26054 (DRDO) | MALE UAV Aero Piston Engine Digital Twin

This module is the "engine simulation" block from the team's
architecture flowchart: it produces the physics-based baseline of
"how the engine SHOULD be behaving" for any given ambient condition +
throttle command, and supports deliberate fault injection so the
downstream ML/anomaly-detection layer has labelled synthetic data to
train and test against (there is no public run-to-failure dataset for
this engine class, so this simulator IS the data source).

Reference engine: Rotax 914 F2/F3/F4 (EASA TCDS No. E.122)
    - 4-cyl, 4-stroke, horizontally opposed, turbocharged
    - Liquid-cooled heads, air-cooled cylinder barrels
    - Bore 79.5 mm x Stroke 61 mm -> 1211.2 cc total displacement
    - Compression ratio 9.0:1
    - 115 hp (85.8 kW) @ 5800 RPM (5-min takeoff limit)
    - Max continuous 5500 RPM
    - Integrated reduction gearbox, i = 2.273 (F2/F3)

Physics references used for the formulations below:
    - Heywood, "Internal Combustion Engine Fundamentals" (speed-density
      breathing equation, Chen-Flynn friction correlation, heat-balance
      splits, MBT timing efficiency curve)
    - Vogel equation for oil viscosity vs. temperature
    - Hagen-Poiseuille flow for oil-gallery pressure drop
    - Newton's law of cooling / lumped thermal capacitance for CHT & oil
    - Stefan-Boltzmann radiative loss (minor term, included for
      completeness)
    - International Standard Atmosphere (troposphere model) for ambient
      conditions vs. altitude

IMPORTANT: several constants below (thermal capacitances, cooling
conductances, friction/prop-load coefficients, oil-gallery geometry,
Vogel coefficients) are *engineering placeholders* tuned only to make
the overall system self-consistent and produce qualitatively correct
behaviour (right order of magnitude, right direction of every fault
signature). They are NOT calibrated against a real Rotax 914 test
cell. Swap them out for manufacturer/dyno data if you get access to
it — the model structure is what matters for the SIH demo, and the
structure is a faithful match to the mechanisms described in the
PS's fault list.

Dependencies: numpy, scipy only (no CoolProp — ideal-gas air
properties are accurate enough at this fidelity level; swap in
CoolProp for T/P-dependent cp, R if higher fidelity is ever needed).
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np
from scipy.integrate import solve_ivp

# ============================================================================
# 1. ENGINE SPECIFICATIONS  (Rotax 914 F2/F3/F4 — EASA TCDS E.122)
# ============================================================================


@dataclass
class EngineSpecs:
    # --- Geometry / rating (from type-certificate data / manufacturer specs) ---
    n_cylinders: int = 4
    bore_m: float = 0.0795
    stroke_m: float = 0.061
    displacement_m3: float = 1211.2e-6          # 1211.2 cc total
    compression_ratio: float = 9.0
    gear_ratio: float = 2.273                    # prop reduction i (F2/F3)
    rpm_idle: float = 1400.0
    rpm_max_continuous: float = 5500.0
    rpm_max_takeoff: float = 5800.0               # 5-minute limit
    power_max_takeoff_w: float = 84600.0          # 115 hp @ 5800 RPM
    afr_stoich: float = 14.7                      # avgas/mogas
    fuel_lhv_j_per_kg: float = 44.0e6

    # --- Combustion energy split (Heywood-style heat balance, approx.) ---
    eta_thermal_indicated: float = 0.30
    frac_heat_to_head: float = 0.28
    frac_heat_to_exhaust: float = 0.32
    # remaining ~0.10 -> friction/misc, accounted for via friction torque heat

    # --- Rotating inertia & mechanical calibration ---
    I_rotating_kg_m2: float = 1.5                 # Combined crank + prop disc inertia
    k_prop_load: float = 3.55e-4                  # N*m per (rad/s)^2, tuned so
                                                    # equilibrium RPM ~ 5780 RPM (< 5800 limit)
                                                    # at full throttle, sea level
    friction_c0: float = 2.0
    friction_c1: float = 3.0e-5                   # per Pa of MAP
    friction_c2: float = 6.0e-3                   # per rad/s
    friction_c3: float = 8.0e-6                   # per (rad/s)^2

    # --- Thermal capacitances (lumped) ---
    cyl_thermal_capacity_j_per_k: float = 2500.0   # per-cylinder head
    oil_thermal_capacity_j_per_k: float = 4200.0   # ~3 L system

    # --- Cooling conductances (baseline, before fault multipliers) ---
    h_a_cooling_base: float = 55.0                 # W/K per cylinder
    h_oilcooler_base: float = 25.0                 # W/K

    # --- Oil viscosity, Vogel eq.: mu(T_C) = a * exp(b / (T_C + c)) ---
    visc_a: float = 0.00024
    visc_b: float = 820.0
    visc_c: float = 95.0

    # --- Oil pump / gallery (Hagen-Poiseuille) ---
    gallery_length_m: float = 0.35
    gallery_radius_m: float = 0.0022
    pump_flow_coeff: float = 5.5e-8                # m^3/s per RPM
    oil_relief_pressure_pa: float = 5.5e5           # ~5.5 bar relief setpoint

    # --- Electrical ---
    v_regulated: float = 14.2
    rpm_alternator_cutin: float = 1400.0


# ============================================================================
# 2. ATMOSPHERE MODEL (International Standard Atmosphere, troposphere)
# ============================================================================


def isa_atmosphere(altitude_m: float, sea_level_temp_c: float = 15.0,
                    sea_level_pressure_pa: float = 101325.0):
    """Return (T_kelvin, P_pa, rho_kg_m3) at the given altitude (<11 km)."""
    T0 = sea_level_temp_c + 273.15
    L = 0.0065  # K/m
    T = T0 - L * altitude_m
    P = sea_level_pressure_pa * (T / T0) ** (9.80665 / (287.05 * L))
    rho = P / (287.05 * T)
    return T, P, rho


# ============================================================================
# 3. AIR / FUEL / COMBUSTION SUBMODELS
# ============================================================================


def compute_map_pa(throttle: float, rpm: float, ambient_pressure_pa: float) -> float:
    """Simplified MAP model: naturally-aspirated throttle-plate restriction
    plus turbocharger boost (automatic wastegate) that spools in above
    ~3000 RPM and is capped near the Rotax 914's ~1.35x sea-level boost
    limit (~40 inHg absolute)."""
    na_map = ambient_pressure_pa * (0.25 + 0.75 * throttle)
    spool_factor = np.clip((rpm - 3000.0) / 2000.0, 0.0, 1.0) * throttle
    boosted_target = ambient_pressure_pa * 1.35
    map_pa = na_map + spool_factor * max(0.0, boosted_target - na_map)
    return min(map_pa, 1.42e5)


def volumetric_efficiency(throttle: float) -> float:
    """Volumetric efficiency drops off at low throttle due to pumping
    losses across a near-closed throttle plate — using a flat eta_v
    regardless of throttle position was over-predicting idle airflow
    (and hence idle torque) badly enough to push the "idle" equilibrium
    RPM well above realistic values, so this is throttle-dependent."""
    return 0.35 + 0.50 * throttle


def air_mass_flow_total(map_pa: float, rpm: float, t_airbox_k: float,
                         specs: EngineSpecs, eta_v: float) -> float:
    """Speed-density breathing equation (Heywood) — total engine air
    mass flow rate [kg/s]."""
    R_SPECIFIC_AIR = 287.05
    rpm = max(rpm, 1.0)
    return (map_pa * specs.displacement_m3 * rpm * eta_v) / (
        2 * 60 * R_SPECIFIC_AIR * t_airbox_k
    )


def afr_target(throttle: float) -> float:
    """Target AFR schedule: leans out toward cruise, richens for cooling
    margin at high power (typical carbureted aviation-engine behaviour)."""
    return float(np.interp(throttle, [0.0, 0.6, 1.0], [14.7, 14.0, 12.5]))


def egt_afr_multiplier(phi: float) -> float:
    """Empirical EGT sensitivity to equivalence ratio (phi = AFR_stoich /
    AFR_actual). Lean (phi < 0.90) spikes EGT; rich (phi > 1.15) cools
    it. Thresholds match the AI/ML team's fault-formulation doc."""
    if phi < 0.90:
        return 1.15 + (0.90 - phi) * 1.5
    if phi > 1.15:
        return max(0.4, 1.0 - (phi - 1.15) * 0.6)
    return 1.0 + 0.05 * np.sin((phi - 0.90) / 0.25 * np.pi)


def timing_efficiency_factor(drift_deg: float, k: float = 0.0006) -> float:
    """Quadratic efficiency penalty around Minimum-spark-advance-for-
    Best-Torque (MBT) — standard SI-engine timing-sensitivity shape."""
    return max(0.5, 1.0 - k * drift_deg ** 2)


def chen_flynn_friction_torque(rpm: float, map_pa: float, specs: EngineSpecs) -> float:
    """Chen-Flynn-style mechanical friction torque correlation."""
    omega = rpm * 2 * np.pi / 60.0
    return (
        specs.friction_c0
        + specs.friction_c1 * map_pa
        + specs.friction_c2 * omega
        + specs.friction_c3 * omega ** 2
    )


def oil_viscosity_vogel(t_oil_c: float, specs: EngineSpecs) -> float:
    """Vogel equation: mu(T) = a * exp(b / (T + c)), T in deg C."""
    t_oil_c = max(t_oil_c, -30.0)
    return specs.visc_a * np.exp(specs.visc_b / (t_oil_c + specs.visc_c))


def alternator_voltage(rpm: float, specs: EngineSpecs, regulator_failure: bool,
                        rng: np.random.Generator) -> float:
    if rpm < specs.rpm_alternator_cutin:
        v = 11.5 + (specs.v_regulated - 11.5) * (rpm / specs.rpm_alternator_cutin)
    else:
        v = specs.v_regulated
    if regulator_failure:
        v += rng.normal(0, 1.5)
    return v


def compute_vibration_features(rpm: float, fault_state: dict) -> dict:
    """Rotational-harmonic vibration feature summary (this stands in for
    an FFT of a high-rate accelerometer stream — a real implementation
    would FFT a kHz-sampled waveform; here we synthesize the summary
    features directly since that's what the ML layer actually consumes).

    f0     = 1X crank fundamental (unbalance / prop tracking)
    f_cam  = 0.5X camshaft fundamental (misfire / uneven combustion
             shows up here as a sideband, since a given cylinder only
             fires once every 2 crank revolutions)
    f_fire = 2X engine firing frequency (4-cylinder, 4-stroke)
    """
    f0 = rpm / 60.0
    f_cam = f0 / 2.0
    f_fire = 2.0 * f0
    f_gear = 43.0 * f0  # Z_TEETH = 43 reduction gearbox mesh frequency
    amp_1x = 0.05 + fault_state["unbalance_extra"]
    amp_cam = 0.03 + 0.9 * (fault_state["extra_vibration"] + 0.5 * fault_state["rpm_instability"])
    amp_fire = 0.08
    rms = float(np.sqrt(amp_1x ** 2 + amp_cam ** 2 + amp_fire ** 2))
    return dict(f0_hz=f0, f_cam_hz=f_cam, f_fire_hz=f_fire, f_gear_hz=f_gear,
                amp_1x_g=amp_1x, amp_cam_g=amp_cam, amp_fire_g=amp_fire, rms_g=rms)


# ============================================================================
# 4. FAULT INJECTION — matches the 8 fault categories in the PS/PARAMETERS DOC
# ============================================================================


@dataclass
class FaultEvent:
    kind: str
    start_t: float
    severity: float = 1.0
    cylinder: Optional[int] = None
    ramp_s: float = 20.0
    extra: dict = field(default_factory=dict)


class FaultInjector:
    """Registry of injectable faults. Each fault ramps in linearly over
    `ramp_s` seconds after `start_t` so telemetry shows a physically
    plausible developing trend rather than a step discontinuity —
    this also gives the RUL/health-index layer something to actually
    learn a decay curve from.

    Supported kinds: misfire, injector_abnormal, cooling_degradation,
    lubrication_issue, sensor_drift, combustion_instability,
    overheating_trend, abnormal_vibration, regulator_failure.
    """

    def __init__(self):
        self.events: list[FaultEvent] = []

    def add(self, kind: str, start_t: float, severity: float = 1.0,
            cylinder: Optional[int] = None, ramp_s: float = 20.0, **extra):
        self.events.append(FaultEvent(kind, start_t, severity, cylinder, ramp_s, extra))
        return self

    def _ramp(self, ev: FaultEvent, t: float) -> float:
        if t < ev.start_t:
            return 0.0
        return ev.severity * min(1.0, (t - ev.start_t) / max(ev.ramp_s, 1e-6))

    def get_state(self, t: float, n_cyl: int = 4) -> dict:
        state = dict(
            eta_comb=np.ones(n_cyl),
            afr_bias=np.zeros(n_cyl),
            timing_drift_deg=0.0,
            cooling_factor=1.0,
            oil_leak_factor=1.0,
            oil_cooling_factor=1.0,
            extra_vibration=0.0,
            unbalance_extra=0.0,
            rpm_instability=0.0,
            sensor_drift={},
            regulator_failure=False,
        )
        for ev in self.events:
            s = self._ramp(ev, t)
            if s <= 0:
                continue
            idx = ev.cylinder if ev.cylinder is not None else 0

            if ev.kind == "misfire":
                state["eta_comb"][idx] *= (1.0 - 0.7 * s)
                state["extra_vibration"] += 0.6 * s
                state["rpm_instability"] += 0.5 * s

            elif ev.kind == "injector_abnormal":
                direction = ev.extra.get("direction", "lean")
                bias = (2.0 if direction == "rich" else -2.0) * s
                state["afr_bias"][idx] += bias

            elif ev.kind == "cooling_degradation":
                state["cooling_factor"] *= (1.0 - 0.6 * s)

            elif ev.kind == "lubrication_issue":
                state["oil_leak_factor"] *= (1.0 - 0.7 * s)
                state["oil_cooling_factor"] *= (1.0 - 0.3 * s)

            elif ev.kind == "sensor_drift":
                sensor = ev.extra.get("sensor", f"CHT_{idx + 1}")
                rate = ev.extra.get("drift_per_s", 0.05)
                state["sensor_drift"][sensor] = (
                    state["sensor_drift"].get(sensor, 0.0) + rate * (t - ev.start_t) * s
                )

            elif ev.kind == "combustion_instability":
                state["rpm_instability"] += 0.8 * s
                state["extra_vibration"] += 0.4 * s

            elif ev.kind == "overheating_trend":
                state["cooling_factor"] *= (1.0 - 0.4 * s)
                state["oil_cooling_factor"] *= (1.0 - 0.3 * s)

            elif ev.kind == "abnormal_vibration":
                state["unbalance_extra"] += 0.8 * s

            elif ev.kind == "regulator_failure":
                state["regulator_failure"] = True

        return state


# ============================================================================
# 5. THE DIGITAL TWIN
# ============================================================================


AmbientFn = Callable[[float], tuple]     # t -> (altitude_m, airspeed_mps, ambient_override_c|None)
ThrottleFn = Callable[[float], float]    # t -> throttle in [0, 1]


class RotaxDigitalTwin:
    def __init__(self, specs: Optional[EngineSpecs] = None,
                 faults: Optional[FaultInjector] = None, seed: int = 42):
        self.specs = specs or EngineSpecs()
        self.faults = faults or FaultInjector()
        self.rng = np.random.default_rng(seed)

    # -- core physics: one call returns BOTH the ODE derivative and the
    #    full set of derived/algebraic sensor outputs at this instant --
    def _physics_step(self, t: float, y: np.ndarray, throttle_fn: ThrottleFn,
                       ambient_fn: AmbientFn):
        specs = self.specs
        rpm = max(float(y[0]), 200.0)
        cht = np.array(y[1:5], dtype=float)
        t_oil = float(y[5])
        omega = rpm * 2 * np.pi / 60.0

        throttle = float(np.clip(throttle_fn(t), 0.0, 1.0))
        altitude_m, airspeed_mps, ambient_override_c = ambient_fn(t)
        t_amb_k, p_amb_pa, _ = isa_atmosphere(altitude_m)
        if ambient_override_c is not None:
            t_amb_k = ambient_override_c + 273.15
        t_amb_c = t_amb_k - 273.15

        fs = self.faults.get_state(t, specs.n_cylinders)

        # --- breathing / fuel ---
        map_pa = compute_map_pa(throttle, rpm, p_amb_pa)
        eta_v = volumetric_efficiency(throttle)
        m_dot_a_total = air_mass_flow_total(map_pa, rpm, t_amb_k, specs, eta_v)
        m_dot_a_cyl = m_dot_a_total / specs.n_cylinders

        afr_cyl = np.clip(afr_target(throttle) + fs["afr_bias"], 8.0, 25.0)
        m_dot_f_cyl = m_dot_a_cyl / afr_cyl
        phi_cyl = specs.afr_stoich / afr_cyl

        # --- combustion energy release & split ---
        eta_comb = fs["eta_comb"]
        q_released_cyl = eta_comb * m_dot_f_cyl * specs.fuel_lhv_j_per_kg

        q_head_cyl = specs.frac_heat_to_head * q_released_cyl
        egt_mult = np.array([egt_afr_multiplier(p) for p in phi_cyl])
        q_exhaust_cyl = specs.frac_heat_to_exhaust * q_released_cyl * egt_mult
        timing_factor = timing_efficiency_factor(fs["timing_drift_deg"])
        q_indicated_cyl = specs.eta_thermal_indicated * q_released_cyl * timing_factor

        # --- rotational dynamics ---
        torque_indicated = float(np.sum(q_indicated_cyl)) / omega
        torque_friction = chen_flynn_friction_torque(rpm, map_pa, specs)
        torque_load = specs.k_prop_load * omega ** 2
        instability = fs["rpm_instability"]
        torque_noise = instability * self.rng.normal(0, 0.15) * max(torque_indicated, 1e-3)

        domega_dt = (torque_indicated - torque_friction - torque_load + torque_noise) / specs.I_rotating_kg_m2
        drpm_dt = domega_dt * 60.0 / (2 * np.pi)

        # --- per-cylinder CHT thermal balance (lumped capacitance) ---
        h_a = (
            specs.h_a_cooling_base
            * (0.4 + 0.6 * min(rpm / specs.rpm_max_continuous, 1.2))
            * (1 + 0.03 * airspeed_mps)
            * fs["cooling_factor"]
        )
        q_conv = h_a * (cht - t_amb_c)
        eps, sigma, a_rad = 0.85, 5.670374419e-8, 0.02
        q_rad = eps * sigma * a_rad * (((cht + 273.15) ** 4) - ((t_amb_c + 273.15) ** 4))
        dcht_dt = (q_head_cyl - q_conv - q_rad) / specs.cyl_thermal_capacity_j_per_k

        # --- oil thermal balance ---
        q_friction_heat = torque_friction * omega
        h_oil = specs.h_oilcooler_base * (1 + 0.02 * airspeed_mps) * fs["oil_cooling_factor"]
        q_oil_out = h_oil * (t_oil - t_amb_c)
        dtoil_dt = (q_friction_heat - q_oil_out) / specs.oil_thermal_capacity_j_per_k

        dydt = np.concatenate(([drpm_dt], dcht_dt, [dtoil_dt]))

        # --- algebraic outputs (oil pressure, EGT, electrical, vibration) ---
        mu_oil = oil_viscosity_vogel(t_oil, specs)
        q_pump = specs.pump_flow_coeff * rpm * fs["oil_leak_factor"]
        p_oil_raw = (8 * mu_oil * specs.gallery_length_m * q_pump) / (np.pi * specs.gallery_radius_m ** 4)
        p_oil = min(p_oil_raw, specs.oil_relief_pressure_pa)
        ratio_lube = p_oil / max(mu_oil, 1e-9)

        cp_exhaust = 1150.0
        m_dot_exh_cyl = m_dot_a_cyl + m_dot_f_cyl
        egt_cyl = t_amb_c + q_exhaust_cyl / (m_dot_exh_cyl * cp_exhaust)

        v_alt = alternator_voltage(rpm, specs, fs["regulator_failure"], self.rng)
        vib = compute_vibration_features(rpm, fs)

        # Ambient-normalized CHT: THIS, not raw CHT, is the feature the
        # anomaly detector should actually threshold on — 70C engine at
        # 30C ambient and 80C engine at 40C ambient are the same margin,
        # per the parameters doc's explicit note on this.
        delta_cht_ambient = cht - t_amb_c

        outputs = dict(
            t=t, throttle=throttle, altitude_m=altitude_m, airspeed_mps=airspeed_mps,
            t_ambient_c=t_amb_c, p_ambient_pa=p_amb_pa, map_pa=map_pa,
            rpm=rpm, cht_c=cht.copy(), delta_cht_ambient=delta_cht_ambient,
            egt_c=egt_cyl, oil_temp_c=t_oil,
            oil_pressure_pa=p_oil, ratio_lube=ratio_lube,
            fuel_flow_kg_s=float(np.sum(m_dot_f_cyl)), afr_cyl=afr_cyl, phi_cyl=phi_cyl,
            alternator_v=v_alt,
            torque_indicated_nm=torque_indicated, torque_friction_nm=torque_friction,
            torque_load_nm=torque_load,
            vibration=vib,
            fault_state=fs,
        )
        return dydt, outputs

    # -- offline mission run (for CSV export / mission replay / Unity feed) --
    def run_mission(self, duration_s: float, throttle_fn: ThrottleFn, ambient_fn: AmbientFn,
                     dt_output: float = 1.0, y0: Optional[np.ndarray] = None) -> dict:
        if y0 is None:
            y0 = np.array([specs_idle_state(self.specs)])[0]

        t_eval = np.arange(0.0, duration_s + 1e-9, dt_output)

        sol = solve_ivp(
            fun=lambda t, y: self._physics_step(t, y, throttle_fn, ambient_fn)[0],
            t_span=(0.0, duration_s), y0=y0, t_eval=t_eval,
            method="RK45", max_step=1.0,
        )

        rows = []
        for t, y in zip(sol.t, sol.y.T):
            _, out = self._physics_step(t, y, throttle_fn, ambient_fn)
            rows.append(out)
        return {"t": sol.t, "rows": rows, "y": sol.y}

    # -- real-time generator: one physics step per call, suitable for a
    #    WebSocket push loop feeding the dashboard / Unity model --
    def stream_realtime(self, throttle_fn: ThrottleFn, ambient_fn: AmbientFn,
                         dt: float = 0.5, y0: Optional[np.ndarray] = None):
        if y0 is None:
            y0 = specs_idle_state(self.specs)
        y = y0.copy()
        t = 0.0
        while True:
            dydt, out = self._physics_step(t, y, throttle_fn, ambient_fn)
            y = y + dydt * dt          # simple explicit Euler step for the
            t += dt                     # streaming case (fine at dt<=0.5s;
            yield out                   # use run_mission's RK45 for anything
                                         # that needs tight accuracy offline)

    # -- export helpers matching the doc's "shared CSV/JSON file" hand-off --
    @staticmethod
    def export_csv(mission_result: dict, path: str):
        rows = mission_result["rows"]
        fieldnames = [
            "t", "throttle", "altitude_m", "airspeed_mps", "t_ambient_c",
            "rpm", "cht_1", "cht_2", "cht_3", "cht_4",
            "egt_1", "egt_2", "egt_3", "egt_4",
            "oil_temp_c", "oil_pressure_bar", "ratio_lube",
            "fuel_flow_kg_s", "alternator_v", "vib_rms_g",
        ]
        with open(path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for r in rows:
                writer.writerow({
                    "t": round(r["t"], 2),
                    "throttle": round(r["throttle"], 3),
                    "altitude_m": round(r["altitude_m"], 1),
                    "airspeed_mps": round(r["airspeed_mps"], 1),
                    "t_ambient_c": round(r["t_ambient_c"], 1),
                    "rpm": round(r["rpm"], 1),
                    "cht_1": round(r["cht_c"][0], 1), "cht_2": round(r["cht_c"][1], 1),
                    "cht_3": round(r["cht_c"][2], 1), "cht_4": round(r["cht_c"][3], 1),
                    "egt_1": round(r["egt_c"][0], 1), "egt_2": round(r["egt_c"][1], 1),
                    "egt_3": round(r["egt_c"][2], 1), "egt_4": round(r["egt_c"][3], 1),
                    "oil_temp_c": round(r["oil_temp_c"], 1),
                    "oil_pressure_bar": round(r["oil_pressure_pa"] / 1e5, 2),
                    "ratio_lube": round(r["ratio_lube"], 3),
                    "fuel_flow_kg_s": round(r["fuel_flow_kg_s"], 5),
                    "alternator_v": round(r["alternator_v"], 2),
                    "vib_rms_g": round(r["vibration"]["rms_g"], 3),
                })

    @staticmethod
    def snapshot_to_json(out: dict) -> str:
        """WebSocket-message-ready JSON for a single instant — this is
        the schema Unity / the dashboard should parse on each tick."""
        msg = {
            "t": round(out["t"], 2),
            "rpm": round(out["rpm"], 1),
            "cht_c": [round(v, 1) for v in out["cht_c"]],
            "egt_c": [round(v, 1) for v in out["egt_c"]],
            "oil_temp_c": round(out["oil_temp_c"], 1),
            "oil_pressure_bar": round(out["oil_pressure_pa"] / 1e5, 2),
            "fuel_flow_kg_s": round(out["fuel_flow_kg_s"], 5),
            "alternator_v": round(out["alternator_v"], 2),
            "vibration_rms_g": round(out["vibration"]["rms_g"], 3),
            "ambient_c": round(out["t_ambient_c"], 1),
            "altitude_m": round(out["altitude_m"], 1),
        }
        return json.dumps(msg)


def specs_idle_state(specs: EngineSpecs) -> np.ndarray:
    """Reasonable cold/idle initial state: [rpm, cht x4, oil_temp]."""
    return np.array([specs.rpm_idle, 55.0, 55.0, 55.0, 55.0, 35.0])


# ============================================================================
# 6. DEMO MISSION — run this file directly to generate a sample dataset
# ============================================================================

if __name__ == "__main__":
    import os

    def throttle_profile(t: float) -> float:
        """Idle -> climb -> cruise -> descent -> idle, ~12 minute mission."""
        if t < 30:
            return 0.15
        if t < 120:
            return 0.15 + 0.85 * (t - 30) / 90       # ramp to full power (climb)
        if t < 480:
            return 1.0 if t < 150 else 0.65           # climb at full power, then cruise
        if t < 600:
            return 0.65 - 0.5 * (t - 480) / 120        # descent
        return 0.15

    def ambient_profile(t: float):
        """Altitude ramps 0 -> 3000 m during climb, holds, then descends.
        Airspeed similarly ramps up. No ambient-temperature override
        (let ISA atmosphere set it from altitude)."""
        if t < 150:
            alt = 3000.0 * (t / 150.0)
        elif t < 480:
            alt = 3000.0
        elif t < 600:
            alt = 3000.0 * (1 - (t - 480) / 120.0)
        else:
            alt = 0.0
        airspeed = 15.0 + 25.0 * min(t / 150.0, 1.0)
        return alt, airspeed, None

    faults = FaultInjector()
    # Inject a developing misfire on cylinder #2 (index 1) starting mid-cruise
    faults.add("misfire", start_t=300.0, severity=0.8, cylinder=1, ramp_s=60.0)
    # Inject a slow cooling-fin blockage across all cylinders later in the mission
    faults.add("cooling_degradation", start_t=420.0, severity=0.5, ramp_s=90.0)

    twin = RotaxDigitalTwin(faults=faults)
    result = twin.run_mission(duration_s=720.0, throttle_fn=throttle_profile,
                               ambient_fn=ambient_profile, dt_output=1.0)

    out_path = os.path.join(os.path.dirname(__file__), "rotax914_digital_twin_demo.csv")
    RotaxDigitalTwin.export_csv(result, out_path)

    rows = result["rows"]
    print(f"Simulated {len(rows)} samples over {result['t'][-1]:.0f}s mission.")
    checkpoints = [0, 149, 299, 359, 479, 599, 719]
    print(f"{'t':>5} {'RPM':>7} {'CHT2(faulted)':>14} {'EGT2':>7} {'OilP(bar)':>10} {'VibRMS':>8}")
    for i in checkpoints:
        if i >= len(rows):
            continue
        r = rows[i]
        print(f"{r['t']:5.0f} {r['rpm']:7.0f} {r['cht_c'][1]:14.1f} {r['egt_c'][1]:7.1f} "
              f"{r['oil_pressure_pa']/1e5:10.2f} {r['vibration']['rms_g']:8.3f}")

    print("\nSample real-time WebSocket message (what Unity/dashboard would receive):")
    print(RotaxDigitalTwin.snapshot_to_json(rows[300]))

    print(f"\nFull mission CSV written to: {out_path}")
