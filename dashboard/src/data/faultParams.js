export const ALL_PARAM_KEYS = ['rpm', 'cht', 'egt', 'oilPressureBar', 'oilTempC', 'fuelFlowLh', 'vibrationRmsG'];

/** Engine parameters in which each diagnosed fault category shows its signature. */
export const FAULT_PARAM_MAP = {
  misfire: ['egt', 'rpm', 'vibrationRmsG'],
  injector_abnormalities: ['fuelFlowLh', 'egt'],
  cooling_degradation: ['cht', 'oilTempC'],
  lubrication_issues: ['oilPressureBar', 'oilTempC'],
  sensor_drift: ['cht', 'egt'],
  combustion_instability: ['rpm', 'vibrationRmsG'],
  overheating_trends: ['cht', 'oilTempC'],
  abnormal_vibration: ['vibrationRmsG'],
  regulator_failure: [],
  catastrophic_failure: ALL_PARAM_KEYS,
};

export function affectedParams(faultType) {
  return FAULT_PARAM_MAP[faultType] || ALL_PARAM_KEYS;
}
