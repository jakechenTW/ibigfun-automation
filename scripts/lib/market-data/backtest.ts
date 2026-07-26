import { estimateMarket } from './estimator.ts';
import { BACKTEST_ACCEPTANCE_THRESHOLDS, ESTIMATOR_POLICY_VERSION } from './config.ts';
import { weightedQuantile } from './statistics.ts';
import type {
  BacktestAcceptance,
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
  /** Latest eligible sale in the complete active index, before as-of filtering. */
  latestEligibleTransactionDate: string | null;
  overall: BacktestMetrics;
  byBuildingType: Record<BuildingType, BacktestMetrics>;
  byConfidence: Record<EstimateConfidence, BacktestMetrics>;
  work: {
    historicalIndexBuilds: number;
    historicalInsertions: number;
  };
  cases: BacktestCase[];
}

export interface BacktestGateResult {
  passed: boolean;
  complete: boolean;
  reasons: string[];
}

export const BACKTEST_GATE = BACKTEST_ACCEPTANCE_THRESHOLDS;

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

interface IndexedTransaction {
  cellKey: string;
  transaction: MarketTransaction;
}

function allTransactions(index: TransactionIndex): IndexedTransaction[] {
  const byId = new Map<string, IndexedTransaction>();
  for (const [cellKey, transactions] of Object.entries(index.cells)) {
    for (const transaction of transactions) byId.set(transaction.id, { cellKey, transaction });
  }
  return [...byId.values()].sort((left, right) =>
    left.transaction.transactionDate.localeCompare(right.transaction.transactionDate)
      || left.transaction.id.localeCompare(right.transaction.id));
}

function latestEligibleDate(entries: readonly IndexedTransaction[]): string | null {
  let latest: string | null = null;
  for (const { transaction } of entries) {
    const date = transactionDate(transaction);
    if (date && isEligibleSubject(transaction, date)) latest = transaction.transactionDate;
  }
  return latest;
}

/** Latest held-out-eligible transaction represented by the complete deduplicated index. */
export function latestEligibleTransactionDate(index: TransactionIndex): string | null {
  return latestEligibleDate(allTransactions(index));
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

/** Deterministic acceptance policy shared by the CLI and persisted artifact. */
export function evaluateBacktestGate(report: BacktestReport): BacktestGateResult {
  const reasons: string[] = [];
  const overall = report.overall;
  const high = report.byConfidence.high;
  const medium = report.byConfidence.medium;
  if (overall.caseCount === 0 || overall.estimatedCount === 0 || overall.medianApe === null || overall.p75Ape === null) {
    reasons.push('incomplete-overall');
  }
  if (high.estimatedCount < BACKTEST_GATE.minimumConfidenceSliceCases || high.medianApe === null) {
    reasons.push('insufficient-high-confidence-cases');
  }
  if (medium.estimatedCount < BACKTEST_GATE.minimumConfidenceSliceCases || medium.medianApe === null) {
    reasons.push('insufficient-medium-confidence-cases');
  }
  if (report.latestEligibleTransactionDate === null || report.asOf < report.latestEligibleTransactionDate) {
    reasons.push('incomplete-active-transaction-coverage');
  }
  if (overall.medianApe !== null && overall.medianApe > BACKTEST_GATE.medianApeMax) {
    reasons.push('median-ape-target-missed');
  }
  if (overall.p75Ape !== null && overall.p75Ape > BACKTEST_GATE.p75ApeMax) {
    reasons.push('p75-ape-target-missed');
  }
  if (high.medianApe !== null && medium.medianApe !== null
    && high.medianApe + BACKTEST_GATE.minimumHighConfidenceImprovement > medium.medianApe + Number.EPSILON) {
    reasons.push('high-confidence-not-measurably-better');
  }
  const complete = !reasons.some((reason) =>
    reason === 'incomplete-overall'
      || reason === 'insufficient-high-confidence-cases'
      || reason === 'insufficient-medium-confidence-cases'
      || reason === 'incomplete-active-transaction-coverage');
  return { passed: complete && reasons.length === 0, complete, reasons };
}

export function backtestAcceptance(
  report: BacktestReport,
  transactionArtifactSha256: string,
  approvedAt: string,
): BacktestAcceptance {
  const gate = evaluateBacktestGate(report);
  const high = report.byConfidence.high;
  const medium = report.byConfidence.medium;
  if (!gate.passed || report.overall.medianApe === null || report.overall.p75Ape === null
    || high.medianApe === null || medium.medianApe === null
    || report.latestEligibleTransactionDate === null) {
    throw new Error(`Backtest does not pass acceptance: ${gate.reasons.join(', ')}`);
  }
  return {
    schemaVersion: 1,
    estimatorPolicyVersion: ESTIMATOR_POLICY_VERSION,
    transactionArtifactSha256,
    approvedAt,
    asOf: report.asOf,
    evaluatedThrough: report.asOf,
    latestEligibleTransactionDate: report.latestEligibleTransactionDate,
    thresholds: { ...BACKTEST_GATE },
    metrics: {
      estimateCoverage: report.overall.estimateCoverage,
      medianApe: report.overall.medianApe,
      p75Ape: report.overall.p75Ape,
      highConfidenceEstimatedCount: high.estimatedCount,
      highConfidenceMedianApe: high.medianApe,
      mediumConfidenceEstimatedCount: medium.estimatedCount,
      mediumConfidenceMedianApe: medium.medianApe,
    },
  };
}

/**
 * Evaluates each historic sale as a held-out subject. Every input index is read
 * only. One incrementally growing index contains strictly earlier-date sales.
 */
export function backtestTransactions(index: TransactionIndex, options: BacktestOptions): BacktestReport {
  const asOf = parseIsoDate(options.asOf);
  if (!asOf) throw new RangeError('Backtest requires a valid as-of date (YYYY-MM-DD)');

  const completeEntries = allTransactions(index);
  const completeLatestEligibleDate = latestEligibleDate(completeEntries);
  const entries = completeEntries.filter(({ transaction }) => {
    const date = transactionDate(transaction);
    return date !== null && date <= asOf;
  });
  const historicalCells: TransactionIndex['cells'] = {};
  const historicalIndex: TransactionIndex = { ...index, cells: historicalCells };
  const cases: BacktestCase[] = [];
  let historicalInsertions = 0;
  for (let start = 0; start < entries.length;) {
    let end = start + 1;
    const subjectDate = entries[start]!.transaction.transactionDate;
    while (end < entries.length && entries[end]!.transaction.transactionDate === subjectDate) end += 1;

    for (const { transaction } of entries.slice(start, end)) {
      if (!isEligibleSubject(transaction, asOf)) continue;
      const estimate = estimateMarket(
        backtestSubjectFromTransaction(transaction),
        historicalIndex,
        BACKTEST_FRESHNESS,
        transaction.transactionDate,
        { allowMissingAskingUnitPrice: true },
      );
      const median = estimate.marketUnitPriceMedian;
      const p25 = estimate.marketUnitPriceP25;
      const p75 = estimate.marketUnitPriceP75;
      const actual = transaction.buildingUnitPriceWan;
      const canScore = median !== null && p25 !== null && p75 !== null;
      cases.push({
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
      });
    }
    for (const { cellKey, transaction } of entries.slice(start, end)) {
      (historicalCells[cellKey] ??= []).push(transaction);
      historicalInsertions += 1;
    }
    start = end;
  }

  return {
    asOf: options.asOf,
    latestEligibleTransactionDate: completeLatestEligibleDate,
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
    work: { historicalIndexBuilds: 1, historicalInsertions },
    cases,
  };
}
