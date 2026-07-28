export const MARKET_SCHEMA_VERSION = 1;
/**
 * Intentional acceptance compatibility contract. Bump whenever selector,
 * weighting, outlier, confidence, status, or backtest semantics change.
 */
export const ESTIMATOR_POLICY_VERSION = 2;
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
  minimumConfidenceSliceCases: 20,
  minimumHighConfidenceImprovement: 0.01,
} as const;

export interface SearchStage {
  radiusM: number;
  months: number;
  areaTolerance: number;
  allowAdjacentFloor: boolean;
}

export interface EstimatorPolicy {
  id: 'baseline' | '48-month' | '1000-meter';
  stages: readonly SearchStage[];
}

export const BASELINE_ESTIMATOR_POLICY: EstimatorPolicy = {
  id: 'baseline',
  stages: [
    { radiusM: 300, months: 12, areaTolerance: 0.20, allowAdjacentFloor: false },
    { radiusM: 500, months: 12, areaTolerance: 0.20, allowAdjacentFloor: false },
    { radiusM: 500, months: 36, areaTolerance: 0.20, allowAdjacentFloor: false },
    { radiusM: 500, months: 36, areaTolerance: 0.30, allowAdjacentFloor: true },
    { radiusM: 800, months: 36, areaTolerance: 0.30, allowAdjacentFloor: true },
  ],
};

export const EXPERIMENTAL_48_MONTH_POLICY: EstimatorPolicy = {
  id: '48-month',
  stages: [
    ...BASELINE_ESTIMATOR_POLICY.stages,
    { radiusM: 800, months: 48, areaTolerance: 0.30, allowAdjacentFloor: true },
  ],
};

export const EXPERIMENTAL_1000_METER_POLICY: EstimatorPolicy = {
  id: '1000-meter',
  stages: [
    ...EXPERIMENTAL_48_MONTH_POLICY.stages,
    { radiusM: 1_000, months: 48, areaTolerance: 0.30, allowAdjacentFloor: true },
  ],
};

export const ACTIVE_ESTIMATOR_POLICY = BASELINE_ESTIMATOR_POLICY;

/** @deprecated Use ACTIVE_ESTIMATOR_POLICY.stages for new selection code. */
export const SEARCH_STAGES = ACTIVE_ESTIMATOR_POLICY.stages;

export const WEIGHTS = {
  distance: [1, 0.75, 0.5],
  time: [1, 0.7, 0.4],
  relaxedArea: 0.85,
  relaxedAge: 0.85,
  adjacentFloor: 0.7,
} as const;

export const TRANSACTION_STALE_DAYS = 30;
export const DOORPLATE_STALE_DAYS = 60;
