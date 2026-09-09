"""
Engine Failure Probability Model (Dynamic Hazard Layer)
-------------------------------------------------------
Implements the hybrid statistical reliability and AI-driven dynamic hazard model
for the Rotax 914F Digital Twin, per Engine_Failure_Probability_Model.pdf.

1. Statistical Baseline & Degradation (Cox Proportional Hazards + Weibull):
   h(t | X) = [ (beta / eta) * (t / eta)^(beta - 1) ] * exp( sum( w_j * HI_j(t) ) )
   P_survive_degradation = exp( - integral_t^(t + Delta_t) [ h(tau) ] d_tau )

2. Sudden Anomaly Fault Risk (AI Logit Output -> Sigmoid Calibration):
   P_sudden_i(t) = 1 / ( 1 + exp( - (W * F_t + b) ) )
   P_survive_sudden_faults = product_{i=1}^k [ 1 - P_sudden_i(t) ]

3. Master Hybrid Probability Formula:
   P_fail(t -> t + Delta_t) = 1 - [ P_survive_degradation * P_survive_sudden_faults ]
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple

# Default parameters per confirmed Weibull aging specifications
WEIBULL_BETA = 2.2                  # Shape parameter (wear-out aging regime)
WEIBULL_ETA_MIN = 2000.0 * 60.0     # Scale parameter: 2000 hours TBO = 120,000 minutes

# Target 8 fault taxonomy
TARGET_FAULTS = [
    "misfire",
    "injector_abnormalities",
    "cooling_degradation",
    "lubrication_issues",
    "sensor_drift",
    "combustion_instability",
    "overheating_trends",
    "abnormal_vibration",
]


class EngineFailureProbabilityModel:
    """
    Hybrid Failure Probability Model fusing Weibull mechanical degradation
    and real-time ML sudden anomaly probabilities.
    """

    def __init__(
        self,
        beta: float = WEIBULL_BETA,
        eta_minutes: float = WEIBULL_ETA_MIN,
        mission_window_delta_t_min: float = 60.0,
    ):
        self.beta = beta
        self.eta = eta_minutes
        self.delta_t = mission_window_delta_t_min

        # Weights for Cox Proportional Hazards covariates:
        # Penalizes wear deficit (1.0 - Health_Index), lubrication deficit, and thermal overload
        self.hazard_weights = {
            "health_deficit": 2.8,       # (1.0 - Health_Index)
            "lube_deficit": 2.2,         # max(0, 1.0 - P_oil_residual_ratio)
            "thermal_overload": 1.5,     # max(0, (CHT - 110) / 25)
        }

    def compute_degradation_hazard(
        self,
        cumulative_t_min: float,
        health_index: float = 1.0,
        oil_pressure_ratio: float = 1.0,
        cht_c: float = 85.0,
    ) -> float:
        """
        Calculates instantaneous Cox Proportional Hazard rate:
        h(t | X) = h_0(t) * exp( sum( w_j * covariate_j ) )
        """
        # Baseline Weibull hazard rate h_0(t)
        t = max(float(cumulative_t_min), 1.0)
        h0 = (self.beta / self.eta) * (t / self.eta) ** (self.beta - 1.0)

        # Covariates representing real-time physics degradation
        cov_health = max(1.0 - health_index, 0.0)
        cov_lube = max(1.0 - oil_pressure_ratio, 0.0)
        cov_thermal = max((cht_c - 110.0) / 25.0, 0.0)

        exponent = (
            self.hazard_weights["health_deficit"] * cov_health
            + self.hazard_weights["lube_deficit"] * cov_lube
            + self.hazard_weights["thermal_overload"] * cov_thermal
        )
        exponent = min(exponent, 20.0)  # numerical guard against overflow

        h_t = h0 * np.exp(exponent)
        return float(h_t)

    def compute_survival_degradation(
        self,
        cumulative_t_min: float,
        health_index: float = 1.0,
        oil_pressure_ratio: float = 1.0,
        cht_c: float = 85.0,
        delta_t_min: Optional[float] = None,
    ) -> float:
        """
        P_survive_degradation = exp( - Integral_t^(t+Delta_t) [ h(tau) ] d_tau )
        Approximated over the window Delta_t as exp( - h(t | X) * Delta_t ).
        """
        dt = delta_t_min if delta_t_min is not None else self.delta_t
        h_t = self.compute_degradation_hazard(
            cumulative_t_min, health_index, oil_pressure_ratio, cht_c
        )
        p_surv_deg = np.exp(-h_t * dt)
        return float(np.clip(p_surv_deg, 0.0, 1.0))

    def compute_sudden_fault_probabilities(
        self,
        fault_logits: Dict[str, float],
    ) -> Dict[str, float]:
        """
        Calculates sudden anomaly risk per fault via sigmoid activation:
        P_sudden_i = 1 / (1 + exp(-logit_i))
        """
        p_sudden = {}
        for fault in TARGET_FAULTS:
            logit = fault_logits.get(fault, -10.0)  # default low probability if unmentioned
            logit = np.clip(logit, -15.0, 15.0)
            p_i = 1.0 / (1.0 + np.exp(-logit))
            p_sudden[fault] = float(np.clip(p_i, 1e-6, 0.9999))
        return p_sudden

    def compute_survival_sudden(
        self,
        p_sudden_dict: Dict[str, float],
    ) -> float:
        """
        P_survive_sudden_faults = Product_{i=1}^k [ 1 - P_sudden_i(t) ]
        """
        p_survive = 1.0
        for fault, p_i in p_sudden_dict.items():
            p_survive *= (1.0 - p_i)
        return float(np.clip(p_survive, 0.0, 1.0))

    def compute_master_failure_probability(
        self,
        cumulative_t_min: float,
        health_index: float,
        oil_pressure_ratio: float,
        cht_c: float,
        fault_logits: Dict[str, float],
        delta_t_min: Optional[float] = None,
    ) -> Dict[str, any]:
        """
        Master Hybrid Probability Formula:
        P_fail(t -> t + Delta_t) = 1 - [ P_survive_degradation * P_survive_sudden_faults ]
        """
        p_surv_deg = self.compute_survival_degradation(
            cumulative_t_min, health_index, oil_pressure_ratio, cht_c, delta_t_min
        )
        p_sudden_dict = self.compute_sudden_fault_probabilities(fault_logits)
        p_surv_sudden = self.compute_survival_sudden(p_sudden_dict)

        p_fail = 1.0 - (p_surv_deg * p_surv_sudden)
        p_fail = float(np.clip(p_fail, 0.0, 1.0))

        return {
            "P_fail": round(p_fail, 5),
            "P_survive_degradation": round(p_surv_deg, 5),
            "P_survive_sudden_faults": round(p_surv_sudden, 5),
            "P_sudden_by_fault": {k: round(v, 5) for k, v in p_sudden_dict.items()},
        }
