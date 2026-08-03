import { askingPremiumPercent } from '../finance.ts';
import { neighborGridKeys } from './grid.ts';
import {
  ACTIVE_ESTIMATOR_POLICY,
  HIGH_CONFIDENCE_MIN_COMPARABLES,
  HIGH_IQR_RATIO,
  MEDIUM_IQR_RATIO,
} from './config.ts';
import type { EstimatorPolicy } from './config.ts';
import { selectComparables } from './selector.ts';
import { weightedMadOutliers, weightedQuantile } from './statistics.ts';
import type {
  ComparableEvidence,
  MarketEstimate,
  MarketSubject,
  SourceFreshness,
  TransactionIndex,
} from './types.ts';

type PricedComparable = ComparableEvidence & {
  transaction: ComparableEvidence['transaction'] & { buildingUnitPriceWan: number };
};

function finitePositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function hasBuildingUnitPrice(candidate: ComparableEvidence): candidate is PricedComparable {
  return finitePositive(candidate.transaction.buildingUnitPriceWan);
}

export interface EstimateMarketOptions {
  /** Backtests intentionally hide the held-out actual price, so premiums are unavailable. */
  allowMissingAskingUnitPrice?: boolean;
  policy?: EstimatorPolicy;
}

export interface WeightedBuildingPriceEstimate {
  comparables: ComparableEvidence[];
  excludedCandidates: ComparableEvidence[];
  marketUnitPriceP25: number | null;
  marketUnitPriceMedian: number | null;
  marketUnitPriceP75: number | null;
}

/** Applies the shared positive-weight and weighted-MAD rules to selected building evidence. */
export function estimateWeightedBuildingPrices(
  candidates: readonly ComparableEvidence[],
  filterOutliers = true,
): WeightedBuildingPriceEstimate {
  const invalidUnitPrice = candidates.filter((candidate) => !hasBuildingUnitPrice(candidate));
  const priced = candidates.filter(hasBuildingUnitPrice);
  const unsupportedWeight = priced.filter((candidate) =>
    !Number.isFinite(candidate.weight.total) || candidate.weight.total <= 0,
  );
  const weightSupported = priced.filter((candidate) =>
    Number.isFinite(candidate.weight.total) && candidate.weight.total > 0,
  );
  const outlierIds = filterOutliers
    ? new Set(weightedMadOutliers(weightSupported.map((candidate) => ({
      id: candidate.transaction.id,
      value: candidate.transaction.buildingUnitPriceWan,
      weight: candidate.weight.total,
    }))).map((observation) => observation.id))
    : new Set<string>();
  const comparables = weightSupported.filter((candidate) => !outlierIds.has(candidate.transaction.id));
  const excludedCandidates = [
    ...invalidUnitPrice.map(excludedInvalidBuildingUnitPrice),
    ...unsupportedWeight.map(excludedUnsupportedWeight),
    ...weightSupported.filter((candidate) => outlierIds.has(candidate.transaction.id)).map(excludedOutlier),
  ];
  if (comparables.length === 0) {
    return {
      comparables,
      excludedCandidates,
      marketUnitPriceP25: null,
      marketUnitPriceMedian: null,
      marketUnitPriceP75: null,
    };
  }

  const observations = comparables.map((candidate) => ({
    id: candidate.transaction.id,
    value: candidate.transaction.buildingUnitPriceWan!,
    weight: candidate.weight.total,
  }));
  return {
    comparables,
    excludedCandidates,
    marketUnitPriceP25: weightedQuantile(observations, 0.25),
    marketUnitPriceMedian: weightedQuantile(observations, 0.5),
    marketUnitPriceP75: weightedQuantile(observations, 0.75),
  };
}

function subjectHardReasons(subject: MarketSubject, options: EstimateMarketOptions): string[] {
  const reasons: string[] = [];
  if (!Number.isFinite(subject.coordinate.lat) || !Number.isFinite(subject.coordinate.lng)) reasons.push('location-unreliable');
  if (!subject.district) reasons.push('missing-district');
  if (subject.ownership === 'unknown') reasons.push('ownership-unknown');
  if (!finitePositive(subject.buildingAreaPing)) reasons.push('invalid-building-area');
  if (subject.askingUnitPriceWan === null
    ? !options.allowMissingAskingUnitPrice
    : !finitePositive(subject.askingUnitPriceWan)) reasons.push('invalid-asking-unit-price');
  if (!subject.parkingSeparable) reasons.push('parking-not-separable');
  if (subject.buildingType !== 'apartment' && subject.ageYears === null) reasons.push('missing-subject-building-age');
  return reasons;
}

function nearbyTransactions(subject: MarketSubject, index: TransactionIndex, radiusM: number) {
  const byId = new Map<string, TransactionIndex['cells'][string][number]>();
  for (const key of neighborGridKeys(subject.coordinate, radiusM)) {
    for (const transaction of index.cells[key] ?? []) byId.set(transaction.id, transaction);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function excludedOutlier(candidate: ComparableEvidence): ComparableEvidence {
  return { ...candidate, included: false, reasons: [...candidate.reasons, 'weighted-mad-outlier'] };
}

function excludedUnsupportedWeight(candidate: ComparableEvidence): ComparableEvidence {
  return {
    ...candidate,
    included: false,
    reasons: [...candidate.reasons, 'distance-max-outside-supported-weight'],
  };
}

function excludedInvalidBuildingUnitPrice(candidate: ComparableEvidence): ComparableEvidence {
  return {
    ...candidate,
    included: false,
    reasons: [...candidate.reasons, 'invalid-building-unit-price'],
  };
}

/** Produces a reproducible, evidence-carrying price estimate from local official transactions. */
export function estimateMarket(
  subject: MarketSubject,
  index: TransactionIndex,
  freshness: SourceFreshness,
  asOf: string,
  options: EstimateMarketOptions = {},
): MarketEstimate {
  const policy = options.policy ?? ACTIVE_ESTIMATOR_POLICY;
  const hardReasons = subjectHardReasons(subject, options);
  if (hardReasons.includes('location-unreliable')) {
    return {
      status: 'unavailable',
      confidence: 'low',
      subjectOwnershipEvidence: subject.ownershipEvidence ?? 'unspecified',
      subjectLocationEvidence: null,
      marketUnitPriceMedian: null,
      marketUnitPriceP25: null,
      marketUnitPriceP75: null,
      askingPremiumMedian: null,
      askingPremiumConservative: null,
      selectedStage: null,
      sourceFreshness: freshness,
      unavailableReasons: hardReasons,
      comparables: [],
      excludedCandidates: [],
    };
  }
  const maximumRadiusM = Math.max(...policy.stages.map((stage) => stage.radiusM));
  const selection = selectComparables(subject, nearbyTransactions(subject, index, maximumRadiusM), asOf, policy);
  const weighted = estimateWeightedBuildingPrices(selection.included, hardReasons.length === 0);
  const comparables = weighted.comparables;
  const excludedCandidates = [
    ...selection.excluded,
    ...weighted.excludedCandidates,
  ];
  const unavailableReasons = [...hardReasons];
  if (comparables.length === 0 && selection.reviewOnly.length > 0 && hardReasons.length === 0) {
    return {
      status: 'review',
      confidence: 'low',
      subjectOwnershipEvidence: subject.ownershipEvidence ?? 'unspecified',
      subjectLocationEvidence: null,
      marketUnitPriceMedian: null,
      marketUnitPriceP25: null,
      marketUnitPriceP75: null,
      askingPremiumMedian: null,
      askingPremiumConservative: null,
      selectedStage: selection.selectedStage,
      sourceFreshness: freshness,
      unavailableReasons: ['review-only-comparables'],
      comparables,
      excludedCandidates,
    };
  }
  if (comparables.length === 0) unavailableReasons.push('no-comparables');

  if (hardReasons.length > 0 || comparables.length === 0) {
    return {
      status: 'unavailable',
      confidence: 'low',
      subjectOwnershipEvidence: subject.ownershipEvidence ?? 'unspecified',
      subjectLocationEvidence: null,
      marketUnitPriceMedian: null,
      marketUnitPriceP25: null,
      marketUnitPriceP75: null,
      askingPremiumMedian: null,
      askingPremiumConservative: null,
      selectedStage: selection.selectedStage,
      sourceFreshness: freshness,
      unavailableReasons,
      comparables,
      excludedCandidates,
    };
  }

  const median = weighted.marketUnitPriceMedian!;
  const p25 = weighted.marketUnitPriceP25!;
  const p75 = weighted.marketUnitPriceP75!;
  const iqrRatio = (p75 - p25) / median;
  const stale = freshness.transactionStale || freshness.doorplateStale;
  const selectedStage = selection.selectedStage === null
    ? null
    : policy.stages[selection.selectedStage - 1] ?? null;
  const high = comparables.length >= HIGH_CONFIDENCE_MIN_COMPARABLES
    && selectedStage?.confidenceClass === 'standard'
    && iqrRatio <= HIGH_IQR_RATIO
    && !stale;
  const medium = comparables.length >= 3 && iqrRatio <= MEDIUM_IQR_RATIO;
  const confidence = high ? 'high' : medium ? 'medium' : 'low';
  const status = comparables.length < 3 || stale || iqrRatio > MEDIUM_IQR_RATIO ? 'review' : 'reliable';

  return {
    status,
    confidence,
    subjectOwnershipEvidence: subject.ownershipEvidence ?? 'unspecified',
    subjectLocationEvidence: null,
    marketUnitPriceMedian: median,
    marketUnitPriceP25: p25,
    marketUnitPriceP75: p75,
    askingPremiumMedian: subject.askingUnitPriceWan === null ? null : askingPremiumPercent(subject.askingUnitPriceWan, median),
    askingPremiumConservative: subject.askingUnitPriceWan === null ? null : askingPremiumPercent(subject.askingUnitPriceWan, p25),
    selectedStage: selection.selectedStage,
    sourceFreshness: freshness,
    unavailableReasons,
    comparables,
    excludedCandidates,
  };
}
