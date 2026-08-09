import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { deriveBuildingValues, relativeIqrRatio, sameDerivedNumber } from './arithmetic.ts';
import { isValidDateString } from '../date.ts';
import {
  decideParkingFamily,
  decideParkingImputation,
  decideScenarioCohort,
} from './acceptance-policy.ts';
import {
  BACKTEST_ACCEPTANCE_THRESHOLDS,
  ACTIVE_ESTIMATOR_POLICY,
  CANDIDATE_ESTIMATOR_POLICY_VERSION,
  CANDIDATE_MARKET_SCHEMA_VERSION,
  DOORPLATE_STALE_DAYS,
  ESTIMATOR_POLICY_VERSION,
  MARKET_SCHEMA_VERSION,
  MIN_PRODUCTION_DOORPLATES,
  MIN_PRODUCTION_TRANSACTIONS,
  PARKING_BACKTEST_GATE,
  SCENARIO_BACKTEST_GATE,
  TRANSACTION_STALE_DAYS,
} from './config.ts';
import type { PolicyId } from './config.ts';
import {
  latestEligibleTransactionDate,
  latestScenarioInfluencingTransactionDate,
} from './backtest.ts';
import { NORMALIZED_PRIMARY_USES, PARKING_GRADES } from './types.ts';
import { deriveAcceptedParkingImputation } from './parking-imputation.ts';
import type {
  BacktestAcceptance,
  CandidateBacktestAcceptance,
  BuildingUnitPriceBoundsWan,
  DoorplateIndex,
  MarketDataBundle,
  MarketDataManifest,
  MarketTransaction,
  ParkingImputationEvidence,
  SourceFreshness,
  ScenarioCohortAcceptance,
  ParkingFamilyAcceptance,
  TransactionBuildDiagnostics,
  TransactionIndex,
} from './types.ts';

const TAIPEI_BOUNDS = { minLat: 24.7, maxLat: 25.4, minLng: 121.2, maxLng: 121.9 };

interface PublicationFileOps {
  rename(from: string, to: string): Promise<void>;
  rm(file: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  readFile(file: string): Promise<Buffer>;
}

export interface PublishOptions {
  minDoorplates?: number;
  minTransactions?: number;
  readerRetries?: number;
  readerRetryDelayMs?: number;
  /** @internal Narrow file-operation seam for publication failure/window tests. */
  publicationFileOps?: Partial<Pick<PublicationFileOps, 'rename' | 'rm'>>;
}

const publicationFileOps: PublicationFileOps = {
  rename: (from, to) => fsp.rename(from, to),
  rm: (file, options) => fsp.rm(file, options),
  readFile: (file) => fsp.readFile(file),
};

/** Byte/code-unit ordering is locale-independent and therefore checksum-safe. */
export function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk: string | Buffer) => { hash.update(chunk); });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareStableText(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function writeStableJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${stableJson(value)}\n`);
}

/** Counts cell entries without allocating a full-index flattened copy. */
export function countIndexEntries(cells: Record<string, readonly unknown[]>): number {
  let count = 0;
  for (const entries of Object.values(cells)) count += entries.length;
  return count;
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

export function readManifest(root: string): MarketDataManifest | null {
  return readJson<MarketDataManifest>(path.join(root, 'manifest.json'));
}

/** Acceptance is a sibling of the immutable active build, so it cannot alter build checksums. */
export function backtestAcceptancePath(root: string): string {
  return path.join(path.dirname(root), `${path.basename(root)}-backtest-acceptance.json`);
}

export function transactionArtifactChecksum(manifest: MarketDataManifest): string | null {
  const checksum = manifest.artifacts?.['transactions-index.json']?.sha256;
  return typeof checksum === 'string' && checksum.length > 0 ? checksum : null;
}

export function marketDataManifestHasCurrentPolicyProvenance(
  manifest: MarketDataManifest,
): boolean {
  return manifest.schemaVersion === MARKET_SCHEMA_VERSION
    && manifest.estimatorPolicyVersion === ESTIMATOR_POLICY_VERSION;
}

export function assertCurrentMarketDataIndexPolicy(
  manifest: MarketDataManifest,
): void {
  if (!marketDataManifestHasCurrentPolicyProvenance(manifest)) {
    throw new Error(
      'Active market-data index policy provenance does not match the runtime policy; run update first',
    );
  }
}

function finiteRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateExcludedReasonDiagnostics(value: unknown, excluded: number): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Transaction normalization diagnostics lack exclusion reasons');
  }
  const excludedByReason = value as Record<string, unknown>;
  const reasons = Object.keys(excludedByReason);
  const excludedReasonCount = reasons.reduce(
    (total, reason) => total + (excludedByReason[reason] as number),
    0,
  );
  if (reasons.some((reason) => !reason
      || !Number.isSafeInteger(excludedByReason[reason])
      || (excludedByReason[reason] as number) <= 0)
    || reasons.join('\n') !== [...reasons].sort(compareStableText).join('\n')
    || excludedReasonCount !== excluded) {
    throw new Error('Transaction normalization exclusion reasons are invalid or unstable');
  }
}

function validateLegacyTransactionBuildDiagnostics(value: unknown, recordCount: number): void {
  const keys = ['excluded', 'excludedByReason', 'rawRows', 'reliableEligible', 'reviewOnly'];
  if (!exactObject(value, keys)) {
    throw new Error('Legacy transaction normalization diagnostics do not match their schema');
  }
  const rawRows = value.rawRows;
  const reliableEligible = value.reliableEligible;
  const reviewOnly = value.reviewOnly;
  const excluded = value.excluded;
  if (![rawRows, reliableEligible, reviewOnly, excluded]
    .every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) {
    throw new Error('Legacy transaction normalization diagnostics contain invalid counts');
  }
  if (rawRows !== (reliableEligible as number) + (reviewOnly as number) + (excluded as number)
      || recordCount !== (reliableEligible as number) + (reviewOnly as number)) {
    throw new Error('Legacy transaction normalization diagnostics do not match manifest counts');
  }
  validateExcludedReasonDiagnostics(value.excludedByReason, excluded as number);
}

function validateExactCountRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Transaction normalization ${label} diagnostics are missing`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`Transaction normalization ${label} keys are incomplete or unstable`);
  }
  const counts = keys.map((key) => record[key]);
  if (!counts.every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) {
    throw new Error(`Transaction normalization ${label} counts are invalid`);
  }
  return (counts as number[]).reduce((total, count) => total + count, 0);
}

function validateTransactionBuildDiagnostics(
  value: TransactionBuildDiagnostics,
  recordCount: number,
  includeGradeBComponents = true,
): void {
  const expectedKeys = [
    'byParkingGrade',
    'byPrimaryUse',
    'excluded',
    'excludedByReason',
    ...(includeGradeBComponents ? ['gradeBByComponent'] : []),
    'gradeBImputed',
    'gradeBUnresolved',
    'rawRows',
    'reliableEligible',
    'reviewOnly',
  ];
  if (!exactObject(value, expectedKeys)) {
    throw new Error('Manifest transaction normalization diagnostics do not match their schema');
  }
  const counts = [
    value.rawRows,
    value.reliableEligible,
    value.reviewOnly,
    value.excluded,
    value.gradeBImputed,
    value.gradeBUnresolved,
  ];
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new Error('Transaction normalization diagnostics contain invalid counts');
  }
  if (value.rawRows !== value.reliableEligible + value.reviewOnly + value.excluded
    || recordCount !== value.reliableEligible + value.reviewOnly) {
    throw new Error('Transaction normalization diagnostics do not match manifest counts');
  }
  const primaryUseCount = validateExactCountRecord(
    value.byPrimaryUse,
    NORMALIZED_PRIMARY_USES,
    'primary-use',
  );
  const parkingGradeCount = validateExactCountRecord(
    value.byParkingGrade,
    PARKING_GRADES,
    'parking-grade',
  );
  if (primaryUseCount !== recordCount || parkingGradeCount !== recordCount
      || value.gradeBImputed + value.gradeBUnresolved !== value.byParkingGrade.B) {
    throw new Error('Transaction normalization use or parking diagnostics do not match retained records');
  }
  if (includeGradeBComponents) {
    const componentCount = validateExactCountRecord(
      value.gradeBByComponent,
      ['missingBoth', 'officialAreaOnly', 'officialPriceOnly'],
      'grade-B-component',
    );
    if (componentCount !== value.byParkingGrade.B) {
      throw new Error('Transaction normalization grade-B component diagnostics do not match retained records');
    }
  }
  validateExcludedReasonDiagnostics(value.excludedByReason, value.excluded);
}

function exactObject(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>).sort(compareStableText);
  const expected = [...expectedKeys].sort(compareStableText);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

const ACCEPTANCE_IDENTITY_KEYS = [
  'approvedAt',
  'asOf',
  'estimatorPolicyVersion',
  'evaluatedThrough',
  'latestEligibleTransactionDate',
  'metrics',
  'policyId',
  'schemaVersion',
  'thresholds',
  'transactionArtifactSha256',
] as const;
const GLOBAL_THRESHOLD_KEYS = [
  'medianApeMax',
  'minimumConfidenceSliceCases',
  'minimumEstimateCoverage',
  'minimumHighConfidenceImprovement',
  'p75ApeMax',
] as const;
const SCENARIO_THRESHOLD_KEYS = [
  ...GLOBAL_THRESHOLD_KEYS,
  'maximumAbsoluteBias',
  'maximumAbsoluteBiasRegression',
  'maximumIntervalCoverageRegression',
  'minimumIntervalCoverage',
  'minimumParkingAreaIntervalCoverage',
  'minimumParkingEstimateCoverage',
  'minimumParkingFamilyCases',
  'minimumParkingPriceIntervalCoverage',
  'minimumUseCohortCases',
  'parkingAreaMedianApeMax',
  'parkingAreaP75ApeMax',
  'parkingPriceMedianApeMax',
  'parkingPriceP75ApeMax',
] as const;
const ACCEPTANCE_METRIC_KEYS = [
  'estimateCoverage',
  'highConfidenceEstimatedCount',
  'highConfidenceMedianApe',
  'mediumConfidenceEstimatedCount',
  'mediumConfidenceMedianApe',
  'reliableEstimatedCount',
  'reliableMedianApe',
  'reliableP75Ape',
] as const;
const SCENARIO_COHORT_KEYS = [
  'bias',
  'estimateCoverage',
  'intervalCoverage',
  'medianApe',
  'p75Ape',
  'reasons',
  'scoredCases',
  'status',
] as const;
const PARKING_COMPARISON_KEYS = [
  'biasRegression',
  'directCoverage',
  'directMedianApe',
  'directP75Ape',
  'imputedCoverage',
  'imputedMedianApe',
  'imputedP75Ape',
  'intervalCoverageRegression',
] as const;
const PARKING_FAMILY_KEYS = [
  'areaIntervalCoverage',
  'areaMedianApe',
  'areaP75Ape',
  'caseCount',
  'estimateCoverage',
  'estimatedCount',
  'priceIntervalCoverage',
  'priceMedianApe',
  'priceP75Ape',
  'reasons',
  'status',
] as const;
const PARKING_FAMILIES = ['flat', 'mechanical'] as const;
const KNOWN_PRIMARY_USES = NORMALIZED_PRIMARY_USES.filter((use) => use !== 'unknown');

function approvedBacktestThresholds(thresholds: unknown): boolean {
  if (!exactObject(thresholds, GLOBAL_THRESHOLD_KEYS)) return false;
  const value = thresholds as Record<string, unknown>;
  return value.medianApeMax === BACKTEST_ACCEPTANCE_THRESHOLDS.medianApeMax
    && value.p75ApeMax === BACKTEST_ACCEPTANCE_THRESHOLDS.p75ApeMax
    && value.minimumEstimateCoverage === BACKTEST_ACCEPTANCE_THRESHOLDS.minimumEstimateCoverage
    && value.minimumConfidenceSliceCases === BACKTEST_ACCEPTANCE_THRESHOLDS.minimumConfidenceSliceCases
    && value.minimumHighConfidenceImprovement === BACKTEST_ACCEPTANCE_THRESHOLDS.minimumHighConfidenceImprovement;
}

function approvedCandidateBacktestThresholds(thresholds: unknown): boolean {
  if (!exactObject(thresholds, SCENARIO_THRESHOLD_KEYS)) return false;
  const value = thresholds as Record<string, unknown>;
  return value.medianApeMax === BACKTEST_ACCEPTANCE_THRESHOLDS.medianApeMax
    && value.p75ApeMax === BACKTEST_ACCEPTANCE_THRESHOLDS.p75ApeMax
    && value.minimumEstimateCoverage === BACKTEST_ACCEPTANCE_THRESHOLDS.minimumEstimateCoverage
    && value.minimumConfidenceSliceCases === BACKTEST_ACCEPTANCE_THRESHOLDS.minimumConfidenceSliceCases
    && value.minimumHighConfidenceImprovement === BACKTEST_ACCEPTANCE_THRESHOLDS.minimumHighConfidenceImprovement
    && value.minimumUseCohortCases === SCENARIO_BACKTEST_GATE.minimumUseCohortCases
    && value.maximumAbsoluteBiasRegression === SCENARIO_BACKTEST_GATE.maximumAbsoluteBiasRegression
    && value.maximumIntervalCoverageRegression === SCENARIO_BACKTEST_GATE.maximumIntervalCoverageRegression
    && value.maximumAbsoluteBias === SCENARIO_BACKTEST_GATE.maximumAbsoluteBias
    && value.minimumIntervalCoverage === SCENARIO_BACKTEST_GATE.minimumIntervalCoverage
    && value.minimumParkingFamilyCases === PARKING_BACKTEST_GATE.minimumMaskedCases
    && value.minimumParkingEstimateCoverage === PARKING_BACKTEST_GATE.minimumEstimateCoverage
    && value.parkingPriceMedianApeMax === PARKING_BACKTEST_GATE.priceMedianApeMax
    && value.parkingPriceP75ApeMax === PARKING_BACKTEST_GATE.priceP75ApeMax
    && value.parkingAreaMedianApeMax === PARKING_BACKTEST_GATE.areaMedianApeMax
    && value.parkingAreaP75ApeMax === PARKING_BACKTEST_GATE.areaP75ApeMax
    && value.minimumParkingPriceIntervalCoverage
      === PARKING_BACKTEST_GATE.minimumPriceIntervalCoverage
    && value.minimumParkingAreaIntervalCoverage
      === PARKING_BACKTEST_GATE.minimumAreaIntervalCoverage;
}

function validAcceptanceMetrics(metrics: unknown, thresholds: Record<string, unknown>): boolean {
  if (!exactObject(metrics, ACCEPTANCE_METRIC_KEYS)) return false;
  const value = metrics as Record<string, unknown>;
  const minimumCoverage = thresholds.minimumEstimateCoverage as number;
  const minimumCases = thresholds.minimumConfidenceSliceCases as number;
  const confidenceImprovement = thresholds.minimumHighConfidenceImprovement as number;
  const medianApeMax = thresholds.medianApeMax as number;
  const p75ApeMax = thresholds.p75ApeMax as number;
  if (!finiteRatio(value.estimateCoverage) || value.estimateCoverage > 1
    || !Number.isSafeInteger(value.reliableEstimatedCount) || (value.reliableEstimatedCount as number) <= 0
    || !finiteRatio(value.reliableMedianApe) || !finiteRatio(value.reliableP75Ape)
    || !Number.isSafeInteger(value.highConfidenceEstimatedCount) || (value.highConfidenceEstimatedCount as number) < 0
    || !Number.isSafeInteger(value.mediumConfidenceEstimatedCount) || (value.mediumConfidenceEstimatedCount as number) < 0
    || !finiteRatio(value.highConfidenceMedianApe)
    || !finiteRatio(value.mediumConfidenceMedianApe)
    || value.reliableP75Ape < value.reliableMedianApe
    || value.reliableEstimatedCount !== (value.highConfidenceEstimatedCount as number)
      + (value.mediumConfidenceEstimatedCount as number)) return false;
  return value.estimateCoverage >= minimumCoverage
    && value.reliableMedianApe <= medianApeMax
    && value.reliableP75Ape <= p75ApeMax
    && (value.highConfidenceEstimatedCount as number) >= minimumCases
    && (value.mediumConfidenceEstimatedCount as number) >= minimumCases
    && (value.highConfidenceMedianApe as number) + confidenceImprovement
      <= (value.mediumConfidenceMedianApe as number) + Number.EPSILON;
}

function nullableNonnegativeFinite(value: unknown): value is number | null {
  return value === null || finiteRatio(value);
}

function nullableFinite(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function coverageHasIntegerDenominator(scoredCases: number, coverage: number): boolean {
  if (scoredCases === 0) return coverage === 0;
  if (coverage <= 0) return false;
  const denominator = scoredCases / coverage;
  const rounded = Math.round(denominator);
  return Number.isSafeInteger(rounded)
    && rounded >= scoredCases
    && Math.abs(scoredCases / rounded - coverage) <= Number.EPSILON * 8;
}

function validScenarioCohort(value: unknown): value is ScenarioCohortAcceptance {
  if (!exactObject(value, SCENARIO_COHORT_KEYS)) return false;
  const cohort = value as unknown as ScenarioCohortAcceptance;
  if ((cohort.status !== 'accepted' && cohort.status !== 'diagnostic-only' && cohort.status !== 'failed')
    || !Number.isSafeInteger(cohort.scoredCases) || cohort.scoredCases < 0
    || !finiteRatio(cohort.estimateCoverage) || cohort.estimateCoverage > 1
    || !nullableNonnegativeFinite(cohort.medianApe)
    || !nullableNonnegativeFinite(cohort.p75Ape)
    || !nullableFinite(cohort.bias)
    || !nullableNonnegativeFinite(cohort.intervalCoverage)
    || (cohort.intervalCoverage !== null && cohort.intervalCoverage > 1)
    || (cohort.medianApe !== null && cohort.p75Ape !== null
      && cohort.p75Ape < cohort.medianApe)
    || !coverageHasIntegerDenominator(cohort.scoredCases, cohort.estimateCoverage)
    || !Array.isArray(cohort.reasons)
    || cohort.reasons.some((reason) => typeof reason !== 'string' || reason.length === 0)) return false;
  const hasCompleteMetrics = cohort.medianApe !== null && cohort.p75Ape !== null
    && cohort.bias !== null && cohort.intervalCoverage !== null;
  const hasAnyMetrics = cohort.medianApe !== null || cohort.p75Ape !== null
    || cohort.bias !== null || cohort.intervalCoverage !== null;
  if ((cohort.scoredCases === 0 && (cohort.estimateCoverage !== 0 || hasAnyMetrics))
    || (cohort.scoredCases > 0 && (cohort.estimateCoverage === 0 || !hasCompleteMetrics))) return false;
  const expected = decideScenarioCohort(cohort);
  return cohort.status === expected.status
    && cohort.reasons.length === expected.reasons.length
    && cohort.reasons.every((reason, index) => reason === expected.reasons[index]);
}

function validParkingFamily(value: unknown): value is ParkingFamilyAcceptance {
  if (!exactObject(value, PARKING_FAMILY_KEYS)) return false;
  const family = value as unknown as ParkingFamilyAcceptance;
  if ((family.status !== 'accepted' && family.status !== 'diagnostic-only'
      && family.status !== 'failed')
    || !Number.isSafeInteger(family.caseCount) || family.caseCount < 0
    || !Number.isSafeInteger(family.estimatedCount) || family.estimatedCount < 0
    || family.estimatedCount > family.caseCount
    || !finiteRatio(family.estimateCoverage) || family.estimateCoverage > 1
    || (family.caseCount === 0
      ? family.estimateCoverage !== 0
      : Math.abs(family.estimatedCount / family.caseCount - family.estimateCoverage)
        > Number.EPSILON * 8)
    || !nullableNonnegativeFinite(family.priceMedianApe)
    || !nullableNonnegativeFinite(family.priceP75Ape)
    || !nullableNonnegativeFinite(family.areaMedianApe)
    || !nullableNonnegativeFinite(family.areaP75Ape)
    || !nullableNonnegativeFinite(family.priceIntervalCoverage)
    || !nullableNonnegativeFinite(family.areaIntervalCoverage)
    || (family.priceIntervalCoverage !== null && family.priceIntervalCoverage > 1)
    || (family.areaIntervalCoverage !== null && family.areaIntervalCoverage > 1)
    || (family.priceMedianApe !== null && family.priceP75Ape !== null
      && family.priceP75Ape < family.priceMedianApe)
    || (family.areaMedianApe !== null && family.areaP75Ape !== null
      && family.areaP75Ape < family.areaMedianApe)
    || !Array.isArray(family.reasons)
    || family.reasons.some((reason) => typeof reason !== 'string' || reason.length === 0)) {
    return false;
  }
  const metricValues = [
    family.priceMedianApe,
    family.priceP75Ape,
    family.areaMedianApe,
    family.areaP75Ape,
    family.priceIntervalCoverage,
    family.areaIntervalCoverage,
  ];
  const metricsComplete = metricValues.every((metric) => metric !== null);
  const hasAnyMetric = metricValues.some((metric) => metric !== null);
  if ((family.estimatedCount === 0 && hasAnyMetric)
    || (family.estimatedCount > 0 && !metricsComplete)) return false;
  const expected = decideParkingFamily(family);
  return family.status === expected.status
    && family.reasons.length === expected.reasons.length
    && family.reasons.every((reason, index) => reason === expected.reasons[index]);
}

function validScenarioAcceptance(value: Record<string, unknown>): boolean {
  if (!exactObject(value.useCohorts, KNOWN_PRIMARY_USES)) return false;
  const cohorts = value.useCohorts as Record<string, unknown>;
  if (KNOWN_PRIMARY_USES.some((use) => !validScenarioCohort(cohorts[use]))) return false;
  if (!exactObject(value.parkingFamilies, PARKING_FAMILIES)) return false;
  const families = value.parkingFamilies as unknown as CandidateBacktestAcceptance['parkingFamilies'];
  if (PARKING_FAMILIES.some((family) => !validParkingFamily(families[family]))) return false;
  if (typeof value.parkingImputationAccepted !== 'boolean'
    || !exactObject(value.parkingComparison, PARKING_COMPARISON_KEYS)) return false;
  const comparison = value.parkingComparison as unknown as CandidateBacktestAcceptance['parkingComparison'];
  if (!finiteRatio(comparison.directCoverage) || comparison.directCoverage > 1
    || !finiteRatio(comparison.imputedCoverage) || comparison.imputedCoverage > 1
    || !nullableNonnegativeFinite(comparison.directMedianApe)
    || !nullableNonnegativeFinite(comparison.imputedMedianApe)
    || !nullableNonnegativeFinite(comparison.directP75Ape)
    || !nullableNonnegativeFinite(comparison.imputedP75Ape)
    || !nullableFinite(comparison.biasRegression)
    || !nullableFinite(comparison.intervalCoverageRegression)
    || (comparison.intervalCoverageRegression !== null
      && Math.abs(comparison.intervalCoverageRegression) > 1)
    || (comparison.directMedianApe !== null && comparison.directP75Ape !== null
      && comparison.directP75Ape < comparison.directMedianApe)
    || (comparison.imputedMedianApe !== null && comparison.imputedP75Ape !== null
      && comparison.imputedP75Ape < comparison.imputedMedianApe)) return false;
  const directMetricsComplete = comparison.directMedianApe !== null
    && comparison.directP75Ape !== null;
  const imputedMetricsComplete = comparison.imputedMedianApe !== null
    && comparison.imputedP75Ape !== null;
  const directHasAnyMetric = comparison.directMedianApe !== null
    || comparison.directP75Ape !== null;
  const imputedHasAnyMetric = comparison.imputedMedianApe !== null
    || comparison.imputedP75Ape !== null;
  if ((comparison.directCoverage === 0 && directHasAnyMetric)
    || (comparison.directCoverage > 0 && !directMetricsComplete)
    || (comparison.imputedCoverage === 0 && imputedHasAnyMetric)
    || (comparison.imputedCoverage > 0 && !imputedMetricsComplete)) return false;
  const regressionsComplete = comparison.biasRegression !== null
    && comparison.intervalCoverageRegression !== null;
  if ((comparison.directCoverage > 0 && comparison.imputedCoverage > 0) !== regressionsComplete) {
    return false;
  }
  return value.parkingImputationAccepted === decideParkingImputation(comparison, families)
    && value.parkingImputationAccepted
    && (cohorts.residential as ScenarioCohortAcceptance).status === 'accepted';
}

function validBacktestAcceptanceForPolicy(
  value: unknown,
  estimatorPolicyVersion: number,
  policyId: PolicyId,
): value is BacktestAcceptance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!exactObject(record, ACCEPTANCE_IDENTITY_KEYS)
    || record.schemaVersion !== 2
    || record.estimatorPolicyVersion !== estimatorPolicyVersion
    || record.policyId !== policyId
    || typeof record.transactionArtifactSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.transactionArtifactSha256)
    || typeof record.approvedAt !== 'string' || !Number.isFinite(Date.parse(record.approvedAt))
    || typeof record.asOf !== 'string' || !isValidDateString(record.asOf)
    || typeof record.evaluatedThrough !== 'string' || !isValidDateString(record.evaluatedThrough)
    || typeof record.latestEligibleTransactionDate !== 'string' || !isValidDateString(record.latestEligibleTransactionDate)
    || record.asOf !== record.evaluatedThrough
    || record.evaluatedThrough < record.latestEligibleTransactionDate
    || !approvedBacktestThresholds(record.thresholds)) return false;
  return validAcceptanceMetrics(record.metrics, record.thresholds as Record<string, unknown>);
}

export function validBacktestAcceptance(value: unknown): value is BacktestAcceptance {
  return validBacktestAcceptanceForPolicy(
    value,
    ESTIMATOR_POLICY_VERSION,
    ACTIVE_ESTIMATOR_POLICY.id,
  );
}

function validCandidateBacktestAcceptanceForPolicy(
  value: unknown,
  expectedPolicyId: PolicyId,
  estimatorPolicyVersion: number,
): value is CandidateBacktestAcceptance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const topLevelKeys = [
    ...ACCEPTANCE_IDENTITY_KEYS,
    'parkingComparison',
    'parkingFamilies',
    'parkingImputationAccepted',
    'useCohorts',
  ];
  if (!exactObject(record, topLevelKeys)
    || record.schemaVersion !== 3
    || record.estimatorPolicyVersion !== estimatorPolicyVersion
    || record.policyId !== expectedPolicyId
    || typeof record.transactionArtifactSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.transactionArtifactSha256)
    || typeof record.approvedAt !== 'string' || !Number.isFinite(Date.parse(record.approvedAt))
    || typeof record.asOf !== 'string' || !isValidDateString(record.asOf)
    || typeof record.evaluatedThrough !== 'string' || !isValidDateString(record.evaluatedThrough)
    || typeof record.latestEligibleTransactionDate !== 'string' || !isValidDateString(record.latestEligibleTransactionDate)
    || record.asOf !== record.evaluatedThrough
    || record.evaluatedThrough < record.latestEligibleTransactionDate
    || !approvedCandidateBacktestThresholds(record.thresholds)) return false;
  return validAcceptanceMetrics(record.metrics, record.thresholds as Record<string, unknown>)
    && validScenarioAcceptance(record);
}

export function validCandidateBacktestAcceptance(
  value: unknown,
  expectedPolicyId: PolicyId,
): value is CandidateBacktestAcceptance {
  return validCandidateBacktestAcceptanceForPolicy(
    value,
    expectedPolicyId,
    CANDIDATE_ESTIMATOR_POLICY_VERSION,
  );
}

export function readBacktestAcceptance(root: string): CandidateBacktestAcceptance | null {
  const value = readJson<unknown>(backtestAcceptancePath(root));
  return value && validCandidateBacktestAcceptance(value, ACTIVE_ESTIMATOR_POLICY.id) ? value : null;
}

function acceptanceLatestEligibleTransactionDate(
  index: TransactionIndex,
  acceptance: BacktestAcceptance | CandidateBacktestAcceptance,
): string | null {
  return acceptance.schemaVersion === 2
    ? latestEligibleTransactionDate(index)
    : latestScenarioInfluencingTransactionDate(index);
}

/** Atomically replaces the aggregate-only local acceptance artifact. */
export async function writeBacktestAcceptance(root: string, acceptance: BacktestAcceptance | CandidateBacktestAcceptance): Promise<void> {
  const active = await validateBuild(root, {
    minDoorplates: 0,
    minTransactions: 0,
  });
  if (acceptance.schemaVersion !== 3) {
    throw new Error(
      'Backtest acceptance policy provenance does not match the runtime policy; run update first',
    );
  }
  if (acceptance.estimatorPolicyVersion !== ESTIMATOR_POLICY_VERSION) {
    throw new Error('Backtest acceptance estimator policy does not match the runtime policy');
  }
  if (acceptance.policyId !== ACTIVE_ESTIMATOR_POLICY.id) {
    throw new Error('Backtest acceptance policy does not match the active estimator policy');
  }
  if (!approvedCandidateBacktestThresholds(acceptance.thresholds)) {
    throw new Error('Backtest acceptance must use the approved quality thresholds');
  }
  const latest = acceptanceLatestEligibleTransactionDate(active.transactions, acceptance);
  if (!latest || acceptance.latestEligibleTransactionDate !== latest
      || acceptance.evaluatedThrough < latest) {
    throw new Error('Backtest acceptance must cover the complete active transaction index');
  }
  validateAcceptanceForBundle(acceptance, active);
  const target = backtestAcceptancePath(root);
  const temporary = `${target}.tmp-${randomUUID()}`;
  await writeStableJson(temporary, acceptance);
  await fsp.rename(temporary, target);
}

export type MarketAcceptanceDecision =
  | { accepted: true; reason: null }
  | { accepted: false; reason: 'market-backtest-not-approved' };

export interface MarketAcceptanceDiagnostics {
  eligibleTransactionScans: number;
}

export function marketDataBacktestAcceptanceDecision(
  bundle: MarketDataBundle,
  diagnostics?: MarketAcceptanceDiagnostics,
): MarketAcceptanceDecision {
  const acceptance = bundle.backtestAcceptance;
  if (diagnostics) diagnostics.eligibleTransactionScans += 1;
  const latest = acceptance
    ? acceptanceLatestEligibleTransactionDate(bundle.transactions, acceptance)
    : null;
  const accepted = acceptance !== undefined
    && marketDataManifestHasCurrentPolicyProvenance(bundle.manifest)
    && validCandidateBacktestAcceptance(acceptance, ACTIVE_ESTIMATOR_POLICY.id)
    && acceptance.transactionArtifactSha256 === transactionArtifactChecksum(bundle.manifest)
    && latest !== null
    && acceptance.latestEligibleTransactionDate === latest
    && acceptance.evaluatedThrough >= latest;
  return accepted
    ? { accepted: true, reason: null }
    : { accepted: false, reason: 'market-backtest-not-approved' };
}

export function marketDataBacktestAccepted(bundle: MarketDataBundle): boolean {
  return marketDataBacktestAcceptanceDecision(bundle).accepted;
}

function attachMatchingBacktestAcceptance(root: string, bundle: MarketDataBundle): MarketDataBundle {
  const acceptance = readBacktestAcceptance(root);
  if (!acceptance) return bundle;
  const candidate = { ...bundle, backtestAcceptance: acceptance };
  return marketDataBacktestAccepted(candidate) ? candidate : bundle;
}

/** Computes source freshness from recorded successful checks, never from failed refresh attempts. */
export function marketDataFreshness(manifest: MarketDataManifest, asOf: string | Date): SourceFreshness {
  const now = typeof asOf === 'string' ? Date.parse(asOf) : asOf.getTime();
  if (!Number.isFinite(now)) throw new RangeError('Freshness time must be a valid ISO timestamp or Date');
  const stale = (checkedAt: string, windowDays: number): boolean => {
    const checked = Date.parse(checkedAt);
    return !Number.isFinite(checked) || now - checked > windowDays * 24 * 60 * 60 * 1_000;
  };
  return {
    transactionCheckedAt: manifest.transactions.checkedAt,
    doorplateCheckedAt: manifest.doorplates.checkedAt,
    transactionStale: stale(manifest.transactions.checkedAt, TRANSACTION_STALE_DAYS),
    doorplateStale: stale(manifest.doorplates.checkedAt, DOORPLATE_STALE_DAYS),
  };
}

function sortedKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.every((key, index) => index === 0 || compareStableText(keys[index - 1]!, key) <= 0);
}

function validCoordinate(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const { lat, lng } = value as { lat?: unknown; lng?: unknown };
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= TAIPEI_BOUNDS.minLat && lat <= TAIPEI_BOUNDS.maxLat &&
    lng >= TAIPEI_BOUNDS.minLng && lng <= TAIPEI_BOUNDS.maxLng;
}

function validateCells(
  cells: Record<string, unknown[]>,
  coordinate: (item: unknown) => unknown,
  orderKey: (item: unknown) => string = stableJson,
): void {
  if (!sortedKeys(cells)) throw new Error('Index cell keys must be sorted');
  for (const entries of Object.values(cells)) {
    let prior = '';
    for (const entry of entries) {
      if (!validCoordinate(coordinate(entry))) throw new Error('Index coordinate lies outside Taipei bounds');
      const current = orderKey(entry);
      if (current < prior) throw new Error('Index records must have stable sorted order');
      prior = current;
    }
  }
}

function validateIndexes(
  doorplates: DoorplateIndex,
  transactions: TransactionIndex,
  expectedSchemaVersion: number,
): void {
  if (doorplates.schemaVersion !== expectedSchemaVersion
      || transactions.schemaVersion !== expectedSchemaVersion) {
    throw new Error('Market index schema version mismatch');
  }
  if (!sortedKeys(doorplates.byCanonicalAddress) || !sortedKeys(doorplates.byRoad)) {
    throw new Error('Doorplate index keys must be sorted');
  }
  validateCells(doorplates.cells as Record<string, unknown[]>, (entry) => (entry as { coordinate?: unknown }).coordinate);
  validateCells(
    transactions.cells as Record<string, unknown[]>,
    (entry) => (entry as { location?: { coordinate?: unknown } }).location?.coordinate,
    (entry) => {
      const id = (entry as { id?: unknown }).id;
      if (typeof id !== 'string' || !id) throw new Error('Transaction index record lacks a stable ID');
      return id;
    },
  );
}

const CANDIDATE_TRANSACTION_KEYS = [
  'buildingAreaPing', 'buildingPriceNtd', 'buildingType', 'buildingUnitPriceBoundsWan',
  'buildingUnitPriceWan', 'completionDate', 'district', 'eligibility', 'eligibilityReasons',
  'exclusionFlags', 'floor', 'floorGroup', 'id', 'location', 'notes', 'originalAddress',
  'originalPrimaryUse', 'ownership', 'parkingAreaPing', 'parkingEvidence', 'parkingPriceNtd',
  'primaryUse', 'sourceVersion', 'totalAreaPing', 'totalFloors', 'totalPriceNtd',
  'transactionDate', 'transferredBuildingCount', 'transferredParkingCount',
] as const;

function nullableSafeCount(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nullablePositive(value: unknown): boolean {
  return value === null || positiveNumber(value);
}

function nullableNonnegative(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function validCandidateImputation(value: unknown): boolean {
  if (!exactObject(value, [
    'areaIqrRatio', 'areaP25Ping', 'areaP50Ping', 'areaP75Ping', 'asOf',
    'comparableCount', 'comparableIds', 'pairP25', 'pairP50', 'pairP75',
    'priceIqrRatio', 'priceP25Ntd', 'priceP50Ntd', 'priceP75Ntd', 'stage',
  ])) return false;
  const item = value as Record<string, unknown>;
  const ordered = (prefix: 'price' | 'area', suffix: 'Ntd' | 'Ping'): boolean => {
    const p25 = item[`${prefix}P25${suffix}`];
    const p50 = item[`${prefix}P50${suffix}`];
    const p75 = item[`${prefix}P75${suffix}`];
    return positiveNumber(p25) && positiveNumber(p50) && positiveNumber(p75)
      && p25 <= p50 && p50 <= p75;
  };
  const validPair = (pair: unknown): boolean => exactObject(pair, ['areaPing', 'priceNtd'])
    && positiveNumber((pair as Record<string, unknown>).priceNtd)
    && positiveNumber((pair as Record<string, unknown>).areaPing);
  return typeof item.asOf === 'string' && isValidDateString(item.asOf)
    && (item.stage === 'same-building' || item.stage === 'nearby-500m')
    && Array.isArray(item.comparableIds) && item.comparableIds.length > 0
    && item.comparableIds.every((id) => typeof id === 'string' && id.length > 0)
    && Number.isSafeInteger(item.comparableCount) && item.comparableCount === item.comparableIds.length
    && ordered('price', 'Ntd') && ordered('area', 'Ping')
    && validPair(item.pairP25) && validPair(item.pairP50) && validPair(item.pairP75)
    && typeof item.priceIqrRatio === 'number' && Number.isFinite(item.priceIqrRatio) && item.priceIqrRatio >= 0
    && typeof item.areaIqrRatio === 'number' && Number.isFinite(item.areaIqrRatio) && item.areaIqrRatio >= 0;
}

function validBuildingBounds(value: unknown): boolean {
  if (!exactObject(value, ['p25', 'p50', 'p75', 'relativeIqrRatio'])) return false;
  const bounds = value as Record<string, unknown>;
  return positiveNumber(bounds.p25) && positiveNumber(bounds.p50) && positiveNumber(bounds.p75)
    && bounds.p25 <= bounds.p50 && bounds.p50 <= bounds.p75
    && typeof bounds.relativeIqrRatio === 'number'
    && Number.isFinite(bounds.relativeIqrRatio) && bounds.relativeIqrRatio >= 0;
}

function equalPersistedNumber(actual: unknown, expected: number): boolean {
  return typeof actual === 'number' && sameDerivedNumber(actual, expected);
}

function candidateBuildingArithmeticValid(
  row: MarketTransaction,
  parkingPriceNtd: number,
  parkingAreaPing: number,
): boolean {
  const derived = deriveBuildingValues(
    row.totalPriceNtd,
    row.totalAreaPing,
    parkingPriceNtd,
    parkingAreaPing,
  );
  return positiveNumber(derived.buildingPriceNtd)
    && positiveNumber(derived.buildingAreaPing)
    && positiveNumber(derived.buildingUnitPriceWan)
    && equalPersistedNumber(row.buildingPriceNtd, derived.buildingPriceNtd)
    && equalPersistedNumber(row.buildingAreaPing, derived.buildingAreaPing)
    && equalPersistedNumber(row.buildingUnitPriceWan, derived.buildingUnitPriceWan);
}

function candidateImputationArithmeticValid(
  row: MarketTransaction,
  imputation: ParkingImputationEvidence,
  bounds: BuildingUnitPriceBoundsWan,
): boolean {
  const priceIqr = relativeIqrRatio(
    imputation.priceP25Ntd,
    imputation.priceP50Ntd,
    imputation.priceP75Ntd,
  );
  const areaIqr = relativeIqrRatio(
    imputation.areaP25Ping,
    imputation.areaP50Ping,
    imputation.areaP75Ping,
  );
  const boundsIqr = relativeIqrRatio(bounds.p25, bounds.p50, bounds.p75);
  const officialPrice = row.parkingEvidence.officialPriceNtd;
  const officialArea = row.parkingEvidence.officialAreaPing;
  const pairs = [imputation.pairP25, imputation.pairP50, imputation.pairP75];
  const officialPriceConsistent = !positiveNumber(officialPrice)
    || ([imputation.priceP25Ntd, imputation.priceP50Ntd, imputation.priceP75Ntd]
      .every((value) => sameDerivedNumber(value, officialPrice))
      && pairs.every((pair) => sameDerivedNumber(pair.priceNtd, officialPrice)));
  const officialAreaConsistent = !positiveNumber(officialArea)
    || ([imputation.areaP25Ping, imputation.areaP50Ping, imputation.areaP75Ping]
      .every((value) => sameDerivedNumber(value, officialArea))
      && pairs.every((pair) => sameDerivedNumber(pair.areaPing, officialArea)));
  return sameDerivedNumber(imputation.priceP50Ntd, imputation.pairP50.priceNtd)
    && sameDerivedNumber(imputation.areaP50Ping, imputation.pairP50.areaPing)
    && sameDerivedNumber(imputation.priceIqrRatio, priceIqr)
    && sameDerivedNumber(imputation.areaIqrRatio, areaIqr)
    && sameDerivedNumber(bounds.p50, row.buildingUnitPriceWan!)
    && sameDerivedNumber(bounds.relativeIqrRatio, boundsIqr)
    && candidateBuildingArithmeticValid(row, imputation.pairP50.priceNtd, imputation.pairP50.areaPing)
    && officialPriceConsistent
    && officialAreaConsistent;
}

function validateCandidateCausalParkingDerivations(transactions: TransactionIndex): void {
  const chronological: MarketTransaction[] = [];
  for (const rows of Object.values(transactions.cells)) chronological.push(...rows);
  chronological.sort((left, right) => compareStableText(left.transactionDate, right.transactionDate)
    || compareStableText(left.id, right.id));
  const directGradeA: MarketTransaction[] = [];

  for (let start = 0; start < chronological.length;) {
    const transactionDate = chronological[start]!.transactionDate;
    let end = start + 1;
    while (end < chronological.length && chronological[end]!.transactionDate === transactionDate) end += 1;
    for (let index = start; index < end; index += 1) {
      const row = chronological[index]!;
      if (row.parkingEvidence.grade !== 'B') continue;
      const expected = deriveAcceptedParkingImputation(row, directGradeA);
      const persisted = row.parkingEvidence.imputation === null ? null : {
        imputation: row.parkingEvidence.imputation,
        parkingPriceNtd: row.parkingPriceNtd,
        parkingAreaPing: row.parkingAreaPing,
        buildingPriceNtd: row.buildingPriceNtd,
        buildingAreaPing: row.buildingAreaPing,
        buildingUnitPriceWan: row.buildingUnitPriceWan,
        buildingUnitPriceBoundsWan: row.buildingUnitPriceBoundsWan,
      };
      if (stableJson(persisted) !== stableJson(expected)) {
        throw new Error('Candidate Grade-B derivation does not match causal policy replay');
      }
    }
    for (let index = start; index < end; index += 1) {
      const row = chronological[index]!;
      if (row.parkingEvidence.grade === 'A') directGradeA.push(row);
    }
    start = end;
  }
}

function validateCandidateTransactionRows(
  transactions: TransactionIndex,
  expected: TransactionBuildDiagnostics,
): void {
  const actual = {
    reliableEligible: 0,
    reviewOnly: 0,
    byPrimaryUse: Object.fromEntries(NORMALIZED_PRIMARY_USES.map((use) => [use, 0])) as Record<string, number>,
    byParkingGrade: Object.fromEntries(PARKING_GRADES.map((grade) => [grade, 0])) as Record<string, number>,
    gradeBByComponent: { missingBoth: 0, officialAreaOnly: 0, officialPriceOnly: 0 },
    gradeBImputed: 0,
    gradeBUnresolved: 0,
  };

  for (const rows of Object.values(transactions.cells)) for (const row of rows) {
    if (!exactObject(row, CANDIDATE_TRANSACTION_KEYS)) {
      throw new Error('Candidate transaction row does not match the schema-5 contract');
    }
    if (!nullableSafeCount(row.transferredBuildingCount)
      || !nullableSafeCount(row.transferredParkingCount)) {
      throw new Error('Candidate transaction row has an invalid transferred count');
    }
    if (!positiveNumber(row.totalPriceNtd) || !positiveNumber(row.totalAreaPing)
      || !nullablePositive(row.buildingPriceNtd) || !nullablePositive(row.buildingAreaPing)
      || !nullablePositive(row.buildingUnitPriceWan)
      || !nullableNonnegative(row.parkingPriceNtd) || !nullableNonnegative(row.parkingAreaPing)
      || !Number.isSafeInteger(row.floor) || !Number.isSafeInteger(row.totalFloors) || row.totalFloors <= 0
      || !Array.isArray(row.exclusionFlags) || !row.exclusionFlags.every((reason) => typeof reason === 'string')
      || !Array.isArray(row.eligibilityReasons) || !row.eligibilityReasons.every((reason) => typeof reason === 'string')) {
      throw new Error('Candidate transaction row contains malformed numeric or reason fields');
    }
    if (!(NORMALIZED_PRIMARY_USES as readonly string[]).includes(row.primaryUse)
      || !(PARKING_GRADES as readonly string[]).includes(row.parkingEvidence?.grade)
      || !['reliable-eligible', 'review-only'].includes(row.eligibility)) {
      throw new Error('Candidate transaction row contains an invalid category');
    }
    if (!exactObject(row.parkingEvidence, [
      'family', 'grade', 'imputation', 'officialAreaPing', 'officialPriceNtd', 'originalType', 'reasons',
    ]) || !['flat', 'mechanical', 'none', 'unknown'].includes(row.parkingEvidence.family)
      || !Array.isArray(row.parkingEvidence.reasons)
      || !row.parkingEvidence.reasons.every((reason) => typeof reason === 'string')) {
      throw new Error('Candidate transaction row contains malformed parking evidence');
    }
    const grade = row.parkingEvidence.grade;
    const family = row.parkingEvidence.family;
    const count = row.transferredParkingCount;
    const pricePositive = positiveNumber(row.parkingEvidence.officialPriceNtd);
    const areaPositive = positiveNumber(row.parkingEvidence.officialAreaPing);
    const buildingComplete = positiveNumber(row.buildingPriceNtd)
      && positiveNumber(row.buildingAreaPing) && positiveNumber(row.buildingUnitPriceWan);
    const buildingEmpty = row.buildingPriceNtd === null
      && row.buildingAreaPing === null && row.buildingUnitPriceWan === null;
    if (grade === 'A') {
      const noParking = family === 'none' && count === 0
        && row.parkingEvidence.officialPriceNtd === 0 && row.parkingEvidence.officialAreaPing === 0;
      const directParking = (family === 'flat' || family === 'mechanical')
        && typeof count === 'number' && count > 0 && pricePositive && areaPositive;
      if ((!noParking && !directParking) || !buildingComplete
        || row.parkingPriceNtd !== row.parkingEvidence.officialPriceNtd
        || row.parkingAreaPing !== row.parkingEvidence.officialAreaPing
        || row.parkingEvidence.imputation !== null || row.buildingUnitPriceBoundsWan !== null
        || !candidateBuildingArithmeticValid(
          row,
          row.parkingEvidence.officialPriceNtd!,
          row.parkingEvidence.officialAreaPing!,
        )) {
        throw new Error('Candidate grade-A transaction row violates direct-evidence invariants');
      }
    } else if (grade === 'B') {
      if ((family !== 'flat' && family !== 'mechanical')
        || typeof count !== 'number' || count <= 0 || (pricePositive && areaPositive)) {
        throw new Error('Candidate grade-B transaction row violates partial-evidence invariants');
      }
      const imputed = row.parkingEvidence.imputation !== null;
      const imputation = row.parkingEvidence.imputation;
      if (imputed !== (row.buildingUnitPriceBoundsWan !== null)
        || (imputed && (!validCandidateImputation(imputation)
          || !validBuildingBounds(row.buildingUnitPriceBoundsWan) || !buildingComplete))
        || (imputed && (row.parkingPriceNtd !== imputation!.pairP50.priceNtd
          || row.parkingAreaPing !== imputation!.pairP50.areaPing))
        || (imputed && !candidateImputationArithmeticValid(
          row,
          imputation!,
          row.buildingUnitPriceBoundsWan!,
        ))
        || (!imputed && (!buildingEmpty
          || row.parkingPriceNtd !== row.parkingEvidence.officialPriceNtd
          || row.parkingAreaPing !== row.parkingEvidence.officialAreaPing))) {
        throw new Error('Candidate grade-B transaction row has inconsistent imputation evidence');
      }
      if (!pricePositive && !areaPositive) actual.gradeBByComponent.missingBoth += 1;
      else if (areaPositive) actual.gradeBByComponent.officialAreaOnly += 1;
      else actual.gradeBByComponent.officialPriceOnly += 1;
      if (imputed) actual.gradeBImputed += 1;
      else actual.gradeBUnresolved += 1;
    } else if (!buildingEmpty || row.buildingUnitPriceBoundsWan !== null
      || row.parkingEvidence.imputation !== null
      || row.parkingPriceNtd !== null || row.parkingAreaPing !== null) {
      throw new Error('Candidate grade-C transaction row contains unsupported derived building evidence');
    }

    actual[row.eligibility === 'reliable-eligible' ? 'reliableEligible' : 'reviewOnly'] += 1;
    actual.byPrimaryUse[row.primaryUse] += 1;
    actual.byParkingGrade[grade] += 1;
  }

  validateCandidateCausalParkingDerivations(transactions);

  const expectedRetained = {
    reliableEligible: expected.reliableEligible,
    reviewOnly: expected.reviewOnly,
    byPrimaryUse: expected.byPrimaryUse,
    byParkingGrade: expected.byParkingGrade,
    gradeBByComponent: expected.gradeBByComponent,
    gradeBImputed: expected.gradeBImputed,
    gradeBUnresolved: expected.gradeBUnresolved,
  };
  if (stableJson(actual) !== stableJson(expectedRetained)) {
    throw new Error('Candidate transaction normalization diagnostics do not exactly match persisted rows');
  }
}

async function artifactFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && path.relative(root, full) !== 'manifest.json') results.push(path.relative(root, full));
    }
  }
  await visit(root);
  return results.sort();
}

async function validateArtifacts(root: string, manifest: MarketDataManifest): Promise<void> {
  if (!manifest.artifacts || typeof manifest.artifacts !== 'object') throw new Error('Manifest lacks artifact checksums');
  const files = await artifactFiles(root);
  const declared = Object.keys(manifest.artifacts).sort();
  if (files.join('\n') !== declared.join('\n')) throw new Error('Manifest artifact list does not match build files');
  for (const relative of files) {
    const expected = manifest.artifacts[relative];
    const file = path.join(root, relative);
    const bytes = (await fsp.stat(file)).size;
    if (!expected || expected.bytes !== bytes || expected.sha256 !== await sha256File(file)) {
      throw new Error(`Artifact checksum mismatch: ${relative}`);
    }
  }
}

type BuildValidationMode = 'current' | 'candidate' | 'restorable';

function validateManifestPolicy(
  manifest: MarketDataManifest,
  mode: BuildValidationMode,
): void {
  if (mode === 'current') {
    assertCurrentMarketDataIndexPolicy(manifest);
    return;
  }
  if (mode === 'candidate') {
    if (manifest.schemaVersion !== CANDIDATE_MARKET_SCHEMA_VERSION
      || manifest.estimatorPolicyVersion !== CANDIDATE_ESTIMATOR_POLICY_VERSION) {
      throw new Error('Candidate market manifest schema or policy provenance is invalid');
    }
    return;
  }
  if (![1, 2, 3, 4, MARKET_SCHEMA_VERSION].includes(manifest.schemaVersion)) {
    throw new Error('Market manifest schema version is not restorable');
  }
  const hasPolicyVersion = Object.prototype.hasOwnProperty.call(
    manifest,
    'estimatorPolicyVersion',
  );
  if ((manifest.schemaVersion === 1 || manifest.schemaVersion === 2) && hasPolicyVersion) {
    throw new Error('Legacy market manifest policy provenance does not match its schema');
  }
  if (manifest.schemaVersion === MARKET_SCHEMA_VERSION) {
    const currentOrImmediatePredecessor = manifest.estimatorPolicyVersion === ESTIMATOR_POLICY_VERSION
      || (mode === 'restorable' && manifest.estimatorPolicyVersion === 7);
    if (!currentOrImmediatePredecessor) {
      throw new Error('Legacy market manifest policy provenance does not match its schema');
    }
    return;
  }
  const expectedPolicy = manifest.schemaVersion === 3 ? 4
    : manifest.schemaVersion === 4 ? 5 : null;
  if (expectedPolicy !== null && manifest.estimatorPolicyVersion !== expectedPolicy) {
    throw new Error('Legacy market manifest policy provenance does not match its schema');
  }
}

function validateManifestTransactionDiagnostics(
  manifest: MarketDataManifest,
  mode: BuildValidationMode,
): void {
  const transactions = manifest.transactions as unknown as Record<string, unknown>;
  const hasNormalization = Object.prototype.hasOwnProperty.call(transactions, 'normalization');
  if (mode === 'candidate' || mode === 'current') {
    validateTransactionBuildDiagnostics(
      transactions.normalization as TransactionBuildDiagnostics,
      manifest.transactions.recordCount,
    );
    return;
  }
  if (mode === 'restorable' && manifest.schemaVersion === MARKET_SCHEMA_VERSION) {
    validateTransactionBuildDiagnostics(
      transactions.normalization as TransactionBuildDiagnostics,
      manifest.transactions.recordCount,
    );
    return;
  }
  if (mode === 'restorable' && manifest.schemaVersion === 1) {
    if (hasNormalization) {
      throw new Error('Legacy transaction normalization diagnostics do not match their schema');
    }
    return;
  }
  // Schema 2 was published both before and after the legacy five-field
  // normalization summary was introduced.
  if (mode === 'restorable' && manifest.schemaVersion === 2 && !hasNormalization) {
    return;
  }
  if (mode === 'restorable'
        && (manifest.schemaVersion === 2 || manifest.schemaVersion === 3)) {
    validateLegacyTransactionBuildDiagnostics(
      transactions.normalization,
      manifest.transactions.recordCount,
    );
    return;
  }
  if (mode === 'restorable' && manifest.schemaVersion === 4) {
    validateTransactionBuildDiagnostics(
      transactions.normalization as TransactionBuildDiagnostics,
      manifest.transactions.recordCount,
      false,
    );
    return;
  }
  throw new Error('Market manifest transaction diagnostics do not match their schema');
}

async function validateBuild(
  root: string,
  options: PublishOptions,
  mode: BuildValidationMode = 'current',
): Promise<MarketDataBundle> {
  const manifest = readManifest(root);
  const doorplates = readJson<DoorplateIndex>(path.join(root, 'doorplates-index.json'));
  const transactions = readJson<TransactionIndex>(path.join(root, 'transactions-index.json'));
  if (!manifest || !doorplates || !transactions) throw new Error('Market build is missing manifest or indexes');
  if (!manifest.buildId || !manifest.builtAt) {
    throw new Error('Market manifest schema version mismatch');
  }
  validateManifestPolicy(manifest, mode);
  const minDoorplates = options.minDoorplates ?? MIN_PRODUCTION_DOORPLATES;
  const minTransactions = options.minTransactions ?? MIN_PRODUCTION_TRANSACTIONS;
  if (!Number.isInteger(manifest.doorplates.recordCount) || manifest.doorplates.recordCount < minDoorplates) {
    throw new Error(`Doorplate count below required threshold (${minDoorplates})`);
  }
  if (!Number.isInteger(manifest.transactions.recordCount) || manifest.transactions.recordCount < minTransactions) {
    throw new Error(`Transaction count below required threshold (${minTransactions})`);
  }
  validateManifestTransactionDiagnostics(manifest, mode);
  validateIndexes(doorplates, transactions, manifest.schemaVersion);
  const doorplateCount = countIndexEntries(doorplates.cells);
  const transactionCount = countIndexEntries(transactions.cells);
  if (manifest.doorplates.recordCount !== doorplateCount || manifest.transactions.recordCount !== transactionCount) {
    throw new Error('Manifest record counts do not match validated indexes');
  }
  if (mode === 'candidate' || mode === 'current'
    || (mode === 'restorable' && manifest.schemaVersion === MARKET_SCHEMA_VERSION)) {
    validateCandidateTransactionRows(transactions, manifest.transactions.normalization);
  }
  await validateArtifacts(root, manifest);
  return { manifest, doorplates, transactions };
}

/** Validates an isolated build without attaching or mutating active acceptance state. */
export async function validateStagedBuild(
  stageRoot: string,
  options: PublishOptions = {},
): Promise<MarketDataBundle> {
  return validateBuild(stageRoot, options);
}

/** Validates an isolated schema-5 / policy-8 candidate build only. */
export async function validateCandidateStagedBuild(
  stageRoot: string,
  options: PublishOptions = {},
): Promise<MarketDataBundle> {
  return validateBuild(stageRoot, options, 'candidate');
}

/** Loads only a fully validated active build; malformed partial data is never exposed. */
export async function loadMarketData(root: string, options: PublishOptions = {}): Promise<MarketDataBundle | null> {
  const retries = options.readerRetries ?? 4;
  const retryDelayMs = options.readerRetryDelayMs ?? 10;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return attachMatchingBacktestAcceptance(root, await validateBuild(root, options));
    } catch {
      if (attempt === retries) return null;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return null;
}

/** Replaces the complete active directory only after independently validating a sibling staging build. */
export async function publishStagedBuild(activeRoot: string, stageRoot: string, options: PublishOptions = {}): Promise<MarketDataBundle> {
  const parent = path.dirname(activeRoot);
  const expectedPrefix = `.${path.basename(activeRoot)}-staging-`;
  if (path.dirname(stageRoot) !== parent || !path.basename(stageRoot).startsWith(expectedPrefix)) {
    throw new Error('Staging directory must be a sibling with the expected market-data prefix');
  }
  const bundle = await validateBuild(stageRoot, options);
  const backup = path.join(parent, `.${path.basename(activeRoot)}-backup-${bundle.manifest.buildId.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
  if (fs.existsSync(backup)) throw new Error(`Refusing to overwrite existing market-data backup: ${backup}`);
  let movedActive = false;
  try {
    if (fs.existsSync(activeRoot)) {
      await fsp.rename(activeRoot, backup);
      movedActive = true;
    }
    await fsp.rename(stageRoot, activeRoot);
  } catch (error) {
    if (movedActive && !fs.existsSync(activeRoot) && fs.existsSync(backup)) await fsp.rename(backup, activeRoot);
    throw error;
  }
  if (movedActive) {
    // Publication is committed once stage becomes active. A cleanup failure may
    // leave a recoverable backup, but must not make the new active build look failed.
    try { await fsp.rm(backup, { recursive: true, force: false }); } catch { /* recoverable backup retained */ }
  }
  return attachMatchingBacktestAcceptance(activeRoot, bundle);
}

function stagingPathError(activeRoot: string, stageRoot: string): Error | null {
  const parent = path.dirname(activeRoot);
  const expectedPrefix = `.${path.basename(activeRoot)}-staging-`;
  return path.dirname(stageRoot) !== parent || !path.basename(stageRoot).startsWith(expectedPrefix)
    ? new Error('Staging directory must be a sibling with the expected market-data prefix')
    : null;
}

type PublicationPhase = 'prepared';

interface PublicationJournal {
  schemaVersion: 1;
  phase: PublicationPhase;
  publicationId: string;
  activeBasename: string;
  stageBasename: string;
  stagedBuildId: string;
  oldBuildId: string | null;
  oldAcceptancePresent: boolean;
  candidateAcceptanceSha256: string;
  oldAcceptanceSha256: string | null;
}

interface PublicationPaths {
  parent: string;
  activeRoot: string;
  stageRoot: string;
  backupRoot: string;
  acceptanceTarget: string;
  acceptanceCandidate: string;
  acceptanceBackup: string;
  journal: string;
}

function publicationJournalPath(activeRoot: string): string {
  return path.join(
    path.dirname(activeRoot),
    `.${path.basename(activeRoot)}-publication-journal.json`,
  );
}

function publicationPaths(activeRoot: string, journal: PublicationJournal): PublicationPaths {
  const parent = path.dirname(activeRoot);
  const basename = path.basename(activeRoot);
  const acceptanceTarget = backtestAcceptancePath(activeRoot);
  return {
    parent,
    activeRoot,
    stageRoot: path.join(parent, journal.stageBasename),
    backupRoot: path.join(parent, `.${basename}-backup-${journal.publicationId}`),
    acceptanceTarget,
    acceptanceCandidate: `${acceptanceTarget}.candidate-${journal.publicationId}`,
    acceptanceBackup: `${acceptanceTarget}.backup-${journal.publicationId}`,
    journal: publicationJournalPath(activeRoot),
  };
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableUnique(file: string, data: Uint8Array): Promise<void> {
  const handle = await fsp.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

async function writeDurableJournal(file: string, journal: PublicationJournal): Promise<void> {
  const temporary = `${file}.tmp-${journal.publicationId}`;
  try {
    await writeDurableUnique(temporary, Buffer.from(`${stableJson(journal)}\n`));
    await fsp.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    try { await fsp.rm(temporary, { force: true }); } catch { /* best-effort pre-publication cleanup */ }
    throw error;
  }
}

function validPublicationJournal(value: unknown, activeRoot: string): value is PublicationJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const journal = value as Partial<PublicationJournal> & Record<string, unknown>;
  const allowedKeys = [
    'schemaVersion',
    'phase',
    'publicationId',
    'activeBasename',
    'stageBasename',
    'stagedBuildId',
    'oldBuildId',
    'oldAcceptancePresent',
    'candidateAcceptanceSha256',
    'oldAcceptanceSha256',
  ];
  const keys = Object.keys(journal);
  if (keys.length !== allowedKeys.length || keys.some((key) => !allowedKeys.includes(key))) return false;
  const basename = path.basename(activeRoot);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const buildId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
  const checksum = /^[0-9a-f]{64}$/;
  const stagePrefix = `.${basename}-staging-`;
  const safeStage = typeof journal.stageBasename === 'string'
    && path.basename(journal.stageBasename) === journal.stageBasename
    && journal.stageBasename.startsWith(stagePrefix)
    && /^[a-zA-Z0-9._-]+$/.test(journal.stageBasename);
  return journal.schemaVersion === 1
    && journal.phase === 'prepared'
    && typeof journal.publicationId === 'string'
    && uuid.test(journal.publicationId)
    && journal.activeBasename === basename
    && path.basename(journal.activeBasename) === journal.activeBasename
    && safeStage
    && typeof journal.stagedBuildId === 'string'
    && buildId.test(journal.stagedBuildId)
    && (journal.oldBuildId === null
      || (typeof journal.oldBuildId === 'string' && buildId.test(journal.oldBuildId)))
    && typeof journal.oldAcceptancePresent === 'boolean'
    && typeof journal.candidateAcceptanceSha256 === 'string'
    && checksum.test(journal.candidateAcceptanceSha256)
    && (journal.oldAcceptancePresent
      ? typeof journal.oldAcceptanceSha256 === 'string' && checksum.test(journal.oldAcceptanceSha256)
      : journal.oldAcceptanceSha256 === null);
}

async function readPublicationJournal(activeRoot: string): Promise<PublicationJournal | null> {
  const file = publicationJournalPath(activeRoot);
  let bytes: Buffer;
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Market-data publication journal must be a regular sibling file');
    }
    bytes = await fsp.readFile(file);
  } catch (error) {
    if (isMissingFile(error)) return null;
    if (error instanceof Error && /publication journal/i.test(error.message)) throw error;
    throw new Error(
      `Invalid market-data publication journal: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Invalid market-data publication journal JSON');
  }
  if (!validPublicationJournal(parsed, activeRoot)) {
    throw new Error('Invalid market-data publication journal fields');
  }
  return parsed;
}

/**
 * Candidate evaluation is deliberately non-authoritative: it must never recover
 * or otherwise mutate a pending production publication. The normal update path
 * owns recovery under the same refresh lock.
 */
export async function assertNoPendingMarketDataPublication(activeRoot: string): Promise<void> {
  const file = publicationJournalPath(activeRoot);
  try {
    await fsp.lstat(file);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  throw new Error(
    'Pending production publication journal detected; run market-data update to recover before candidate evaluation',
  );
}

function validateAcceptanceForBundle(
  acceptance: BacktestAcceptance | CandidateBacktestAcceptance,
  bundle: MarketDataBundle,
  mode: 'current' | 'restorable' = 'current',
): void {
  const manifest = bundle.manifest;
  const current = manifest.schemaVersion === MARKET_SCHEMA_VERSION
    && manifest.estimatorPolicyVersion === ESTIMATOR_POLICY_VERSION;
  const legacySchema3 = mode === 'restorable'
    && manifest.schemaVersion === 3 && manifest.estimatorPolicyVersion === 4;
  const legacySchema4 = mode === 'restorable'
    && manifest.schemaVersion === 4 && manifest.estimatorPolicyVersion === 5;
  const immediatePredecessor = mode === 'restorable'
    && manifest.schemaVersion === MARKET_SCHEMA_VERSION && manifest.estimatorPolicyVersion === 7;
  if (!current && !legacySchema3 && !legacySchema4 && !immediatePredecessor) {
    throw new Error('Backtest acceptance does not match a restorable build policy');
  }
  if (acceptance.transactionArtifactSha256 !== transactionArtifactChecksum(bundle.manifest)) {
    throw new Error('Backtest acceptance transaction artifact checksum does not match the staged build');
  }
  const validShape = current
    ? validCandidateBacktestAcceptanceForPolicy(
      acceptance,
      ACTIVE_ESTIMATOR_POLICY.id,
      ESTIMATOR_POLICY_VERSION,
    )
    : legacySchema3
      ? validBacktestAcceptanceForPolicy(acceptance, 4, ACTIVE_ESTIMATOR_POLICY.id)
      : legacySchema4
        ? validCandidateBacktestAcceptanceForPolicy(acceptance, ACTIVE_ESTIMATOR_POLICY.id, 5)
        : validCandidateBacktestAcceptanceForPolicy(acceptance, ACTIVE_ESTIMATOR_POLICY.id, 7);
  if (!validShape) {
    throw new Error('Refusing to publish a non-passing backtest acceptance');
  }
  const latest = acceptanceLatestEligibleTransactionDate(bundle.transactions, acceptance);
  if (!latest || acceptance.latestEligibleTransactionDate !== latest
      || acceptance.evaluatedThrough < latest) {
    throw new Error('Backtest acceptance must cover the complete staged transaction index');
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readOptionalFile(ops: PublicationFileOps, file: string): Promise<Buffer | null> {
  try {
    return await ops.readFile(file);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function acceptanceFromBytes(bytes: Buffer): BacktestAcceptance | CandidateBacktestAcceptance | null {
  try {
    return JSON.parse(bytes.toString('utf8')) as BacktestAcceptance | CandidateBacktestAcceptance;
  } catch {
    return null;
  }
}

async function validatedAcceptanceFile(
  ops: PublicationFileOps,
  file: string,
  bundle: MarketDataBundle,
  expectedSha256: string | null,
  mode: 'current' | 'restorable' = 'current',
): Promise<{ acceptance: BacktestAcceptance | CandidateBacktestAcceptance; bytes: Buffer } | null> {
  const bytes = await readOptionalFile(ops, file);
  if (!bytes || (expectedSha256 !== null && sha256Bytes(bytes) !== expectedSha256)) return null;
  const acceptance = acceptanceFromBytes(bytes);
  if (!acceptance) return null;
  try {
    validateAcceptanceForBundle(acceptance, bundle, mode);
  } catch {
    return null;
  }
  return { acceptance, bytes };
}

async function tryValidatedBuild(
  root: string,
  expectedBuildId: string,
  options: PublishOptions,
  mode: BuildValidationMode = 'current',
): Promise<MarketDataBundle | null> {
  try {
    const bundle = await validateBuild(root, options, mode);
    return bundle.manifest.buildId === expectedBuildId ? bundle : null;
  } catch {
    return null;
  }
}

async function renameAndSync(
  ops: PublicationFileOps,
  from: string,
  to: string,
  parent: string,
): Promise<void> {
  await ops.rename(from, to);
  await syncDirectory(parent);
}

async function cleanupPublication(paths: PublicationPaths, ops: PublicationFileOps): Promise<void> {
  const targets: Array<[string, { recursive?: boolean; force?: boolean }]> = [
    [paths.stageRoot, { recursive: true, force: true }],
    [paths.backupRoot, { recursive: true, force: false }],
    [paths.acceptanceCandidate, { force: true }],
    [paths.acceptanceBackup, { force: true }],
  ];
  for (const [target, options] of targets) {
    try { await ops.rm(target, options); } catch { /* committed pair remains authoritative */ }
  }
  try { await ops.rm(paths.journal, { force: true }); } catch { /* next locked entry retries recovery */ }
  try { await syncDirectory(paths.parent); } catch { /* pair was already validated */ }
}

async function loadCommittedNewPair(
  paths: PublicationPaths,
  journal: PublicationJournal,
  options: PublishOptions,
  ops: PublicationFileOps,
): Promise<MarketDataBundle | null> {
  let active = await tryValidatedBuild(paths.activeRoot, journal.stagedBuildId, options);
  if (!active && journal.oldBuildId === null) {
    const staged = await tryValidatedBuild(paths.stageRoot, journal.stagedBuildId, options);
    const candidate = staged && await validatedAcceptanceFile(
      ops,
      paths.acceptanceCandidate,
      staged,
      journal.candidateAcceptanceSha256,
    );
    if (staged && candidate) {
      await renameAndSync(ops, paths.stageRoot, paths.activeRoot, paths.parent);
      active = await tryValidatedBuild(paths.activeRoot, journal.stagedBuildId, options);
    }
  }
  if (!active) return null;

  let activeAcceptance = await validatedAcceptanceFile(
    ops,
    paths.acceptanceTarget,
    active,
    journal.candidateAcceptanceSha256,
  );
  if (!activeAcceptance) {
    const candidate = await validatedAcceptanceFile(
      ops,
      paths.acceptanceCandidate,
      active,
      journal.candidateAcceptanceSha256,
    );
    if (!candidate) return null;
    await renameAndSync(ops, paths.acceptanceCandidate, paths.acceptanceTarget, paths.parent);
    activeAcceptance = await validatedAcceptanceFile(
      ops,
      paths.acceptanceTarget,
      active,
      journal.candidateAcceptanceSha256,
    );
  }
  if (!activeAcceptance) return null;
  const loaded = await loadMarketData(paths.activeRoot, options);
  return loaded
    && loaded.manifest.buildId === journal.stagedBuildId
    && loaded.backtestAcceptance
    && marketDataBacktestAccepted(loaded)
    ? loaded
    : null;
}

async function restoreOldPair(
  paths: PublicationPaths,
  journal: PublicationJournal,
  options: PublishOptions,
  ops: PublicationFileOps,
): Promise<MarketDataBundle | null> {
  if (journal.oldBuildId === null) {
    const active = await tryValidatedBuild(paths.activeRoot, journal.stagedBuildId, options);
    if (active) await ops.rm(paths.activeRoot, { recursive: true, force: true });
    await ops.rm(paths.acceptanceTarget, { force: true });
    await syncDirectory(paths.parent);
    return null;
  }

  let old = await tryValidatedBuild(
    paths.activeRoot,
    journal.oldBuildId,
    options,
    'restorable',
  );
  if (!old) {
    const backup = await tryValidatedBuild(
      paths.backupRoot,
      journal.oldBuildId,
      options,
      'restorable',
    );
    if (!backup) throw new Error('Publication journal has no validated old build to restore');
    if (fs.existsSync(paths.activeRoot)) {
      const activeManifest = readManifest(paths.activeRoot);
      if (activeManifest?.buildId !== journal.stagedBuildId) {
        throw new Error('Publication journal refuses to replace an unrelated active build');
      }
      await ops.rm(paths.activeRoot, { recursive: true, force: true });
      await syncDirectory(paths.parent);
    }
    await renameAndSync(ops, paths.backupRoot, paths.activeRoot, paths.parent);
    old = await tryValidatedBuild(
      paths.activeRoot,
      journal.oldBuildId,
      options,
      'restorable',
    );
    if (!old) throw new Error('Restored old market-data build failed validation');
  }

  if (journal.oldAcceptancePresent) {
    let restored = await validatedAcceptanceFile(
      ops,
      paths.acceptanceTarget,
      old,
      journal.oldAcceptanceSha256,
      'restorable',
    );
    if (!restored) {
      const backup = await validatedAcceptanceFile(
        ops,
        paths.acceptanceBackup,
        old,
        journal.oldAcceptanceSha256,
        'restorable',
      );
      if (!backup) throw new Error('Publication journal has no validated old acceptance to restore');
      await renameAndSync(ops, paths.acceptanceBackup, paths.acceptanceTarget, paths.parent);
      restored = await validatedAcceptanceFile(
        ops,
        paths.acceptanceTarget,
        old,
        journal.oldAcceptanceSha256,
        'restorable',
      );
    }
    if (!restored) throw new Error('Restored old market-data acceptance failed validation');
  } else {
    await ops.rm(paths.acceptanceTarget, { force: true });
    await syncDirectory(paths.parent);
  }

  if (!marketDataManifestHasCurrentPolicyProvenance(old.manifest)) return null;
  const loaded = await loadMarketData(paths.activeRoot, options);
  if (!loaded || loaded.manifest.buildId !== journal.oldBuildId
      || (journal.oldAcceptancePresent
        && (!loaded.backtestAcceptance || !marketDataBacktestAccepted(loaded)))) {
    throw new Error('Restored old market-data pair failed validation');
  }
  return loaded;
}

async function recoverPublication(
  activeRoot: string,
  journal: PublicationJournal,
  options: PublishOptions,
  ops: PublicationFileOps,
  preference: 'restart' | 'old',
): Promise<MarketDataBundle | null> {
  const paths = publicationPaths(activeRoot, journal);
  if (preference === 'restart') {
    const committed = await loadCommittedNewPair(paths, journal, options, ops);
    if (committed) {
      await cleanupPublication(paths, ops);
      return committed;
    }
  }
  const restored = await restoreOldPair(paths, journal, options, ops);
  await cleanupPublication(paths, ops);
  return restored;
}

/**
 * Completes or rolls back an interrupted accepted-build publication. Callers
 * must hold the market-data refresh lock for the active root.
 */
export async function recoverInterruptedMarketDataPublication(
  activeRoot: string,
  options: PublishOptions = {},
): Promise<MarketDataBundle | null> {
  const journal = await readPublicationJournal(activeRoot);
  if (!journal) return null;
  return recoverPublication(activeRoot, journal, options, publicationFileOps, 'restart');
}

async function publishAcceptedBuild(
  activeRoot: string,
  stageRoot: string,
  acceptance: BacktestAcceptance | CandidateBacktestAcceptance,
  options: PublishOptions,
  ops: PublicationFileOps,
): Promise<MarketDataBundle> {
  const invalidStage = stagingPathError(activeRoot, stageRoot);
  if (invalidStage) throw invalidStage;
  const interrupted = await readPublicationJournal(activeRoot);
  if (interrupted) await recoverPublication(activeRoot, interrupted, options, ops, 'restart');
  const staged = await validateBuild(stageRoot, options);
  validateAcceptanceForBundle(acceptance, staged);

  const parent = path.dirname(activeRoot);
  const basename = path.basename(activeRoot);
  const publicationId = randomUUID();
  const acceptanceTarget = backtestAcceptancePath(activeRoot);
  let oldBuild: MarketDataBundle | null = null;
  if (fs.existsSync(activeRoot)) {
    oldBuild = await validateBuild(activeRoot, options, 'restorable');
  }
  const oldAcceptanceBytes = await readOptionalFile(ops, acceptanceTarget);
  const matchingOldAcceptance = oldBuild && oldAcceptanceBytes
    ? await validatedAcceptanceFile(ops, acceptanceTarget, oldBuild, null, 'restorable')
    : null;
  const candidateBytes = Buffer.from(`${stableJson(acceptance)}\n`);
  const journal: PublicationJournal = {
    schemaVersion: 1,
    phase: 'prepared',
    publicationId,
    activeBasename: basename,
    stageBasename: path.basename(stageRoot),
    stagedBuildId: staged.manifest.buildId,
    oldBuildId: oldBuild?.manifest.buildId ?? null,
    oldAcceptancePresent: matchingOldAcceptance !== null,
    candidateAcceptanceSha256: sha256Bytes(candidateBytes),
    oldAcceptanceSha256: matchingOldAcceptance ? sha256Bytes(matchingOldAcceptance.bytes) : null,
  };
  const paths = publicationPaths(activeRoot, journal);
  for (const target of [
    paths.journal,
    paths.backupRoot,
    paths.acceptanceCandidate,
    paths.acceptanceBackup,
  ]) {
    if (fs.existsSync(target)) throw new Error(`Refusing to overwrite market-data publication recovery path: ${target}`);
  }
  let journalPrepared = false;
  let published!: MarketDataBundle;

  try {
    await writeDurableUnique(paths.acceptanceCandidate, candidateBytes);
    if (matchingOldAcceptance) {
      await writeDurableUnique(paths.acceptanceBackup, matchingOldAcceptance.bytes);
    }
    await writeDurableJournal(paths.journal, journal);
    journalPrepared = true;
    try {
      await renameAndSync(ops, activeRoot, paths.backupRoot, parent);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await renameAndSync(ops, stageRoot, activeRoot, parent);
    await renameAndSync(ops, paths.acceptanceCandidate, acceptanceTarget, parent);

    const loaded = await loadMarketData(activeRoot, options);
    if (!loaded
        || loaded.manifest.buildId !== staged.manifest.buildId
        || !loaded.backtestAcceptance
        || !marketDataBacktestAccepted(loaded)) {
      throw new Error('Published market-data build and acceptance pair failed validation');
    }
    published = loaded;
  } catch (publicationError) {
    try {
      if (journalPrepared) {
        await recoverPublication(activeRoot, journal, options, ops, 'old');
      } else {
        await cleanupPublication(paths, ops);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [publicationError, rollbackError],
        `Market-data publication failed and rollback failed: ${
          publicationError instanceof Error ? publicationError.message : String(publicationError)
        }`,
      );
    }
    throw publicationError;
  }

  // Pair validation is the commit point. Cleanup failure leaves the validated
  // new pair authoritative and is retried from the durable journal if needed.
  await cleanupPublication(paths, ops);
  return published;
}

/**
 * Publishes a staged build and its checksum-/policy-bound acceptance as one
 * recoverable final-state transition.
 */
export async function publishStagedBuildWithAcceptance(
  root: string,
  stage: string,
  acceptance: BacktestAcceptance | CandidateBacktestAcceptance,
  options: PublishOptions = {},
): Promise<MarketDataBundle> {
  return publishAcceptedBuild(root, stage, acceptance, options, {
    ...publicationFileOps,
    ...options.publicationFileOps,
  });
}
