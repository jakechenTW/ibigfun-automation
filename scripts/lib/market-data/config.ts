export const MARKET_SCHEMA_VERSION = 2;
/**
 * Intentional acceptance compatibility contract. Bump whenever selector,
 * weighting, outlier, confidence, status, or backtest semantics change.
 */
export const ESTIMATOR_POLICY_VERSION = 4;
export const MARKET_DATA_ROOT = 'state/market-data/taipei';
export const MARKET_BACKTEST_DIAGNOSTIC_ROOT = 'state/market-data/backtests/taipei';
export const MIN_COMPARABLES = 3;
export const HIGH_CONFIDENCE_MIN_COMPARABLES = 5;
export const HIGH_IQR_RATIO = 0.15;
export const MEDIUM_IQR_RATIO = 0.25;
export const GRID_CELL_DEGREES = 0.005;
export const MIN_PRODUCTION_DOORPLATES = 100_000;
export const MIN_PRODUCTION_TRANSACTIONS = 1_000;
export const BACKTEST_ACCEPTANCE_THRESHOLDS = {
  medianApeMax: 0.12,
  p75ApeMax: 0.20,
  minimumEstimateCoverage: 0.70,
  minimumConfidenceSliceCases: 20,
  minimumHighConfidenceImprovement: 0.01,
} as const;

export interface SearchStage {
  radiusM: number;
  months: number;
  areaTolerance: number;
  allowAdjacentFloor: boolean;
  confidenceClass: 'standard' | 'fallback';
}

export interface DistanceWeightBand {
  maxDistanceM: number;
  weight: number;
}

export interface TimeWeightBand {
  maxAgeMonths: number;
  weight: number;
}

export interface EstimatorPolicy {
  id: 'baseline' | '48-month' | '1000-meter';
  stages: readonly SearchStage[];
  distanceWeightBands: readonly DistanceWeightBand[];
  timeWeightBands: readonly TimeWeightBand[];
}

export type PolicyId = EstimatorPolicy['id'];

export const WEIGHTS = {
  distance: [1, 0.75, 0.5],
  time: [1, 0.7, 0.4],
  relaxedArea: 0.85,
  relaxedAge: 0.85,
  adjacentFloor: 0.7,
} as const;

const BASELINE_DISTANCE_WEIGHT_BANDS: readonly DistanceWeightBand[] = [
  { maxDistanceM: 300, weight: WEIGHTS.distance[0] },
  { maxDistanceM: 500, weight: WEIGHTS.distance[1] },
  { maxDistanceM: 800, weight: WEIGHTS.distance[2] },
];

const BASELINE_TIME_WEIGHT_BANDS: readonly TimeWeightBand[] = [
  { maxAgeMonths: 12, weight: WEIGHTS.time[0] },
  { maxAgeMonths: 24, weight: WEIGHTS.time[1] },
  { maxAgeMonths: 36, weight: WEIGHTS.time[2] },
];

export const BASELINE_ESTIMATOR_POLICY: EstimatorPolicy = {
  id: 'baseline',
  stages: [
    { radiusM: 300, months: 12, areaTolerance: 0.20, allowAdjacentFloor: false, confidenceClass: 'standard' },
    { radiusM: 500, months: 12, areaTolerance: 0.20, allowAdjacentFloor: false, confidenceClass: 'standard' },
    { radiusM: 500, months: 36, areaTolerance: 0.20, allowAdjacentFloor: false, confidenceClass: 'standard' },
    { radiusM: 500, months: 36, areaTolerance: 0.30, allowAdjacentFloor: true, confidenceClass: 'standard' },
    { radiusM: 800, months: 36, areaTolerance: 0.30, allowAdjacentFloor: true, confidenceClass: 'fallback' },
  ],
  distanceWeightBands: BASELINE_DISTANCE_WEIGHT_BANDS,
  timeWeightBands: BASELINE_TIME_WEIGHT_BANDS,
};

export const EXPERIMENTAL_48_MONTH_POLICY: EstimatorPolicy = {
  id: '48-month',
  stages: [
    ...BASELINE_ESTIMATOR_POLICY.stages,
    { radiusM: 800, months: 48, areaTolerance: 0.30, allowAdjacentFloor: true, confidenceClass: 'fallback' },
  ],
  distanceWeightBands: BASELINE_DISTANCE_WEIGHT_BANDS,
  timeWeightBands: [
    ...BASELINE_TIME_WEIGHT_BANDS,
    { maxAgeMonths: 48, weight: WEIGHTS.time[2] },
  ],
};

export const EXPERIMENTAL_1000_METER_POLICY: EstimatorPolicy = {
  id: '1000-meter',
  stages: [
    ...EXPERIMENTAL_48_MONTH_POLICY.stages,
    { radiusM: 1_000, months: 48, areaTolerance: 0.30, allowAdjacentFloor: true, confidenceClass: 'fallback' },
  ],
  distanceWeightBands: [
    ...BASELINE_DISTANCE_WEIGHT_BANDS,
    { maxDistanceM: 1_000, weight: WEIGHTS.distance[2] },
  ],
  timeWeightBands: EXPERIMENTAL_48_MONTH_POLICY.timeWeightBands,
};

export const ACTIVE_ESTIMATOR_POLICY = BASELINE_ESTIMATOR_POLICY;

export function estimatorPolicyById(id: PolicyId): EstimatorPolicy {
  switch (id) {
    case 'baseline': return BASELINE_ESTIMATOR_POLICY;
    case '48-month': return EXPERIMENTAL_48_MONTH_POLICY;
    case '1000-meter': return EXPERIMENTAL_1000_METER_POLICY;
  }
}

/** @deprecated Use ACTIVE_ESTIMATOR_POLICY.stages for new selection code. */
export const SEARCH_STAGES = ACTIVE_ESTIMATOR_POLICY.stages;

export const TRANSACTION_STALE_DAYS = 30;
export const DOORPLATE_STALE_DAYS = 60;
