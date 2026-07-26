import { estimateMarket } from './estimator.ts';
import { weightedQuantile } from './statistics.ts';
import type {
  BuildingType,
  EstimateConfidence,
  EstimateStatus,
  MarketSubject,
  MarketTransaction,
  SourceFreshness,
  TransactionIndex,
} from './types.ts';

export interface BacktestOptions {
  asOf: string;
}

export interface BacktestMetrics {
  caseCount: number;
  estimatedCount: number;
  estimateCoverage: number;
  medianApe: number | null;
  p75Ape: number | null;
  bias: number | null;
  intervalCoverage: number | null;
}

export interface BacktestCase {
  subjectDate: string;
  buildingType: BuildingType;
  confidence: EstimateConfidence;
  status: EstimateStatus;
  actualUnitPriceWan: number;
  estimatedUnitPriceWan: number | null;
  estimatedP25Wan: number | null;
  estimatedP75Wan: number | null;
  ape: number | null;
  bias: number | null;
  intervalHit: boolean | null;
  comparableDates: string[];
}

export interface BacktestReport {
  asOf: string;
  overall: BacktestMetrics;
  byBuildingType: Record<BuildingType, BacktestMetrics>;
  byConfidence: Record<EstimateConfidence, BacktestMetrics>;
  cases: BacktestCase[];
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
    ? date
    : null;
}

function completeMonthsBetween(start: Date, end: Date): number {
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return months;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function transactionDate(transaction: MarketTransaction): Date | null {
  return parseIsoDate(transaction.transactionDate);
}

function ageYearsAt(completionDate: string | null, asOf: Date): number | null {
  if (!completionDate) return null;
  const completion = parseIsoDate(completionDate);
  if (!completion || completion > asOf) return null;
  return completeMonthsBetween(completion, asOf) / 12;
}

function isEligibleSubject(transaction: MarketTransaction, asOf: Date): boolean {
  const date = transactionDate(transaction);
  const coordinate = transaction.location.coordinate;
  if (!date || date > asOf || !coordinate || !Number.isFinite(coordinate.lat) || !Number.isFinite(coordinate.lng)) return false;
  if (!transaction.district || transaction.ownership !== 'freehold') return false;
  if (!finitePositive(transaction.buildingAreaPing) || !finitePositive(transaction.buildingUnitPriceWan)) return false;
  if (!Number.isFinite(transaction.floor) || !Number.isFinite(transaction.totalFloors) || transaction.totalFloors <= 0) return false;
  return transaction.buildingType === 'apartment' || ageYearsAt(transaction.completionDate, date) !== null;
}

/** Builds an evaluation subject without exposing the held-out sale price to the estimator. */
export function backtestSubjectFromTransaction(transaction: MarketTransaction): MarketSubject {
  const subjectDate = transactionDate(transaction)!;
  return {
    listingId: null,
    coordinate: transaction.location.coordinate!,
    district: transaction.district,
    ownership: transaction.ownership,
    buildingType: transaction.buildingType,
    buildingAreaPing: transaction.buildingAreaPing,
    askingUnitPriceWan: null,
    floor: transaction.floor,
    totalFloors: transaction.totalFloors,
    floorGroup: transaction.floorGroup,
    ageYears: transaction.buildingType === 'apartment' ? null : ageYearsAt(transaction.completionDate, subjectDate),
    parkingSeparable: true,
  };
}

function allTransactions(index: TransactionIndex): MarketTransaction[] {
  const byId = new Map<string, MarketTransaction>();
  for (const transactions of Object.values(index.cells)) {
    for (const transaction of transactions) byId.set(transaction.id, transaction);
  }
  return [...byId.values()].sort((left, right) => left.transactionDate.localeCompare(right.transactionDate) || left.id.localeCompare(right.id));
}

function historicalIndex(index: TransactionIndex, subject: MarketTransaction): TransactionIndex {
  const subjectDate = subject.transactionDate;
  const cells = Object.fromEntries(Object.entries(index.cells).map(([key, transactions]) => [key,
    transactions.filter((candidate) => candidate.id !== subject.id && candidate.transactionDate < subjectDate),
  ]).filter(([, transactions]) => transactions.length > 0));
  return { ...index, cells };
}

const BACKTEST_FRESHNESS: SourceFreshness = {
  transactionCheckedAt: null,
  doorplateCheckedAt: null,
  transactionStale: false,
  doorplateStale: false,
};

function metrics(cases: readonly BacktestCase[]): BacktestMetrics {
  const estimated = cases.filter((backtestCase) => backtestCase.ape !== null && backtestCase.bias !== null && backtestCase.intervalHit !== null);
  const apes = estimated.map((backtestCase, index) => ({ id: String(index), value: backtestCase.ape!, weight: 1 }));
  return {
    caseCount: cases.length,
    estimatedCount: estimated.length,
    estimateCoverage: cases.length === 0 ? 0 : estimated.length / cases.length,
    medianApe: apes.length === 0 ? null : weightedQuantile(apes, 0.5),
    p75Ape: apes.length === 0 ? null : weightedQuantile(apes, 0.75),
    bias: estimated.length === 0 ? null : estimated.reduce((total, backtestCase) => total + backtestCase.bias!, 0) / estimated.length,
    intervalCoverage: estimated.length === 0 ? null : estimated.filter((backtestCase) => backtestCase.intervalHit).length / estimated.length,
  };
}

/**
 * Evaluates each historic sale as a held-out subject. Every input index is read
 * only; each estimate receives a fresh index containing strictly earlier sales.
 */
export function backtestTransactions(index: TransactionIndex, options: BacktestOptions): BacktestReport {
  const asOf = parseIsoDate(options.asOf);
  if (!asOf) throw new RangeError('Backtest requires a valid as-of date (YYYY-MM-DD)');

  const cases = allTransactions(index)
    .filter((transaction) => isEligibleSubject(transaction, asOf))
    .map((transaction): BacktestCase => {
      const estimate = estimateMarket(
        backtestSubjectFromTransaction(transaction),
        historicalIndex(index, transaction),
        BACKTEST_FRESHNESS,
        transaction.transactionDate,
        { allowMissingAskingUnitPrice: true },
      );
      const median = estimate.marketUnitPriceMedian;
      const p25 = estimate.marketUnitPriceP25;
      const p75 = estimate.marketUnitPriceP75;
      const actual = transaction.buildingUnitPriceWan;
      const canScore = median !== null && p25 !== null && p75 !== null;
      return {
        subjectDate: transaction.transactionDate,
        buildingType: transaction.buildingType,
        confidence: estimate.confidence,
        status: estimate.status,
        actualUnitPriceWan: actual,
        estimatedUnitPriceWan: median,
        estimatedP25Wan: p25,
        estimatedP75Wan: p75,
        ape: canScore ? Math.abs(median - actual) / actual : null,
        bias: canScore ? (median - actual) / actual : null,
        intervalHit: canScore ? actual >= p25 && actual <= p75 : null,
        comparableDates: estimate.comparables.map((candidate) => candidate.transaction.transactionDate).sort(),
      };
    });

  return {
    asOf: options.asOf,
    overall: metrics(cases),
    byBuildingType: {
      apartment: metrics(cases.filter((backtestCase) => backtestCase.buildingType === 'apartment')),
      midrise: metrics(cases.filter((backtestCase) => backtestCase.buildingType === 'midrise')),
      highrise: metrics(cases.filter((backtestCase) => backtestCase.buildingType === 'highrise')),
    },
    byConfidence: {
      high: metrics(cases.filter((backtestCase) => backtestCase.confidence === 'high')),
      medium: metrics(cases.filter((backtestCase) => backtestCase.confidence === 'medium')),
      low: metrics(cases.filter((backtestCase) => backtestCase.confidence === 'low')),
    },
    cases,
  };
}
