"""
Rotax 914F Engine Physics Simulation Module
--------------------------------------------
Implements the exact formulas from Rotax914_ML_Formulas.pdf, driven by the
existing climate_dataset.csv (atmospheric/mission time series).

Every constant that was NOT given in the source formula document is marked
with `# ASSUMED:` and a justification. These should be reviewed/tuned before
treating this as final calibration -- the document gives equation structure,
not numeric calibration data (none exists publicly for the 914F).

Formula section numbers below match the source PDF sections 1-5.
"""

import numpy as np
import pandas as pd

# ============================================================
# ENGINE CONSTANTS (Rotax 914F confirmed specs)
# ============================================================
V_DISP_TOTAL_CM3 = 1211.2          # confirmed spec: total displacement
V_DISP_M3 = (V_DISP_TOTAL_CM3 / 1e6)  # convert cm^3 -> m^3
N_CYLINDERS = 4                     # confirmed spec
R_SPEC_AIR = 287.05                 # J/(kg*K), specific gas constant for dry air
AFR_STOICH = 14.7                   # given in doc, section 1.3
RATED_POWER_W = 115 * 745.7         # 115 HP -> Watts, confirmed spec
RATED_RPM = 5800                    # confirmed spec
CRUISE_RPM = 5200                   # confirmed from pilot/operator data
CRITICAL_ALT_FT = 16000             # confirmed: TCU v4.6 critical altitude
SEA_LEVEL_PRESSURE_HPA = 1013.25

# ASSUMED: volumetric efficiency, typical turbocharged 4-stroke range 0.80-0.90
ETA_V = 0.85

# ASSUMED: target AFR by mission phase (aviation piston engines run
# rich-of-peak for cooling margin, especially at high power settings)
AFR_TARGET = {
    "Taxi": 13.5, "Takeoff": 12.5, "Climb": 12.8,
    "Cruise_Loiter": 13.2, "Descent": 14.0, "Landing": 13.5,
}

# ASSUMED: RPM demand by mission phase (grounded in confirmed cruise RPM
# 5200-5500 range from Rotax operator data)
RPM_TARGET = {
    "Taxi": 1800, "Takeoff": 5800, "Climb": 5500,
    "Cruise_Loiter": 5200, "Descent": 4200, "Landing": 2200,
}

# ASSUMED: fraction of rated power demanded per phase (drives MAP target)
POWER_FRACTION = {
    "Taxi": 0.05, "Takeoff": 1.00, "Climb": 0.85,
    "Cruise_Loiter": 0.65, "Descent": 0.25, "Landing": 0.10,
}

# ---- Thermal model constants (Section 2.1) ----
# ASSUMED: effective thermal mass of the full head/cooling-jacket assembly
# (all 4 cylinder heads + coolant in circuit, ~9kg aluminum-equivalent * ~900 J/kgK + coolant contribution)
# Sized so the CHT thermal time constant (tau = C_CYL / UA) is ~2 minutes,
# consistent with how quickly CHT is observed to respond in real operator logs.
C_CYL = 18000.0          # J/K, ASSUMED
H_EFF_BASE = 150.0        # W/(m^2*K), ASSUMED baseline convective/liquid heat transfer coefficient
A_EFF = 1.9               # m^2, ASSUMED effective total cooling area (fins + liquid jacket + radiator contact)
FUEL_LHV = 43_000_000     # J/kg, lower heating value of avgas/mogas (standard published value)
COMBUSTION_TO_HEAD_FRACTION = 0.115  # ASSUMED: fraction of combustion energy rejected via cyl head path
# Calibration check across phases (verified numerically), CHT_eq = T_ambient + Q_combustion/UA:
#   Climb   (~5C amb,  0.85 power): CHT_eq ~ 104 C
#   Cruise  (~-10C amb, 0.65 power, high alt -> thinner cooling air): CHT_eq ~ 81 C
#   Takeoff (~20C amb, 1.00 power): CHT_eq ~ 123 C  (highest, but under 135C max spec)
#   Descent (~10C amb, 0.25 power): CHT_eq ~ 49 C
# These land within/near the confirmed real CHT envelope (max spec 135C,
# observed climb CHT ~112C in Rotax operator logs) instead of pinning at
# the clamp for most of the flight.

# ---- Oil thermal lag (gap-filled, since doc did not give oil temp vs ambient) ----
OIL_THERMAL_TAU_S = 900.0    # ASSUMED time constant (15 min) -- oil mass responds slower than CHT
OIL_TEMP_FLOOR_C = 50.0       # confirmed: Rotax min oil temp spec
OIL_TEMP_TARGET_GAIN_CHT = 0.55  # ASSUMED: oil steady-state tracks a blend of CHT and ambient

# ---- Oil viscosity Vogel-Fulcher-Tammann (VFT) equation (Section 3.1 upgrade) ----
# Upgraded to exact VFT form: mu(T_oil) = A * exp(B / (T_oil - C)) per Digital_Twin_Math_Upgrades.pdf.
# Note the minus sign in (T_oil - C). Refitted to confirmed 15W-50 semi-synthetic oil calibration:
# mu(50C)=0.15 Pa.s, mu(95C)=0.02 Pa.s, mu(130C)=0.009 Pa.s.
# With T_oil in Celsius: C = -33.108725 C (giving T_oil - C = T_oil + 33.109 C).
VFT_A = 4.84076340e-04   # Pa.s
VFT_B = 476.723945        # C
VFT_C = -33.108725        # C
VOGEL_A = VFT_A           # backward compatibility alias
VOGEL_B = VFT_B
VOGEL_C = -VFT_C

# ---- Hagen-Poiseuille oil gallery (Section 3.2) ----
# ASSUMED effective total lubrication-circuit geometry (galleries + cooler +
# filter flow path combined, not a single passage), reverse-derived so that
# P_oil lands in the confirmed real range: ~4.8 bar cold/high-viscosity,
# ~3.5 bar hot/low-viscosity (matches operator-reported "4.8 Bar cold,
# drops to 3.5 Bar when oil heats up").
L_GALLERY = 4.0         # m, ASSUMED effective total circuit length
R_GALLERY = 0.004        # m (8mm effective diameter)
Q_OIL_BASE = 0.00025      # m^3/s, ASSUMED oil pump flow at rated RPM
P_PUMP_BACKPRESSURE = 150_000  # Pa, ASSUMED baseline backpressure (~1.5 bar)
# ASSUMED: mechanical pressure-relief valve setting. Real oil pumps include
# a spring-loaded relief valve that caps peak pressure (this is NOT in the
# source formula document -- the raw Hagen-Poiseuille equation has no upper
# bound, and produces unrealistic spikes during cold-oil/high-RPM transients
# like takeoff, e.g. >14 bar, without this cap).
OIL_PRESSURE_RELIEF_PA = 620_000  # Pa (~6.2 bar), just above the confirmed
                                    # normal max of 4.8 bar to allow realistic
                                    # cold-start peaks without runaway values

# Fuel density reference (ASTM D1250 Aviation Standard)
# Upgraded from linear model to ASTM D1250 exponential model:
# rho(T) = rho_15 * exp[ -alpha_15 * Delta_T * (1 + 0.8 * alpha_15 * Delta_T) ]
RHO_15 = 720.0             # kg/m^3 at 15 C (standard avgas/mogas density)
ALPHA_15 = 0.00115         # 1/K, ASTM D1250 thermal expansion coefficient for aviation fuels
RHO_FUEL_REF = RHO_15      # backward compatibility alias
FUEL_THERMAL_EXPANSION = ALPHA_15

# Dynamic charge temperature mapping constant (Section 1.2 upgrade)
# Accounts for turbocharger and cylinder head manifold heating
CHARGE_TEMP_ALPHA = 0.15

# Gearbox teeth (Rotax reduction gearbox), for vibration fault mapping (Section 4.2)
Z_TEETH = 43   # ASSUMED typical reduction gear tooth count (order-of-magnitude, not a confirmed spec)


# ============================================================
# SECTION 1: Combustion Thermodynamics & AFR (doc sections 1.1-1.3)
# ============================================================
def compute_map_pa(altitude_ft, ambient_pressure_hpa, power_fraction):
    """
    Manifold Absolute Pressure driven by turbo behavior:
    below critical altitude the turbo compensates to hold a target MAP;
    above critical altitude, boost saturates and MAP falls with ambient
    pressure. This determines air mass ingested (feeds section 1.2).
    """
    target_map_hpa = SEA_LEVEL_PRESSURE_HPA * (0.35 + 0.65 * power_fraction)  # full power ~ sea-level MAP
    if altitude_ft <= CRITICAL_ALT_FT:
        map_hpa = target_map_hpa  # turbo fully compensates
    else:
        # Above critical altitude: boost ratio maxed out, MAP decays with ambient pressure
        alt_excess_ratio = altitude_ft / CRITICAL_ALT_FT
        decay = 1 - 0.35 * min((alt_excess_ratio - 1), 1.0)
        map_hpa = target_map_hpa * decay * (ambient_pressure_hpa / SEA_LEVEL_PRESSURE_HPA) ** 0.3
    return map_hpa * 100.0  # Pa


def compute_air_mass_flow(map_pa, rpm, t_airbox_k, cht_k=None):
    """
    Upgraded Section 1.2: Dynamic Charge Temperature Mapping
    T_charge = T_airbox + alpha * (CHT - T_airbox)
    m_dot_a = (MAP * V_disp * RPM * eta_v) / (120 * R_spec * T_charge)
    """
    if cht_k is not None:
        t_charge_k = t_airbox_k + CHARGE_TEMP_ALPHA * (cht_k - t_airbox_k)
    else:
        t_charge_k = t_airbox_k
    m_dot_a = (map_pa * V_DISP_M3 * rpm * ETA_V) / (120.0 * R_SPEC_AIR * t_charge_k)
    return m_dot_a  # kg/s


def compute_fuel_density(t_fuel_c):
    """
    Upgraded Section 1.1: ASTM D1250 exponential aviation standard form:
    rho(T) = rho_15 * exp[ -alpha_15 * Delta_T * (1 + 0.8 * alpha_15 * Delta_T) ]
    """
    delta_t = t_fuel_c - 15.0
    exponent = -ALPHA_15 * delta_t * (1.0 + 0.8 * ALPHA_15 * delta_t)
    return RHO_15 * np.exp(exponent)


def compute_afr_phi(m_dot_a, m_dot_f):
    """Section 1.3: AFR_actual and equivalence ratio phi."""
    afr_actual = m_dot_a / m_dot_f if m_dot_f > 0 else np.nan
    phi = AFR_STOICH / afr_actual if afr_actual > 0 else np.nan
    return afr_actual, phi


def compute_egt(phi, power_fraction):
    """
    EGT driven by equivalence ratio deviation from stoichiometric, per doc
    section 1.3 thresholds (phi<0.90 lean -> EGT>850C, phi>1.15 rich -> EGT drops).
    ASSUMED functional form (linear ramps) calibrated to hit those two
    documented threshold points plus a realistic ~780C baseline near phi=1
    at cruise power (matches confirmed pilot EGT logs of 750-840C).
    """
    egt_base = 700 + 150 * power_fraction  # more power -> hotter baseline
    if phi < 1.0:
        # leaning out raises EGT; doc says phi=0.90 -> "spikes above 850"
        egt = egt_base + (1.0 - phi) * 900
    else:
        # richening cools EGT; doc says phi=1.15 -> EGT drops
        egt = egt_base - (phi - 1.0) * 500
    return egt


# ============================================================
# SECTION 2: Thermal Dynamics -- CHT (doc section 2.1-2.2)
# ============================================================
def step_cht(cht_prev_c, t_ambient_c, m_dot_f, dt_s, wind_kt, air_density):
    """
    Section 2.1, discretized (explicit Euler):
    C_cyl * d(CHT)/dt = Q_combustion - h_eff * A_eff * (CHT - T_ambient)

    Q_combustion approximated from fuel energy release scaled by the
    fraction rejected through the cylinder-head cooling path.
    h_eff scaled by relative cooling airflow (wind speed + air density,
    since thinner air carries less heat per unit airflow -- this is the
    climate-dependency link).
    """
    q_combustion = m_dot_f * FUEL_LHV * COMBUSTION_TO_HEAD_FRACTION  # Watts

    # Cooling airflow scaling: baseline at sea-level density, ~15kt airspeed component
    density_ratio = air_density / 1.225  # relative to sea-level density
    airflow_factor = density_ratio * (0.6 + 0.4 * np.clip(wind_kt / 25.0, 0, 2))
    h_eff = H_EFF_BASE * airflow_factor

    d_cht_dt = (q_combustion - h_eff * A_EFF * (cht_prev_c - t_ambient_c)) / C_CYL
    cht_new = cht_prev_c + d_cht_dt * dt_s
    return np.clip(cht_new, t_ambient_c, 135.0)  # clamp to confirmed max CHT spec


# ============================================================
# Oil temperature (gap-filled first-order lag toward CHT-linked target)
# ============================================================
def step_oil_temp(oil_temp_prev_c, cht_c, t_ambient_c, dt_s):
    """
    Not given explicitly in the source document (which assumes T_oil as a
    known input to section 3). Modeled as a first-order lag toward a
    steady-state blend of CHT and ambient, since oil thermal mass responds
    slower than the cylinder head. Clamped to confirmed operating range.
    """
    target = OIL_TEMP_TARGET_GAIN_CHT * cht_c + (1 - OIL_TEMP_TARGET_GAIN_CHT) * (t_ambient_c + 70)
    target = max(target, OIL_TEMP_FLOOR_C)
    oil_new = oil_temp_prev_c + (target - oil_temp_prev_c) * (dt_s / OIL_THERMAL_TAU_S)
    return np.clip(oil_new, OIL_TEMP_FLOOR_C, 130.0)  # clamp to confirmed max oil temp spec


# ============================================================
# SECTION 3: Lubrication (doc sections 3.1-3.2)
# ============================================================
def vft_viscosity(t_oil_c):
    """
    Upgraded Section 3.1: Vogel-Fulcher-Tammann (VFT) Viscosity
    mu(T_oil) = A * exp( B / (T_oil - C) )
    """
    return VFT_A * np.exp(VFT_B / (t_oil_c - VFT_C))


def vogel_viscosity(t_oil_c):
    """Alias to vft_viscosity for backward compatibility."""
    return vft_viscosity(t_oil_c)


def compute_lubrication_health_ratio(p_oil_pa, mu):
    """
    Upgraded Section 3.2: Lubrication Health Ratio
    H_lube = P_oil_sensor / mu(T_oil)
    """
    return p_oil_pa / mu if mu > 0 else np.nan


def hagen_poiseuille_oil_pressure(mu, rpm):
    """
    Section 3.2: P_oil = (8*mu*L*Q) / (pi*R^4) + P_backpressure
    Capped at the relief valve setting -- see OIL_PRESSURE_RELIEF_PA note,
    since the raw equation alone has no physical upper bound.
    """
    q_oil = Q_OIL_BASE * (rpm / RATED_RPM)  # oil pump flow scales with RPM
    p_oil = (8 * mu * L_GALLERY * q_oil) / (np.pi * R_GALLERY ** 4) + P_PUMP_BACKPRESSURE
    return min(p_oil, OIL_PRESSURE_RELIEF_PA)


# ============================================================
# SECTION 4: Vibration FFT & Order Tracking (doc section 4.1-4.2 upgrade)
# ============================================================
def vibration_frequencies(rpm):
    """Calculates rotational order frequencies (Hz)."""
    f0 = rpm / 60.0
    f_cam = f0 / 2.0
    f_fire = 2.0 * f0
    f_gear = Z_TEETH * f0
    return f0, f_cam, f_fire, f_gear


def compute_vibration_orders(rpm, power_fraction=0.65, fault_type=None, rng=None):
    """
    Upgraded Section 4: Fast Fourier Transform (FFT) & Order Tracking
    Isolates rotational orders and synthesizes physical acceleration amplitudes (in g RMS):
    - f_base (1x): Unbalance / main shaft order
    - f_cam (0.5x): Camshaft / valvetrain order
    - f_fire (2x): 4-cylinder firing harmonic
    - f_gear (43x): Reduction gearbox meshing order
    - g_total: Combined RMS triaxial vibration
    """
    if rng is None:
        rng = np.random.default_rng()

    f0, f_cam, f_fire, f_gear = vibration_frequencies(rpm)
    rpm_norm = np.clip(rpm / RATED_RPM, 0.3, 1.05)

    # Baseline nominal amplitudes scale with RPM and power delivery
    a_f0_base = 0.35 * rpm_norm + rng.normal(0, 0.02)
    a_fcam_base = 0.15 * rpm_norm + rng.normal(0, 0.01)
    a_ffire_base = (0.50 + 0.40 * power_fraction) * rpm_norm + rng.normal(0, 0.03)
    a_fgear_base = 0.25 * rpm_norm + rng.normal(0, 0.02)

    # Fault-induced harmonic surges
    if fault_type == "misfire":
        # Missing combustion pulse creates severe 0.5x cam torque dip & 1x unbalance
        a_fcam_base += rng.uniform(1.2, 1.8)
        a_f0_base += rng.uniform(0.5, 0.9)
    elif fault_type in ["abnormal_vibration", "bearing_fault"]:
        # Mechanical imbalance / bearing raceway spall spikes 1x shaft unbalance & broadband
        a_f0_base += rng.uniform(2.2, 3.8)
        a_fgear_base += rng.uniform(0.6, 1.2)
    elif fault_type == "combustion_instability":
        # Erratic flame front modulates firing order and introduces broadband noise
        a_ffire_base += rng.uniform(0.7, 1.4)
        a_f0_base += rng.uniform(0.3, 0.6)
    elif fault_type in ["lubrication_issues", "lubrication_degradation"]:
        # Late-stage bearing boundary friction / metal-on-metal wear
        a_f0_base += rng.uniform(0.6, 1.1)

    a_f0 = max(float(a_f0_base), 0.05)
    a_fcam = max(float(a_fcam_base), 0.02)
    a_ffire = max(float(a_ffire_base), 0.05)
    a_fgear = max(float(a_fgear_base), 0.05)

    # Total RMS G-force
    g_total = float(np.sqrt(a_f0**2 + a_fcam**2 + a_ffire**2 + a_fgear**2 + 0.04))

    return {
        "f0_Hz": round(f0, 2),
        "f_cam_Hz": round(f_cam, 2),
        "f_fire_Hz": round(f_fire, 2),
        "f_gear_Hz": round(f_gear, 2),
        "Vib_Amp_Total_g": round(g_total, 3),
        "Vib_Amp_f0_g": round(a_f0, 3),
        "Vib_Amp_fcam_g": round(a_fcam, 3),
        "Vib_Amp_ffire_g": round(a_ffire, 3),
    }


# ============================================================
# SECTION 5: ML diagnostic features (doc section 5.1, 5.3)
# ============================================================
def cylinder_egt_spread(egt_avg, rng, fault_mode=False):
    """
    Section 5.1: Delta_EGT_cross across 4 cylinders.
    Normal operation: small natural spread (~10-25C, matches confirmed
    pilot EGT log cylinder differentials). Fault mode injects a larger split.
    """
    if fault_mode:
        spread = rng.uniform(60, 120)
    else:
        spread = rng.uniform(8, 25)
    offsets = rng.normal(0, spread / 3, N_CYLINDERS)
    offsets -= offsets.mean()
    egts = egt_avg + offsets
    delta_egt_cross = egts.max() - egts.min()
    return egts, delta_egt_cross


def health_index_step(health_prev, p_oil_pa, p_oil_nominal_pa, t_oil_c, t_nom_c, dt_s, k_wear):
    """
    Section 5.3: Health_Index(t) = 1 - integral( k_wear * (P_nom - P_oil) * (T_oil/T_nom) ) dt
    Discretized as an incremental update per timestep.
    """
    p_deficit = max(p_oil_nominal_pa - p_oil_pa, 0)  # only degrade on pressure shortfall
    wear_increment = k_wear * p_deficit * (t_oil_c / t_nom_c) * dt_s
    health_new = health_prev - wear_increment
    return max(health_new, 0.0)
