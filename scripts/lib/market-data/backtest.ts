import { estimateMarket, estimateWeightedBuildingPrices } from './estimator.ts';
import {
  decideParkingImputation,
  decideParkingFamily,
  decideScenarioCohort,
} from './acceptance-policy.ts';
import {
  ACTIVE_ESTIMATOR_POLICY,
  BACKTEST_ACCEPTANCE_THRESHOLDS,
  CANDIDATE_ESTIMATOR_POLICY_VERSION,
  ESTIMATOR_POLICY_VERSION,
  HIGH_CONFIDENCE_MIN_COMPARABLES,
  HIGH_IQR_RATIO,
  MEDIUM_IQR_RATIO,
  PARKING_BACKTEST_GATE,
  SCENARIO_BACKTEST_GATE,
} from './config.ts';
import type { EstimatorPolicy } from './config.ts';
import { neighborGridKeys } from './grid.ts';
import { estimateParking } from './parking.ts';
import { selectScenarioComparables } from './selector.ts';
import { weightedQuantile } from './statistics.ts';
import { NORMALIZED_PRIMARY_USES, PARKING_GRADES } from './types.ts';
import type {
  BuildingType,
  BacktestAcceptance,
  CandidateBacktestAcceptance,
  EstimateConfidence,
  EstimateStatus,
  MarketSubject,
  MarketTransaction,
  NormalizedPrimaryUse,
  ParkingGrade,
  ParkingFamilyAcceptance,
  ScenarioCohortAcceptance,
  SourceFreshness,
  TransactionIndex,
} from './types.ts';

export interface BacktestOptions {
  asOf: string;
  policy?: EstimatorPolicy;
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
  policyId: EstimatorPolicy['id'];
  /** Latest eligible sale in the complete active index, before as-of filtering. */
  latestEligibleTransactionDate: string | null;
  overall: BacktestMetrics;
  byBuildingType: Record<BuildingType, BacktestMetrics>;
  byConfidence: Record<EstimateConfidence, BacktestMetrics>;
  byStatus: Record<EstimateStatus, BacktestMetrics>;
  /** Exact-use metrics with grade-B building evidence disabled. */
  byPrimaryUseDirectOnly: Record<Exclude<NormalizedPrimaryUse, 'unknown'>, BacktestMetrics>;
  /** Exact-use metrics with causally imputed grade-B building evidence enabled. */
  byPrimaryUse: Record<Exclude<NormalizedPrimaryUse, 'unknown'>, BacktestMetrics>;
  byParkingGrade: Record<ParkingGrade, BacktestMetrics>;
  directOnly: BacktestMetrics;
  directPlusImputed: BacktestMetrics;
  parkingMaskedHoldout: ParkingMaskedHoldoutReport;
  work: {
    historicalIndexBuilds: number;
    historicalInsertions: number;
  };
  cases: BacktestCase[];
}

export interface ParkingMaskedHoldoutMetrics {
  caseCount: number;
  estimatedCount: number;
  estimateCoverage: number;
  priceMedianApe: number | null;
  priceP75Ape: number | null;
  areaMedianApe: number | null;
  areaP75Ape: number | null;
  priceIntervalCoverage: number | null;
  areaIntervalCoverage: number | null;
}

export interface ParkingMaskedHoldoutReport {
  overall: ParkingMaskedHoldoutMetrics;
  byParkingFamily: Record<'flat' | 'mechanical', ParkingMaskedHoldoutMetrics>;
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

function finitePositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function knownPrimaryUse(
  value: NormalizedPrimaryUse,
): value is Exclude<NormalizedPrimaryUse, 'unknown'> {
  return value !== 'unknown';
}

function scenarioUseEligibilityAccepted(transaction: MarketTransaction): boolean {
  return transaction.eligibility === 'reliable-eligible'
    || (transaction.eligibility === 'review-only'
      && transaction.primaryUse !== 'residential'
      && transaction.eligibilityReasons.length === 1
      && transaction.eligibilityReasons[0] === 'scenario-only-primary-use');
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

/** Intrinsic held-out eligibility, evaluated at the subject transaction date. */
export function heldOutTransactionEligible(transaction: MarketTransaction): boolean {
  const subjectDate = transactionDate(transaction);
  const coordinate = transaction.location.coordinate;
  if (!subjectDate || !coordinate || !Number.isFinite(coordinate.lat) || !Number.isFinite(coordinate.lng)) return false;
  if (transaction.eligibility !== 'reliable-eligible') return false;
  if (!transaction.district || transaction.ownership !== 'freehold') return false;
  if (!finitePositive(transaction.buildingAreaPing) || !finitePositive(transaction.buildingUnitPriceWan)) return false;
  if (!Number.isFinite(transaction.floor) || !Number.isFinite(transaction.totalFloors) || transaction.totalFloors <= 0) return false;
  return transaction.buildingType === 'apartment'
    || ageYearsAt(transaction.completionDate, subjectDate) !== null;
}

/** Scenario cohorts admit exact known-use grade-A sales without changing legacy eligibility. */
function scenarioHeldOutTransactionEligible(transaction: MarketTransaction): boolean {
  const subjectDate = transactionDate(transaction);
  const coordinate = transaction.location.coordinate;
  if (!subjectDate || !coordinate || !Number.isFinite(coordinate.lat) || !Number.isFinite(coordinate.lng)) return false;
  if (!scenarioUseEligibilityAccepted(transaction)
    || !knownPrimaryUse(transaction.primaryUse)
    || transaction.transferredBuildingCount !== 1
    || transaction.parkingEvidence.grade !== 'A') return false;
  if (!transaction.district || transaction.ownership !== 'freehold') return false;
  if (!finitePositive(transaction.buildingAreaPing) || !finitePositive(transaction.buildingUnitPriceWan)) return false;
  if (!Number.isFinite(transaction.floor) || !Number.isFinite(transaction.totalFloors) || transaction.totalFloors <= 0) return false;
  return transaction.buildingType === 'apartment'
    || ageYearsAt(transaction.completionDate, subjectDate) !== null;
}

/** Builds an evaluation subject without exposing the held-out sale price to the estimator. */
export function backtestSubjectFromTransaction(transaction: MarketTransaction): MarketSubject {
  const subjectDate = transactionDate(transaction)!;
  const buildingAreaPing = transaction.buildingAreaPing;
  if (!finitePositive(buildingAreaPing)) throw new RangeError('Backtest subject requires a positive building area');
  return {
    listingId: null,
    coordinate: transaction.location.coordinate!,
    district: transaction.district,
    ownership: transaction.ownership,
    buildingType: transaction.buildingType,
    buildingAreaPing,
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

function latestDate(
  entries: readonly IndexedTransaction[],
  eligible: (transaction: MarketTransaction) => boolean,
): string | null {
  let latest: string | null = null;
  for (const { transaction } of entries) {
    if (eligible(transaction)) latest = transaction.transactionDate;
  }
  return latest;
}

function latestEligibleDate(entries: readonly IndexedTransaction[]): string | null {
  return latestDate(entries, heldOutTransactionEligible);
}

/** Latest held-out-eligible transaction represented by the complete deduplicated index. */
export function latestEligibleTransactionDate(index: TransactionIndex): string | null {
  return latestEligibleDate(allTransactions(index));
}

function scenarioRuntimeInfluencingTransaction(transaction: MarketTransaction): boolean {
  const coordinate = transaction.location.coordinate;
  if (!transactionDate(transaction) || !coordinate
    || !Number.isFinite(coordinate.lat) || !Number.isFinite(coordinate.lng)) return false;

  const parkingTrainer = transaction.parkingEvidence.grade === 'A'
    && (transaction.parkingEvidence.family === 'flat'
      || transaction.parkingEvidence.family === 'mechanical')
    && finitePositive(transaction.parkingEvidence.officialPriceNtd)
    && finitePositive(transaction.parkingEvidence.officialAreaPing);

  const scenarioCommon = knownPrimaryUse(transaction.primaryUse)
    && transaction.transferredBuildingCount === 1
    && transaction.location.method !== 'unresolved'
    && transaction.district.length > 0
    && transaction.ownership !== 'unknown'
    && (transaction.buildingType === 'apartment'
      || (transaction.completionDate !== null
        && parseIsoDate(transaction.completionDate) !== null));
  const buildingEvidence = scenarioCommon
    && transaction.parkingEvidence.grade !== 'C'
    && finitePositive(transaction.buildingPriceNtd)
    && finitePositive(transaction.buildingAreaPing)
    && finitePositive(transaction.buildingUnitPriceWan)
    && (transaction.parkingEvidence.grade !== 'B'
      || transaction.parkingEvidence.imputation !== null);
  const bundleEvidence = scenarioCommon
    && transaction.parkingEvidence.grade === 'C'
    && finitePositive(transaction.totalPriceNtd)
    && finitePositive(transaction.totalAreaPing);
  return parkingTrainer || buildingEvidence || bundleEvidence;
}

/** Complete-index boundary for every transaction that can influence scenario runtime. */
export function latestScenarioInfluencingTransactionDate(index: TransactionIndex): string | null {
  return latestDate(allTransactions(index), scenarioRuntimeInfluencingTransaction);
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

interface ScenarioBacktestCase extends BacktestCase {
  primaryUse: Exclude<NormalizedPrimaryUse, 'unknown'>;
  parkingGrade: ParkingGrade;
}

interface MaskedParkingCase {
  family: 'flat' | 'mechanical';
  priceApe: number | null;
  areaApe: number | null;
  priceIntervalHit: boolean | null;
  areaIntervalHit: boolean | null;
}

function nearbyHistoricalTransactions(
  subject: MarketSubject,
  historicalIndex: TransactionIndex,
  policy: EstimatorPolicy,
): MarketTransaction[] {
  const maximumRadiusM = Math.max(...policy.stages.map((stage) => stage.radiusM));
  const byId = new Map<string, MarketTransaction>();
  for (const cellKey of neighborGridKeys(subject.coordinate, maximumRadiusM)) {
    for (const transaction of historicalIndex.cells[cellKey] ?? []) byId.set(transaction.id, transaction);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function scenarioConfidence(
  comparableCount: number,
  p25: number,
  median: number,
  p75: number,
  selectedStage: number | null,
  policy: EstimatorPolicy,
): EstimateConfidence {
  const iqrRatio = (p75 - p25) / median;
  const stage = selectedStage === null ? null : policy.stages[selectedStage - 1] ?? null;
  if (comparableCount >= HIGH_CONFIDENCE_MIN_COMPARABLES
    && stage?.confidenceClass === 'standard'
    && iqrRatio <= HIGH_IQR_RATIO) return 'high';
  return comparableCount >= 3 && iqrRatio <= MEDIUM_IQR_RATIO ? 'medium' : 'low';
}

function scenarioBacktestCase(
  transaction: MarketTransaction,
  historicalIndex: TransactionIndex,
  policy: EstimatorPolicy,
  allowImputedParking: boolean,
): ScenarioBacktestCase {
  const primaryUse = transaction.primaryUse as Exclude<NormalizedPrimaryUse, 'unknown'>;
  const actual = transaction.buildingUnitPriceWan!;
  const subject = backtestSubjectFromTransaction(transaction);
  const selection = selectScenarioComparables(
    subject,
    nearbyHistoricalTransactions(subject, historicalIndex, policy),
    transaction.transactionDate,
    { primaryUse, allowImputedParking },
    policy,
  );
  const weighted = estimateWeightedBuildingPrices(selection.included);
  const median = weighted.marketUnitPriceMedian;
  const p25 = weighted.marketUnitPriceP25;
  const p75 = weighted.marketUnitPriceP75;
  const canScore = weighted.comparables.length >= 3
    && median !== null && p25 !== null && p75 !== null;
  const confidence = canScore
    ? scenarioConfidence(weighted.comparables.length, p25, median, p75, selection.selectedStage, policy)
    : 'low';
  const status: EstimateStatus = !canScore ? 'unavailable' : confidence === 'low' ? 'review' : 'reliable';
  return {
    subjectDate: transaction.transactionDate,
    buildingType: transaction.buildingType,
    primaryUse,
    parkingGrade: transaction.parkingEvidence.grade,
    confidence,
    status,
    actualUnitPriceWan: actual,
    estimatedUnitPriceWan: canScore ? median : null,
    estimatedP25Wan: canScore ? p25 : null,
    estimatedP75Wan: canScore ? p75 : null,
    ape: canScore ? Math.abs(median - actual) / actual : null,
    bias: canScore ? (median - actual) / actual : null,
    intervalHit: canScore ? actual >= p25 && actual <= p75 : null,
    comparableDates: weighted.comparables
      .map((candidate) => candidate.transaction.transactionDate)
      .sort(),
  };
}

function maskedParkingCase(
  transaction: MarketTransaction,
  historicalIndex: TransactionIndex,
  policy: EstimatorPolicy,
): MaskedParkingCase | null {
  const family = transaction.parkingEvidence.family;
  const actualPrice = transaction.parkingEvidence.officialPriceNtd;
  const actualArea = transaction.parkingEvidence.officialAreaPing;
  const coordinate = transaction.location.coordinate;
  if (transaction.parkingEvidence.grade !== 'A'
    || (family !== 'flat' && family !== 'mechanical')
    || !finitePositive(actualPrice) || !finitePositive(actualArea)
    || !coordinate || !Number.isFinite(coordinate.lat) || !Number.isFinite(coordinate.lng)) return null;
  const subject = backtestSubjectFromTransaction(transaction);
  const estimate = estimateParking({
    coordinate,
    matchedAddress: transaction.location.matchedAddress,
    buildingType: transaction.buildingType,
    family,
  }, nearbyHistoricalTransactions(subject, historicalIndex, policy), transaction.transactionDate);
  return {
    family,
    priceApe: estimate ? Math.abs(estimate.priceP50Ntd - actualPrice) / actualPrice : null,
    areaApe: estimate ? Math.abs(estimate.areaP50Ping - actualArea) / actualArea : null,
    priceIntervalHit: estimate ? actualPrice >= estimate.priceP25Ntd && actualPrice <= estimate.priceP75Ntd : null,
    areaIntervalHit: estimate ? actualArea >= estimate.areaP25Ping && actualArea <= estimate.areaP75Ping : null,
  };
}

function maskedParkingMetrics(cases: readonly MaskedParkingCase[]): ParkingMaskedHoldoutMetrics {
  const estimated = cases.filter((item) => item.priceApe !== null && item.areaApe !== null
    && item.priceIntervalHit !== null && item.areaIntervalHit !== null);
  const priceApes = estimated.map((item, index) => ({ id: String(index), value: item.priceApe!, weight: 1 }));
  const areaApes = estimated.map((item, index) => ({ id: String(index), value: item.areaApe!, weight: 1 }));
  return {
    caseCount: cases.length,
    estimatedCount: estimated.length,
    estimateCoverage: cases.length === 0 ? 0 : estimated.length / cases.length,
    priceMedianApe: priceApes.length === 0 ? null : weightedQuantile(priceApes, 0.5),
    priceP75Ape: priceApes.length === 0 ? null : weightedQuantile(priceApes, 0.75),
    areaMedianApe: areaApes.length === 0 ? null : weightedQuantile(areaApes, 0.5),
    areaP75Ape: areaApes.length === 0 ? null : weightedQuantile(areaApes, 0.75),
    priceIntervalCoverage: estimated.length === 0
      ? null
      : estimated.filter((item) => item.priceIntervalHit).length / estimated.length,
    areaIntervalCoverage: estimated.length === 0
      ? null
      : estimated.filter((item) => item.areaIntervalHit).length / estimated.length,
  };
}

/** Deterministic acceptance policy shared by the CLI and persisted artifact. */
export function evaluateBacktestGate(report: BacktestReport): BacktestGateResult {
  const reasons: string[] = [];
  const overall = report.overall;
  const reliable = report.byStatus.reliable;
  const high = report.byConfidence.high;
  const medium = report.byConfidence.medium;
  if (overall.caseCount === 0 || reliable.estimatedCount === 0
    || reliable.medianApe === null || reliable.p75Ape === null) {
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
  if (overall.estimateCoverage < BACKTEST_GATE.minimumEstimateCoverage) {
    reasons.push('estimate-coverage-target-missed');
  }
  if (reliable.medianApe !== null && reliable.medianApe > BACKTEST_GATE.medianApeMax) {
    reasons.push('median-ape-target-missed');
  }
  if (reliable.p75Ape !== null && reliable.p75Ape > BACKTEST_GATE.p75ApeMax) {
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

function parkingComparisonFor(
  report: BacktestReport,
): CandidateBacktestAcceptance['parkingComparison'] {
  const direct = report.directOnly;
  const imputed = report.directPlusImputed;
  return {
    directCoverage: direct.estimateCoverage,
    imputedCoverage: imputed.estimateCoverage,
    directMedianApe: direct.medianApe,
    imputedMedianApe: imputed.medianApe,
    directP75Ape: direct.p75Ape,
    imputedP75Ape: imputed.p75Ape,
    biasRegression: direct.bias === null || imputed.bias === null
      ? null
      : Math.abs(imputed.bias) - Math.abs(direct.bias),
    intervalCoverageRegression: direct.intervalCoverage === null || imputed.intervalCoverage === null
      ? null
      : direct.intervalCoverage - imputed.intervalCoverage,
  };
}

function parkingFamilyAcceptance(
  metrics: ParkingMaskedHoldoutMetrics,
): ParkingFamilyAcceptance {
  const decision = decideParkingFamily(metrics);
  return { ...metrics, status: decision.status, reasons: decision.reasons };
}

function parkingFamilyAcceptances(
  report: BacktestReport,
): CandidateBacktestAcceptance['parkingFamilies'] {
  return {
    flat: parkingFamilyAcceptance(report.parkingMaskedHoldout.byParkingFamily.flat),
    mechanical: parkingFamilyAcceptance(report.parkingMaskedHoldout.byParkingFamily.mechanical),
  };
}

/** Strict challenger gate; it cannot authorize the legacy production runtime. */
export function evaluateCandidateBacktestGate(report: BacktestReport): BacktestGateResult {
  const legacy = evaluateBacktestGate(report);
  const reasons = [...legacy.reasons];
  const residential = scenarioCohortAcceptance(report.byPrimaryUse.residential);
  if (residential.status !== 'accepted') reasons.push('residential-use-cohort-failed');
  const families = parkingFamilyAcceptances(report);
  for (const family of ['flat', 'mechanical'] as const) {
    if (families[family].status !== 'accepted') {
      reasons.push(`parking-family-${family}-not-accepted`);
    }
  }
  if (!decideParkingImputation(parkingComparisonFor(report), families)) {
    reasons.push('parking-imputation-comparison-failed');
  }
  return {
    passed: reasons.length === 0,
    complete: legacy.complete
      && residential.status !== 'diagnostic-only'
      && families.flat.status !== 'diagnostic-only'
      && families.mechanical.status !== 'diagnostic-only',
    reasons: [...new Set(reasons)],
  };
}

/** @deprecated Challenger-only compatibility name. */
export const evaluateProductionBacktestGate = evaluateCandidateBacktestGate;

/** Builds the active schema-2 / policy-4 aggregate production proof. */
export function backtestAcceptance(
  report: BacktestReport,
  transactionArtifactSha256: string,
  approvedAt: string,
): BacktestAcceptance {
  const gate = evaluateBacktestGate(report);
  const reliable = report.byStatus.reliable;
  const high = report.byConfidence.high;
  const medium = report.byConfidence.medium;
  if (!gate.passed || reliable.medianApe === null || reliable.p75Ape === null
    || high.medianApe === null || medium.medianApe === null
    || report.latestEligibleTransactionDate === null) {
    throw new Error(`Backtest does not pass acceptance: ${gate.reasons.join(', ')}`);
  }
  return {
    schemaVersion: 2,
    estimatorPolicyVersion: ESTIMATOR_POLICY_VERSION,
    policyId: report.policyId,
    transactionArtifactSha256,
    approvedAt,
    asOf: report.asOf,
    evaluatedThrough: report.asOf,
    latestEligibleTransactionDate: report.latestEligibleTransactionDate,
    thresholds: { ...BACKTEST_GATE },
    metrics: {
      estimateCoverage: report.overall.estimateCoverage,
      reliableEstimatedCount: reliable.estimatedCount,
      reliableMedianApe: reliable.medianApe,
      reliableP75Ape: reliable.p75Ape,
      highConfidenceEstimatedCount: high.estimatedCount,
      highConfidenceMedianApe: high.medianApe,
      mediumConfidenceEstimatedCount: medium.estimatedCount,
      mediumConfidenceMedianApe: medium.medianApe,
    },
  };
}

/** Builds a strict aggregate challenger proof after every policy-6 gate passes. */
export function candidateBacktestAcceptance(
  report: BacktestReport,
  transactionArtifactSha256: string,
  approvedAt: string,
): CandidateBacktestAcceptance {
  const gate = evaluateCandidateBacktestGate(report);
  const reliable = report.byStatus.reliable;
  const high = report.byConfidence.high;
  const medium = report.byConfidence.medium;
  if (!gate.passed || reliable.medianApe === null || reliable.p75Ape === null
    || high.medianApe === null || medium.medianApe === null
    || report.latestEligibleTransactionDate === null) {
    throw new Error(`Backtest does not pass acceptance: ${gate.reasons.join(', ')}`);
  }
  const parkingComparison = parkingComparisonFor(report);
  const parkingFamilies = parkingFamilyAcceptances(report);
  const parkingImputationAccepted = decideParkingImputation(parkingComparison, parkingFamilies);
  const activeUseMetrics = report.byPrimaryUse;
  const useCohorts = Object.fromEntries(
    NORMALIZED_PRIMARY_USES.filter(knownPrimaryUse).map((primaryUse) => [
      primaryUse,
      scenarioCohortAcceptance(activeUseMetrics[primaryUse]),
    ]),
  ) as CandidateBacktestAcceptance['useCohorts'];
  return {
    schemaVersion: 3,
    estimatorPolicyVersion: CANDIDATE_ESTIMATOR_POLICY_VERSION,
    policyId: report.policyId,
    transactionArtifactSha256,
    approvedAt,
    asOf: report.asOf,
    evaluatedThrough: report.asOf,
    latestEligibleTransactionDate: report.latestEligibleTransactionDate,
    thresholds: {
      ...BACKTEST_GATE,
      ...SCENARIO_BACKTEST_GATE,
      minimumParkingFamilyCases: PARKING_BACKTEST_GATE.minimumMaskedCases,
      minimumParkingEstimateCoverage: PARKING_BACKTEST_GATE.minimumEstimateCoverage,
      parkingPriceMedianApeMax: PARKING_BACKTEST_GATE.priceMedianApeMax,
      parkingPriceP75ApeMax: PARKING_BACKTEST_GATE.priceP75ApeMax,
      parkingAreaMedianApeMax: PARKING_BACKTEST_GATE.areaMedianApeMax,
      parkingAreaP75ApeMax: PARKING_BACKTEST_GATE.areaP75ApeMax,
      minimumParkingPriceIntervalCoverage: PARKING_BACKTEST_GATE.minimumPriceIntervalCoverage,
      minimumParkingAreaIntervalCoverage: PARKING_BACKTEST_GATE.minimumAreaIntervalCoverage,
    },
    metrics: {
      estimateCoverage: report.overall.estimateCoverage,
      reliableEstimatedCount: reliable.estimatedCount,
      reliableMedianApe: reliable.medianApe,
      reliableP75Ape: reliable.p75Ape,
      highConfidenceEstimatedCount: high.estimatedCount,
      highConfidenceMedianApe: high.medianApe,
      mediumConfidenceEstimatedCount: medium.estimatedCount,
      mediumConfidenceMedianApe: medium.medianApe,
    },
    useCohorts,
    parkingImputationAccepted,
    parkingFamilies,
    parkingComparison,
  };
}

function scenarioCohortAcceptance(metric: BacktestMetrics): ScenarioCohortAcceptance {
  const decision = decideScenarioCohort({
    scoredCases: metric.estimatedCount,
    medianApe: metric.medianApe,
    p75Ape: metric.p75Ape,
    bias: metric.bias,
    intervalCoverage: metric.intervalCoverage,
  });
  return {
    status: decision.status,
    scoredCases: metric.estimatedCount,
    estimateCoverage: metric.estimateCoverage,
    medianApe: metric.medianApe,
    p75Ape: metric.p75Ape,
    bias: metric.bias,
    intervalCoverage: metric.intervalCoverage,
    reasons: decision.reasons,
  };
}

/**
 * Evaluates each historic sale as a held-out subject. Every input index is read
 * only. One incrementally growing index contains strictly earlier-date sales.
 */
export function backtestTransactions(index: TransactionIndex, options: BacktestOptions): BacktestReport {
  const asOf = parseIsoDate(options.asOf);
  if (!asOf) throw new RangeError('Backtest requires a valid as-of date (YYYY-MM-DD)');
  const policy = options.policy ?? ACTIVE_ESTIMATOR_POLICY;

  const completeEntries = allTransactions(index);
  const completeLatestEligibleDate = latestDate(completeEntries, scenarioRuntimeInfluencingTransaction);
  const entries = completeEntries.filter(({ transaction }) => {
    const date = transactionDate(transaction);
    return date !== null && date <= asOf;
  });
  const historicalCells: TransactionIndex['cells'] = {};
  const historicalIndex: TransactionIndex = { ...index, cells: historicalCells };
  const cases: BacktestCase[] = [];
  const directOnlyCases: ScenarioBacktestCase[] = [];
  const directPlusImputedCases: ScenarioBacktestCase[] = [];
  const parkingMaskedCases: MaskedParkingCase[] = [];
  let historicalInsertions = 0;
  for (let start = 0; start < entries.length;) {
    let end = start + 1;
    const subjectDate = entries[start]!.transaction.transactionDate;
    while (end < entries.length && entries[end]!.transaction.transactionDate === subjectDate) end += 1;

    for (const { transaction } of entries.slice(start, end)) {
      if (heldOutTransactionEligible(transaction)) {
        const actual = transaction.buildingUnitPriceWan;
        if (finitePositive(actual)) {
          const estimate = estimateMarket(
            backtestSubjectFromTransaction(transaction),
            historicalIndex,
            BACKTEST_FRESHNESS,
            transaction.transactionDate,
            { allowMissingAskingUnitPrice: true, policy },
          );
          const median = estimate.marketUnitPriceMedian;
          const p25 = estimate.marketUnitPriceP25;
          const p75 = estimate.marketUnitPriceP75;
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
      }
      if (scenarioHeldOutTransactionEligible(transaction)) {
        directOnlyCases.push(scenarioBacktestCase(transaction, historicalIndex, policy, false));
        directPlusImputedCases.push(scenarioBacktestCase(transaction, historicalIndex, policy, true));
      }
      const parkingCase = maskedParkingCase(transaction, historicalIndex, policy);
      if (parkingCase) parkingMaskedCases.push(parkingCase);
    }
    for (const { cellKey, transaction } of entries.slice(start, end)) {
      (historicalCells[cellKey] ??= []).push(transaction);
      historicalInsertions += 1;
    }
    start = end;
  }

  const knownUses = NORMALIZED_PRIMARY_USES.filter(knownPrimaryUse);
  const byPrimaryUseDirectOnly = Object.fromEntries(knownUses.map((primaryUse) => [
    primaryUse,
    metrics(directOnlyCases.filter((backtestCase) => backtestCase.primaryUse === primaryUse)),
  ])) as Record<Exclude<NormalizedPrimaryUse, 'unknown'>, BacktestMetrics>;
  const byPrimaryUse = Object.fromEntries(knownUses.map((primaryUse) => [
    primaryUse,
    metrics(directPlusImputedCases.filter((backtestCase) => backtestCase.primaryUse === primaryUse)),
  ])) as Record<Exclude<NormalizedPrimaryUse, 'unknown'>, BacktestMetrics>;
  const byParkingGrade = Object.fromEntries(PARKING_GRADES.map((parkingGrade) => [
    parkingGrade,
    metrics(directPlusImputedCases.filter((backtestCase) => backtestCase.parkingGrade === parkingGrade)),
  ])) as Record<ParkingGrade, BacktestMetrics>;

  return {
    asOf: options.asOf,
    policyId: policy.id,
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
    byStatus: {
      reliable: metrics(cases.filter((backtestCase) => backtestCase.status === 'reliable')),
      review: metrics(cases.filter((backtestCase) => backtestCase.status === 'review')),
      unavailable: metrics(cases.filter((backtestCase) => backtestCase.status === 'unavailable')),
    },
    byPrimaryUseDirectOnly,
    byPrimaryUse,
    byParkingGrade,
    directOnly: metrics(directOnlyCases),
    directPlusImputed: metrics(directPlusImputedCases),
    parkingMaskedHoldout: {
      overall: maskedParkingMetrics(parkingMaskedCases),
      byParkingFamily: {
        flat: maskedParkingMetrics(parkingMaskedCases.filter((item) => item.family === 'flat')),
        mechanical: maskedParkingMetrics(parkingMaskedCases.filter((item) => item.family === 'mechanical')),
      },
    },
    work: { historicalIndexBuilds: 1, historicalInsertions },
    cases,
  };
}
