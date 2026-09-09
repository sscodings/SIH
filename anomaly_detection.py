"""
Rotax 914F Engine Telemetry ML 8-Fault Anomaly Detection Module
--------------------------------------------------------------
Implements an upgraded hybrid health-monitoring and anomaly-detection architecture
for the Rotax 914F aero engine supporting 8 discrete fault modes:

1. Misfire (EGT cylinder split + cam order vibration + RPM jitter)
2. Injector/Metering Abnormalities (Bank 1 vs Bank 2 fuel flow mismatch + bank EGT split)
3. Cooling Degradation (Cooling heat rejection loss, Delta_CHT_ambient > 115C)
4. Lubrication Issues (Hagen-Poiseuille residual ratio < 0.75 + late vibration)
5. Sensor Drift / Failure (Cross-sensor inconsistency: CHT drift with nominal oil/ambient)
6. Combustion Instability (Cyclic RPM oscillation std > 35 RPM + firing harmonic jitter)
7. Overheating Trends (High absolute CHT/Oil Temp driven by extreme ambient, Delta_CHT_ambient <= 100C)
8. Abnormal Vibration Patterns (Bearing wear / shaft unbalance 1x order spike > 2.0g)

Plus Failure Probability Layer (Engine_Failure_Probability_Model.pdf):
- Cox Proportional Hazards degradation with Weibull baseline aging
- Sudden fault risk from AI classifier logits via Sigmoid calibration
- Master Dynamic Hazard: P_fail = 1 - [P_survive_degradation * P_survive_sudden_faults]
"""

import os
import sys
import numpy as np
import pandas as pd
from typing import Dict, List, Tuple, Optional
from sklearn.preprocessing import StandardScaler
from sklearn.neural_network import MLPRegressor, MLPClassifier
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import classification_report, confusion_matrix, roc_auc_score, f1_score

from engine_physics import hagen_poiseuille_oil_pressure, vft_viscosity
from failure_probability import EngineFailureProbabilityModel, TARGET_FAULTS


# =====================================================================
# 1. PHYSICS-INFORMED DIAGNOSTIC ENGINE (8-Fault Deterministic Rules)
# =====================================================================

class PhysicsRuleEngine:
    """
    Deterministic physics-grounded diagnostic rules differentiating all 8 faults.
    """

    def __init__(
        self,
        delta_egt_threshold_c: float = 32.0,
        oil_pressure_ratio_threshold: float = 0.75,
        cht_cruise_threshold_c: float = 120.0,
        delta_cht_ambient_threshold_c: float = 115.0,
        vib_1x_threshold_g: float = 2.0,
        rpm_instability_threshold: float = 35.0,
    ):
        self.delta_egt_threshold = delta_egt_threshold_c
        self.oil_pressure_ratio_threshold = oil_pressure_ratio_threshold
        self.cht_cruise_threshold = cht_cruise_threshold_c
        self.delta_cht_ambient_threshold = delta_cht_ambient_threshold_c
        self.vib_1x_threshold_g = vib_1x_threshold_g
        self.rpm_instability_threshold = rpm_instability_threshold

    def evaluate_misfire(self, row: pd.Series) -> Tuple[bool, Optional[str]]:
        """Fault 1: Misfire on one cylinder + cam order vibration / RPM flutter."""
        delta_egt = row.get("Delta_EGT_cross_roll3", row.get("Delta_EGT_cross_C", 0.0))
        vib_cam = row.get("Vib_Amp_fcam_g", 0.0)

        if delta_egt >= self.delta_egt_threshold and vib_cam > 0.45:
            cyl_egts = [
                row.get("EGT_cyl1_C", np.nan),
                row.get("EGT_cyl2_C", np.nan),
                row.get("EGT_cyl3_C", np.nan),
                row.get("EGT_cyl4_C", np.nan),
            ]
            valid_cyls = [c for c in cyl_egts if not np.isnan(c)]
            if len(valid_cyls) == 4:
                median_egt = np.median(valid_cyls)
                deviations = [abs(c - median_egt) for c in valid_cyls]
                worst_cyl = np.argmax(deviations) + 1
                return True, f"Misfire on Cylinder {worst_cyl} (Delta_EGT={delta_egt:.1f}°C, Vib_fcam={vib_cam:.2f}g)"
            return True, f"Misfire detected (Delta_EGT={delta_egt:.1f}°C, Vib_fcam={vib_cam:.2f}g)"
        return False, None

    def evaluate_injector_abnormalities(self, row: pd.Series) -> Tuple[bool, Optional[str]]:
        """Fault 2: Dual carburetor / bank fuel delivery mismatch & bank EGT divergence."""
        m_b1 = row.get("m_dot_f_bank1_kg_s", 0.0)
        m_b2 = row.get("m_dot_f_bank2_kg_s", 0.0)
        total_f = m_b1 + m_b2
        mismatch = abs(m_b1 - m_b2) / (total_f + 1e-7) if total_f > 0 else 0.0

        if mismatch > 0.15:
            lean_bank = "Bank 1 (Cyl 1&3)" if m_b1 < m_b2 else "Bank 2 (Cyl 2&4)"
            return True, f"Fuel metering mismatch: {lean_bank} starved (mismatch={mismatch*100:.1f}%)"
        return False, None

    def evaluate_sensor_drift(self, row: pd.Series) -> Tuple[bool, Optional[str]]:
        """Fault 5: Sensor drift on CHT channel (CHT > 114C while Oil Temp < 80C and all other channels normal)."""
        cht = row.get("CHT_C", 85.0)
        oil_temp = row.get("Oil_Temp_C", 75.0)
        p_ratio = row.get("P_oil_residual_ratio", 1.0)
        delta_egt = row.get("Delta_EGT_cross_roll3", 10.0)
        vib_total = row.get("Vib_Amp_Total_g", 0.8)
        phase = row.get("mission_phase", "")

        # Sensor drift signature: CHT reads very high (>114C), but oil temp is completely cool (<80C),
        # oil pressure ratio is healthy (>=0.85), vibration is low (<1.2g), and EGT spread is normal (<25C).
        if phase in ["Cruise_Loiter", "Descent"]:
            if cht >= 114.0 and oil_temp < 80.0 and p_ratio >= 0.85 and delta_egt < 25.0 and vib_total < 1.2:
                return True, f"Sensor drift on CHT channel (measured CHT={cht:.1f}°C while Oil_Temp={oil_temp:.1f}°C, lube & vibration are nominal)"
        return False, None

    def evaluate_cooling_degradation(self, row: pd.Series) -> Tuple[bool, Optional[str]]:
        """Fault 3: Cooling degradation (heat exchanger failure -> Delta_CHT_ambient >= 115C AND hot oil >= 90C)."""
        cht = row.get("CHT_C", 85.0)
        oil_temp = row.get("Oil_Temp_C", 75.0)
        delta_cht = row.get("Delta_CHT_ambient_C", 70.0)
        phase = row.get("mission_phase", "")

        # Key physical discriminator: In true cooling failure, CHT AND Oil_Temp rise together (Oil_Temp >= 90C)
        if phase in ["Cruise_Loiter", "Descent", "Climb"]:
            if delta_cht >= self.delta_cht_ambient_threshold and oil_temp >= 90.0:
                return True, f"Cooling system failure (Delta_CHT_ambient={delta_cht:.1f}°C >= {self.delta_cht_ambient_threshold}°C, Oil_Temp={oil_temp:.1f}°C)"
        return False, None

    def evaluate_lubrication_issues(self, row: pd.Series) -> Tuple[bool, Optional[str]]:
        """Fault 4: Lubrication gallery pressure deficit (Hagen-Poiseuille ratio < 0.75)."""
        rpm = row.get("RPM", 5000.0)
        p_oil_bar = row.get("Oil_Pressure_bar", 4.0)
        p_oil_ratio = row.get("P_oil_residual_ratio", 1.0)
        health_idx = row.get("Health_Index", 1.0)

        if rpm > 2500.0 and p_oil_ratio < self.oil_pressure_ratio_threshold:
            return True, f"Lubrication pressure deficit (P_actual={p_oil_bar:.2f} bar, ratio={p_oil_ratio:.2f}, HI={health_idx:.3f})"
        return False, None

    def evaluate_combustion_instability(self, row: pd.Series) -> Tuple[bool, Optional[str]]:
        """Fault 6: Combustion instability (cyclic RPM oscillation + firing order vibration jitter)."""
        rpm_std = row.get("RPM_instability_std", 15.0)
        vib_fire = row.get("Vib_Amp_ffire_g", 0.7)

        if rpm_std >= self.rpm_instability_threshold and vib_fire > 1.35:
            return True, f"Combustion instability (RPM oscillation std={rpm_std:.1f} RPM, Vib_ffire={vib_fire:.2f}g)"
        return False, None

    def evaluate_overheating_trends(self, row: pd.Series) -> Tuple[bool, Optional[str]]:
        """Fault 7: Overheating trends (high absolute CHT/Oil driven by high ambient OAT, Delta_CHT normal)."""
        cht = row.get("CHT_C", 85.0)
        oil_temp = row.get("Oil_Temp_C", 75.0)
        delta_cht = row.get("Delta_CHT_ambient_C", 70.0)

        # Key discriminator: Absolute CHT & Oil temp are elevated, but Delta_CHT_ambient is <= 100C (normal heat rejection)
        if cht >= 115.0 and oil_temp >= 100.0 and delta_cht <= 105.0:
            return True, f"Overheating trend due to extreme climate (CHT={cht:.1f}°C, Oil_Temp={oil_temp:.1f}°C, Delta_CHT={delta_cht:.1f}°C normal)"
        return False, None

    def evaluate_abnormal_vibration(self, row: pd.Series) -> Tuple[bool, Optional[str]]:
        """Fault 8: Mechanical vibration patterns (1x unbalance / bearing wear spike > 2.0g)."""
        vib_f0 = row.get("Vib_Amp_f0_g", 0.35)
        vib_total = row.get("Vib_Amp_Total_g", 0.8)

        if vib_f0 >= self.vib_1x_threshold_g or vib_total >= 2.6:
            return True, f"Abnormal mechanical vibration (Vib_1x={vib_f0:.2f}g >= {self.vib_1x_threshold_g}g, Total={vib_total:.2f}g)"
        return False, None

    def diagnose_row(self, row: pd.Series) -> Dict[str, any]:
        rules = [
            ("misfire", self.evaluate_misfire),
            ("injector_abnormalities", self.evaluate_injector_abnormalities),
            ("sensor_drift", self.evaluate_sensor_drift),
            ("cooling_degradation", self.evaluate_cooling_degradation),
            ("lubrication_issues", self.evaluate_lubrication_issues),
            ("combustion_instability", self.evaluate_combustion_instability),
            ("overheating_trends", self.evaluate_overheating_trends),
            ("abnormal_vibration", self.evaluate_abnormal_vibration),
        ]

        active_faults = []
        messages = []
        for fault_name, eval_fn in rules:
            is_active, msg = eval_fn(row)
            if is_active:
                active_faults.append(fault_name)
                messages.append(msg)

        if active_faults:
            return {
                "physics_rule_active": True,
                "physics_fault_type": active_faults[0],
                "physics_rule_message": "; ".join(messages),
            }
        return {
            "physics_rule_active": False,
            "physics_fault_type": "none",
            "physics_rule_message": None,
        }


# =====================================================================
# 2. FEATURE ENGINEERING & RESIDUAL PREPROCESSING
# =====================================================================

def prepare_telemetry_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Computes rolling features, physics residuals, order tracking ratios,
    and normalizes telemetry across all 8 fault dimensions.
    """
    df_feat = df.copy()

    # 1. 3-point rolling average of Delta_EGT_cross per mission
    if "Delta_EGT_cross_roll3" not in df_feat.columns:
        df_feat["Delta_EGT_cross_roll3"] = (
            df_feat.groupby("mission_id")["Delta_EGT_cross_C"]
            .rolling(3, min_periods=1)
            .mean()
            .reset_index(0, drop=True)
            .round(2)
        )

    # 2. Rolling 5-point RPM instability standard deviation
    if "RPM_instability_std" not in df_feat.columns:
        df_feat["RPM_instability_std"] = (
            df_feat.groupby("mission_id")["RPM"]
            .rolling(5, min_periods=1)
            .std()
            .fillna(15.0)
            .reset_index(0, drop=True)
            .round(2)
        )

    # 3. Hagen-Poiseuille expected oil pressure and ratio residual
    if "P_oil_expected_bar" not in df_feat.columns:
        p_exp = [
            hagen_poiseuille_oil_pressure(row["Oil_Viscosity_Pa_s"], row["RPM"]) / 1e5
            for _, row in df_feat.iterrows()
        ]
        df_feat["P_oil_expected_bar"] = np.round(p_exp, 3)
        df_feat["P_oil_residual_ratio"] = np.round(
            df_feat["Oil_Pressure_bar"] / np.clip(df_feat["P_oil_expected_bar"], 0.1, 10.0), 4
        )

    # 4. Bank fuel flow mismatch ratio (dual carburetor check)
    if "Bank_Fuel_Mismatch_ratio" not in df_feat.columns:
        if "m_dot_f_bank1_kg_s" in df_feat.columns and "m_dot_f_bank2_kg_s" in df_feat.columns:
            tot = df_feat["m_dot_f_bank1_kg_s"] + df_feat["m_dot_f_bank2_kg_s"]
            df_feat["Bank_Fuel_Mismatch_ratio"] = np.round(
                np.abs(df_feat["m_dot_f_bank1_kg_s"] - df_feat["m_dot_f_bank2_kg_s"]) / np.clip(tot, 1e-6, 1.0), 4
            )
        else:
            df_feat["Bank_Fuel_Mismatch_ratio"] = 0.0

    # 5. Order tracking harmonic ratios
    if "Vib_Ratio_cam_f0" not in df_feat.columns:
        f0_clip = np.clip(df_feat.get("Vib_Amp_f0_g", 0.35), 0.05, 10.0)
        df_feat["Vib_Ratio_cam_f0"] = np.round(df_feat.get("Vib_Amp_fcam_g", 0.15) / f0_clip, 3)
        df_feat["Vib_Ratio_fire_f0"] = np.round(df_feat.get("Vib_Amp_ffire_g", 0.70) / f0_clip, 3)

    # 6. Lubrication health ratio
    if "H_lube" not in df_feat.columns:
        df_feat["H_lube"] = np.round(df_feat["Ratio_Lube"], 2)

    # 7. Health index deficit
    df_feat["Health_Index_deficit"] = (1.0 - df_feat["Health_Index"]).round(5)

    return df_feat


# =====================================================================
# 3. DATA-DRIVEN ML CLASSIFIER & AUTOENCODER
# =====================================================================

ML_FEATURE_COLS = [
    "RPM", "MAP_hPa", "m_dot_a_kg_s", "m_dot_f_kg_s", "Q_fuel_L_s",
    "AFR_actual", "phi_equivalence_ratio", "EGT_avg_C", "Delta_EGT_cross_roll3",
    "CHT_C", "Delta_CHT_ambient_C", "Oil_Temp_C", "Oil_Pressure_bar",
    "Oil_Viscosity_Pa_s", "Ratio_Lube", "P_oil_residual_ratio", "Health_Index_deficit",
    "Bank_Fuel_Mismatch_ratio", "RPM_instability_std",
    "Vib_Amp_Total_g", "Vib_Amp_f0_g", "Vib_Amp_fcam_g", "Vib_Amp_ffire_g",
    "Vib_Ratio_cam_f0", "Vib_Ratio_fire_f0", "Rate_of_Rise_CHT_C_per_min"
]


class MultiClassFaultClassifier:
    """
    Supervised Multi-Class Classifier outputting class probabilities and logit scores
    for all 8 target fault categories.
    """

    def __init__(self, feature_cols: Optional[List[str]] = None, random_state: int = 42):
        self.feature_cols = feature_cols or ML_FEATURE_COLS
        self.random_state = random_state
        self.classes_ = ["none"] + TARGET_FAULTS
        self.scaler = StandardScaler()
        self.model = HistGradientBoostingClassifier(
            max_iter=150,
            learning_rate=0.08,
            random_state=self.random_state,
        )
        self.is_fitted = False

    def fit(self, df_train: pd.DataFrame):
        X = df_train[self.feature_cols].copy().fillna(0).values
        y = df_train["injected_fault_type"].values
        X_scaled = self.scaler.fit_transform(X)
        self.model.fit(X_scaled, y)
        self.is_fitted = True
        return self

    def predict_with_logits(self, df: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray, List[Dict[str, float]]]:
        if not self.is_fitted:
            raise RuntimeError("Classifier is not fitted.")
        X = df[self.feature_cols].copy().fillna(0).values
        X_scaled = self.scaler.transform(X)

        preds = self.model.predict(X_scaled)
        probs = self.model.predict_proba(X_scaled)
        model_classes = list(self.model.classes_)

        # Map probabilities into logit scores: logit = ln(p / (1 - p))
        all_logits = []
        for row_prob in probs:
            row_dict = {}
            for fault in TARGET_FAULTS:
                if fault in model_classes:
                    idx = model_classes.index(fault)
                    p = np.clip(row_prob[idx], 1e-5, 1.0 - 1e-5)
                    row_dict[fault] = float(np.log(p / (1.0 - p)))
                else:
                    row_dict[fault] = -12.0
            all_logits.append(row_dict)

        return preds, probs, all_logits


class AutoencoderAnomalyDetector:
    """
    Multivariate Autoencoder trained exclusively on healthy baseline telemetry.
    """

    def __init__(
        self,
        feature_cols: Optional[List[str]] = None,
        hidden_layer_sizes: Tuple[int, ...] = (64, 32, 16, 32, 64),
        threshold_multiplier: float = 3.5,
        random_state: int = 42,
    ):
        self.feature_cols = feature_cols or ML_FEATURE_COLS
        self.hidden_layer_sizes = hidden_layer_sizes
        self.threshold_multiplier = threshold_multiplier
        self.random_state = random_state

        self.scaler = StandardScaler()
        self.model = MLPRegressor(
            hidden_layer_sizes=self.hidden_layer_sizes,
            activation="relu",
            solver="adam",
            max_iter=300,
            batch_size=64,
            learning_rate_init=0.001,
            early_stopping=True,
            n_iter_no_change=15,
            random_state=self.random_state,
        )
        self.threshold_: float = 0.0
        self.train_mean_error_: float = 0.0
        self.train_std_error_: float = 0.0
        self.is_fitted: bool = False

    def fit(self, df_normal: pd.DataFrame):
        X = df_normal[self.feature_cols].copy().fillna(0).values
        X_scaled = self.scaler.fit_transform(X)
        self.model.fit(X_scaled, X_scaled)

        X_pred = self.model.predict(X_scaled)
        sample_errors = np.mean((X_scaled - X_pred) ** 2, axis=1)

        self.train_mean_error_ = float(np.mean(sample_errors))
        self.train_std_error_ = float(np.std(sample_errors))
        p99_8 = np.percentile(sample_errors, 99.8)
        k_sigma = self.train_mean_error_ + self.threshold_multiplier * self.train_std_error_
        self.threshold_ = float(max(p99_8, k_sigma))
        self.is_fitted = True
        return self

    def predict_anomalies(self, df: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray]:
        if not self.is_fitted:
            raise RuntimeError("Autoencoder is not fitted yet.")
        X = df[self.feature_cols].copy().fillna(0).values
        X_scaled = self.scaler.transform(X)
        X_pred = self.model.predict(X_scaled)
        sample_errors = np.mean((X_scaled - X_pred) ** 2, axis=1)
        anomalies = (sample_errors > self.threshold_)
        return anomalies, sample_errors


# =====================================================================
# 4. UNIFIED ENGINE HEALTH MONITOR (RotaxHealthMonitor)
# =====================================================================

class RotaxHealthMonitor:
    """
    Unified engine health monitoring and dynamic failure probability system
    fusing Physics-Informed Rules, ML Classifier, and Weibull reliability modeling.
    """

    def __init__(
        self,
        physics_engine: Optional[PhysicsRuleEngine] = None,
        classifier: Optional[MultiClassFaultClassifier] = None,
        autoencoder: Optional[AutoencoderAnomalyDetector] = None,
        hazard_model: Optional[EngineFailureProbabilityModel] = None,
    ):
        self.physics_engine = physics_engine or PhysicsRuleEngine()
        self.classifier = classifier or MultiClassFaultClassifier()
        self.autoencoder = autoencoder or AutoencoderAnomalyDetector()
        self.hazard_model = hazard_model or EngineFailureProbabilityModel()
        self.is_trained: bool = False

    def train(self, df_telemetry: pd.DataFrame, train_mission_ids: Optional[List[int]] = None):
        df_feat = prepare_telemetry_features(df_telemetry)

        if train_mission_ids is not None:
            df_train = df_feat[df_feat["mission_id"].isin(train_mission_ids)].copy()
        else:
            df_train = df_feat.copy()

        df_train_normal = df_train[df_train["injected_fault_type"] == "none"]
        print(f"[Training] Fitting ML Autoencoder on {len(df_train_normal)} healthy baseline samples...")
        self.autoencoder.fit(df_train_normal)

        print(f"[Training] Fitting Multi-Class 8-Fault Classifier on {len(df_train)} operational samples...")
        self.classifier.fit(df_train)

        self.is_trained = True
        print(f"[Training Complete] Autoencoder Baseline MSE = {self.autoencoder.train_mean_error_:.5f} (Threshold = {self.autoencoder.threshold_:.5f})")
        return self

    def diagnose_dataset(self, df_telemetry: pd.DataFrame) -> pd.DataFrame:
        if not self.is_trained:
            raise RuntimeError("RotaxHealthMonitor must be trained first.")

        df_result = prepare_telemetry_features(df_telemetry)

        # 1. Physics Rule Engine evaluation
        physics_diag = [self.physics_engine.diagnose_row(row) for _, row in df_result.iterrows()]
        df_physics = pd.DataFrame(physics_diag, index=df_result.index)

        # 2. ML Classifier predictions and logit outputs
        preds, probs, logits_list = self.classifier.predict_with_logits(df_result)

        # 3. Autoencoder novelty check
        ae_anom, ae_errors = self.autoencoder.predict_anomalies(df_result)

        df_result["Physics_Rule_Active"] = df_physics["physics_rule_active"]
        df_result["Physics_Fault_Type"] = df_physics["physics_fault_type"]
        df_result["Physics_Diagnostic_Msg"] = df_physics["physics_rule_message"]

        df_result["AE_Recon_Error"] = ae_errors.round(5)
        df_result["AE_Anomaly_Alert"] = ae_anom

        # Consensus master alarm
        df_result["Anomaly_Detected"] = (
            df_result["Physics_Rule_Active"] | (preds != "none") | df_result["AE_Anomaly_Alert"]
        )

        # Consensus classification: Prioritize deterministic physics rule, then ML classifier
        classified_type = []
        for i, row in df_result.iterrows():
            if row["Physics_Rule_Active"]:
                classified_type.append(row["Physics_Fault_Type"])
            elif preds[i] != "none":
                classified_type.append(preds[i])
            elif row["AE_Anomaly_Alert"]:
                classified_type.append("unclassified_anomaly")
            else:
                classified_type.append("none")
        df_result["Classified_Fault_Type"] = classified_type

        # 4. Master Dynamic Failure Probability Layer (Engine_Failure_Probability_Model.pdf)
        p_fails = []
        p_surv_degs = []
        p_surv_suddens = []

        for i, row in df_result.iterrows():
            cum_t = float(row["elapsed_min"]) + 100.0  # mission duration offset
            h_idx = float(row["Health_Index"])
            p_ratio = float(row["P_oil_residual_ratio"])
            cht = float(row["CHT_C"])
            logits = logits_list[i]

            prob_out = self.hazard_model.compute_master_failure_probability(
                cumulative_t_min=cum_t,
                health_index=h_idx,
                oil_pressure_ratio=p_ratio,
                cht_c=cht,
                fault_logits=logits,
                delta_t_min=60.0,
            )
            p_fails.append(prob_out["P_fail"])
            p_surv_degs.append(prob_out["P_survive_degradation"])
            p_surv_suddens.append(prob_out["P_survive_sudden_faults"])

        df_result["P_fail"] = p_fails
        df_result["P_survive_degradation"] = p_surv_degs
        df_result["P_survive_sudden_faults"] = p_surv_suddens

        return df_result


# =====================================================================
# 5. BENCHMARK & EVALUATION PIPELINE
# =====================================================================

def run_evaluation_pipeline(data_path: str) -> Tuple[RotaxHealthMonitor, pd.DataFrame, Dict[str, any]]:
    print("=" * 78)
    print("ROTAX 914F ENGINE TELEMETRY 8-FAULT HYBRID ML ANOMALY DETECTION EVALUATION")
    print("=" * 78)

    df_telemetry = pd.read_csv(data_path)
    print(f"Loaded telemetry dataset: {len(df_telemetry)} rows across {df_telemetry['mission_id'].nunique()} missions.")

    # Train on 12 missions (incorporates normal flights and represented fault signatures)
    # Validate on untouched validation missions (Mission 14: Cold Winter, Mission 15: Hot Desert)
    train_mission_ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    val_mission_ids = [14, 15]

    monitor = RotaxHealthMonitor()
    monitor.train(df_telemetry, train_mission_ids=train_mission_ids)

    df_diagnosed = monitor.diagnose_dataset(df_telemetry)

    # -------------------------------------------------------------
    # 1. Validation on Untouched Healthy Missions (14 & 15)
    # -------------------------------------------------------------
    df_val = df_diagnosed[df_diagnosed["mission_id"].isin(val_mission_ids)]
    val_false_alarms = (df_val["Anomaly_Detected"] == True).sum()
    total_val = len(df_val)
    far = (val_false_alarms / total_val) * 100.0

    print("\n" + "-" * 78)
    print("1. VALIDATION ON UNTOUCHED HEALTHY MISSIONS (Missions 14 & 15)")
    print("-" * 78)
    print(f"Total Normal Validation Samples: {total_val}")
    print(f"False Alarms Triggered: {val_false_alarms}")
    print(f"False Alarm Rate (FAR): {far:.2f}% (Target: < 1.5%)")

    # -------------------------------------------------------------
    # 2. Performance Breakdown across All 8 Fault Types
    # -------------------------------------------------------------
    print("\n" + "-" * 78)
    print("2. DETECTION PERFORMANCE ACROSS ALL 8 TARGET FAULTS")
    print("-" * 78)

    fault_summary = []
    for fault_name in TARGET_FAULTS:
        df_f = df_diagnosed[df_diagnosed["injected_fault_type"] == fault_name]
        if len(df_f) == 0:
            continue
        total_mins = len(df_f)
        detected = (df_f["Anomaly_Detected"] == True).sum()
        recall = (detected / total_mins) * 100.0

        classified_correct = (df_f["Classified_Fault_Type"] == fault_name).sum()
        isolation_acc = (classified_correct / total_mins) * 100.0

        avg_pfail = df_f["P_fail"].mean()

        fault_summary.append({
            "fault_type": fault_name,
            "total_minutes": total_mins,
            "detection_recall_pct": round(recall, 1),
            "isolation_acc_pct": round(isolation_acc, 1),
            "mean_P_fail": round(avg_pfail, 3),
        })

    df_summary = pd.DataFrame(fault_summary)
    print(df_summary.to_string(index=False))

    # -------------------------------------------------------------
    # 3. Overall Multi-Class Classification Report
    # -------------------------------------------------------------
    print("\n" + "-" * 78)
    print("3. DETAILED 8-CLASS CLASSIFICATION REPORT")
    print("-" * 78)
    print(classification_report(
        df_diagnosed["injected_fault_type"],
        df_diagnosed["Classified_Fault_Type"],
        digits=3,
        zero_division=0
    ))

    # -------------------------------------------------------------
    # 4. Failure Probability Calibration Check
    # -------------------------------------------------------------
    p_fail_norm = df_diagnosed[df_diagnosed["injected_fault_type"] == "none"]["P_fail"].mean()
    p_fail_fault = df_diagnosed[df_diagnosed["injected_fault_type"] != "none"]["P_fail"].mean()
    print("-" * 78)
    print(f"Mean P_fail during Healthy Flights: {p_fail_norm:.4f} (Nominal low hazard)")
    print(f"Mean P_fail during Active Faults:   {p_fail_fault:.4f} (High critical hazard)")

    # Save output
    out_diagnosed_path = os.path.join(os.path.dirname(data_path), "engine_telemetry_diagnosed.csv")
    df_diagnosed.to_csv(out_diagnosed_path, index=False)
    print(f"\nSaved full 8-fault diagnosed telemetry with P_fail to: {out_diagnosed_path}")
    print("=" * 78)

    metrics = {
        "val_far_pct": far,
        "fault_summary": fault_summary,
        "mean_pfail_healthy": p_fail_norm,
        "mean_pfail_fault": p_fail_fault,
    }
    return monitor, df_diagnosed, metrics


if __name__ == "__main__":
    current_dir = os.path.dirname(os.path.abspath(__file__))
    data_file = os.path.join(current_dir, "engine_telemetry.csv")
    if not os.path.exists(data_file):
        print(f"Error: Could not locate {data_file}")
        sys.exit(1)

    monitor, df_diagnosed, metrics = run_evaluation_pipeline(data_file)
