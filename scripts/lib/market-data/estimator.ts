import { askingPremiumPercent } from '../finance.ts';
import { neighborGridKeys } from './grid.ts';
import { HIGH_CONFIDENCE_MIN_COMPARABLES, HIGH_IQR_RATIO, MEDIUM_IQR_RATIO } from './config.ts';
import { selectComparables } from './selector.ts';
import { weightedMadOutliers, weightedQuantile } from './statistics.ts';
import type {
  ComparableEvidence,
  MarketEstimate,
  MarketSubject,
  SourceFreshness,
  TransactionIndex,
} from './types.ts';

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function subjectHardReasons(subject: MarketSubject): string[] {
  const reasons: string[] = [];
  if (!Number.isFinite(subject.coordinate.lat) || !Number.isFinite(subject.coordinate.lng)) reasons.push('location-unreliable');
  if (!subject.district) reasons.push('missing-district');
  if (subject.ownership === 'unknown') reasons.push('ownership-unknown');
  if (!finitePositive(subject.buildingAreaPing)) reasons.push('invalid-building-area');
  if (!finitePositive(subject.askingUnitPriceWan)) reasons.push('invalid-asking-unit-price');
  if (!subject.parkingSeparable) reasons.push('parking-not-separable');
  if (subject.buildingType !== 'apartment' && subject.ageYears === null) reasons.push('missing-subject-building-age');
  return reasons;
}

function nearbyTransactions(subject: MarketSubject, index: TransactionIndex) {
  const byId = new Map<string, TransactionIndex['cells'][string][number]>();
  for (const key of neighborGridKeys(subject.coordinate, 800)) {
    for (const transaction of index.cells[key] ?? []) byId.set(transaction.id, transaction);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function excludedOutlier(candidate: ComparableEvidence): ComparableEvidence {
  return { ...candidate, included: false, reasons: [...candidate.reasons, 'weighted-mad-outlier'] };
}

/** Produces a reproducible, evidence-carrying price estimate from local official transactions. */
export function estimateMarket(
  subject: MarketSubject,
  index: TransactionIndex,
  freshness: SourceFreshness,
  asOf: string,
): MarketEstimate {
  const hardReasons = subjectHardReasons(subject);
  if (hardReasons.includes('location-unreliable')) {
    return {
      status: 'unavailable',
      confidence: 'low',
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
  const selection = selectComparables(subject, nearbyTransactions(subject, index), asOf);
  const initialIncluded = selection.included;
  const outlierIds = hardReasons.length === 0
    ? new Set(weightedMadOutliers(initialIncluded.map((candidate) => ({
      id: candidate.transaction.id,
      value: candidate.transaction.buildingUnitPriceWan,
      weight: candidate.weight.total,
    }))).map((observation) => observation.id))
    : new Set<string>();
  const comparables = initialIncluded.filter((candidate) => !outlierIds.has(candidate.transaction.id));
  const excludedCandidates = [
    ...selection.excluded,
    ...initialIncluded.filter((candidate) => outlierIds.has(candidate.transaction.id)).map(excludedOutlier),
  ];
  const unavailableReasons = [...hardReasons];
  if (comparables.length === 0) unavailableReasons.push('no-comparables');

  if (hardReasons.length > 0 || comparables.length === 0) {
    return {
      status: 'unavailable',
      confidence: 'low',
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

  const observations = comparables.map((candidate) => ({
    id: candidate.transaction.id,
    value: candidate.transaction.buildingUnitPriceWan,
    weight: candidate.weight.total,
  }));
  const median = weightedQuantile(observations, 0.5);
  const p25 = weightedQuantile(observations, 0.25);
  const p75 = weightedQuantile(observations, 0.75);
  const iqrRatio = (p75 - p25) / median;
  const stale = freshness.transactionStale || freshness.doorplateStale;
  const high = comparables.length >= HIGH_CONFIDENCE_MIN_COMPARABLES
    && selection.selectedStage !== 5
    && iqrRatio <= HIGH_IQR_RATIO
    && !stale;
  const medium = comparables.length >= 3 && iqrRatio <= MEDIUM_IQR_RATIO;
  const confidence = high ? 'high' : medium ? 'medium' : 'low';
  const status = comparables.length < 3 || stale || iqrRatio > MEDIUM_IQR_RATIO ? 'review' : 'reliable';

  return {
    status,
    confidence,
    marketUnitPriceMedian: median,
    marketUnitPriceP25: p25,
    marketUnitPriceP75: p75,
    askingPremiumMedian: askingPremiumPercent(subject.askingUnitPriceWan, median),
    askingPremiumConservative: askingPremiumPercent(subject.askingUnitPriceWan, p25),
    selectedStage: selection.selectedStage,
    sourceFreshness: freshness,
    unavailableReasons,
    comparables,
    excludedCandidates,
  };
}
