export const MARKET_SCHEMA_VERSION = 1;
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

export const SEARCH_STAGES = [
  { radiusM: 300, months: 12, areaTolerance: 0.20, allowAdjacentFloor: false },
  { radiusM: 500, months: 12, areaTolerance: 0.20, allowAdjacentFloor: false },
  { radiusM: 500, months: 36, areaTolerance: 0.20, allowAdjacentFloor: false },
  { radiusM: 500, months: 36, areaTolerance: 0.30, allowAdjacentFloor: true },
  { radiusM: 800, months: 36, areaTolerance: 0.30, allowAdjacentFloor: true },
] as const;

export const WEIGHTS = {
  distance: [1, 0.75, 0.5],
  time: [1, 0.7, 0.4],
  relaxedArea: 0.85,
  relaxedAge: 0.85,
  adjacentFloor: 0.7,
} as const;

export const TRANSACTION_STALE_DAYS = 30;
export const DOORPLATE_STALE_DAYS = 60;
