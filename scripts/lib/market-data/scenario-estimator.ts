import { askingPremiumPercent } from '../finance.ts';
import {
  ACTIVE_ESTIMATOR_POLICY,
  HIGH_CONFIDENCE_MIN_COMPARABLES,
  HIGH_IQR_RATIO,
  MEDIUM_IQR_RATIO,
} from './config.ts';
import { estimateWeightedBuildingPrices } from './estimator.ts';
import { neighborGridKeys } from './grid.ts';
import { bundleValueQuantiles, estimateParking } from './parking.ts';
import { selectScenarioComparables } from './selector.ts';
import { weightedQuantile } from './statistics.ts';
import type {
  BacktestAcceptance,
  BundleValueQuantiles,
  ComparableEvidence,
  EstimateConfidence,
  MarketScenarioEstimate,
  MarketSubject,
  MarketTransaction,
  NormalizedPrimaryUse,
  ParkingGrade,
  ParkingImputationEvidence,
  ScenarioMarketSubject,
  SourceFreshness,
  TransactionIndex,
  UseScenarioEstimate,
} from './types.ts';

const SCENARIO_USE_ORDER: ReadonlyArray<Exclude<NormalizedPrimaryUse, 'unknown'>> = [
  'residential',
  'mixed-residential',
  'office',
  'commercial',
  'industrial',
  'mixed-industrial',
];

type ScenarioRole = UseScenarioEstimate['role'];
type BundleRelationship = 'corroborates' | 'conflicts' | 'insufficient';

function finitePositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function validParkingCount(value: unknown): value is 0 | 1 | 2 | null {
  return value === null || value === 0 || value === 1 || value === 2;
}

function subjectReasons(subject: ScenarioMarketSubject): string[] {
  const reasons: string[] = [];
  if (!Number.isFinite(subject.coordinate.lat) || !Number.isFinite(subject.coordinate.lng)) reasons.push('location-unreliable');
  if (!subject.district) reasons.push('missing-district');
  if (subject.ownership === 'unknown') reasons.push('ownership-unknown');
  if (!finitePositive(subject.totalAreaPing)) reasons.push('invalid-total-area');
  if (!finitePositive(subject.askingTotalPriceNtd)) reasons.push('invalid-asking-total-price');
  if (subject.buildingType !== 'apartment' && subject.ageYears === null) reasons.push('missing-subject-building-age');
  if (subject.registeredUse.value === 'unknown' || subject.registeredUse.source === 'unknown') reasons.push('registered-use-unverified');
  if (subject.parkingFamily === 'unknown') reasons.push('parking-family-unknown');
  const parkingCount: unknown = subject.parkingCount;
  if (!validParkingCount(parkingCount)) {
    reasons.push('invalid-parking-count');
  } else {
    if (subject.parkingFamily !== 'none' && parkingCount === null) reasons.push('parking-count-unknown');
    if (subject.parkingFamily === 'none' && parkingCount !== 0) reasons.push('parking-count-family-conflict');
    if ((subject.parkingFamily === 'flat' || subject.parkingFamily === 'mechanical') && parkingCount === 0) {
      reasons.push('parking-count-family-conflict');
    }
    if (subject.parkingFamily === 'unknown' && parkingCount !== null) reasons.push('parking-count-family-conflict');
  }
  return reasons;
}

function nearbyTransactions(subject: ScenarioMarketSubject, index: TransactionIndex): MarketTransaction[] {
  const maximumRadiusM = Math.max(...ACTIVE_ESTIMATOR_POLICY.stages.map((stage) => stage.radiusM));
  const byId = new Map<string, MarketTransaction>();
  for (const key of neighborGridKeys(subject.coordinate, maximumRadiusM)) {
    for (const transaction of index.cells[key] ?? []) byId.set(transaction.id, transaction);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function useCohortAccepted(
  acceptance: BacktestAcceptance | null,
  primaryUse: Exclude<NormalizedPrimaryUse, 'unknown'>,
): boolean {
  // Schema-2 acceptance proves only the authoritative legacy residential cohort.
  return acceptance !== null && primaryUse === 'residential';
}

function parkingImputationAccepted(_acceptance: BacktestAcceptance | null): boolean {
  // Schema-2 has no validated parking activation. Task 6 introduces that contract.
  return false;
}

function scenarioRequests(subject: ScenarioMarketSubject): Array<{
  primaryUse: Exclude<NormalizedPrimaryUse, 'unknown'>;
  role: ScenarioRole;
}> {
  const registeredUse = subject.registeredUse.value;
  const verified = registeredUse !== 'unknown' && subject.registeredUse.source !== 'unknown';
  if (!verified) {
    return SCENARIO_USE_ORDER.map((primaryUse) => ({ primaryUse, role: 'unknown-use-scenario' }));
  }
  const primaryUse = registeredUse as Exclude<NormalizedPrimaryUse, 'unknown'>;
  return primaryUse === 'residential'
    ? [{ primaryUse, role: 'primary' }]
    : [
      { primaryUse, role: 'primary' },
      { primaryUse: 'residential', role: 'residential-comparison' },
    ];
}

function marketSubject(subject: ScenarioMarketSubject, buildingAreaPing: number): MarketSubject {
  return {
    listingId: subject.listingId,
    coordinate: subject.coordinate,
    district: subject.district,
    ownership: subject.ownership,
    ownershipEvidence: subject.ownershipEvidence,
    buildingType: subject.buildingType,
    buildingAreaPing,
    askingUnitPriceWan: null,
    floor: subject.floor,
    totalFloors: subject.totalFloors,
    floorGroup: subject.floorGroup,
    ageYears: subject.ageYears,
    parkingSeparable: true,
  };
}

function confidenceFor(
  comparableCount: number,
  p25: number,
  median: number,
  p75: number,
  selectedStage: number | null,
  freshness: SourceFreshness,
): EstimateConfidence {
  const iqrRatio = (p75 - p25) / median;
  const stale = freshness.transactionStale || freshness.doorplateStale;
  const stage = selectedStage === null ? null : ACTIVE_ESTIMATOR_POLICY.stages[selectedStage - 1] ?? null;
  const high = comparableCount >= HIGH_CONFIDENCE_MIN_COMPARABLES
    && stage?.confidenceClass === 'standard'
    && iqrRatio <= HIGH_IQR_RATIO
    && !stale;
  const medium = comparableCount >= 3 && iqrRatio <= MEDIUM_IQR_RATIO;
  return high ? 'high' : medium ? 'medium' : 'low';
}

function noParkingBundle(
  totalAreaPing: number,
  comparables: readonly ComparableEvidence[],
): BundleValueQuantiles | null {
  const observations = comparables.flatMap((candidate) => {
    const unitPriceWan = candidate.transaction.buildingUnitPriceWan;
    return finitePositive(unitPriceWan) && finitePositive(candidate.weight.total)
      ? [{ id: candidate.transaction.id, value: totalAreaPing * unitPriceWan * 10_000, weight: candidate.weight.total }]
      : [];
  });
  if (observations.length === 0) return null;
  return {
    p25Ntd: weightedQuantile(observations, 0.25),
    p50Ntd: weightedQuantile(observations, 0.5),
    p75Ntd: weightedQuantile(observations, 0.75),
    observationCount: observations.length,
  };
}

function publicParkingEvidence(estimate: ReturnType<typeof estimateParking>): ParkingImputationEvidence | null {
  if (!estimate) return null;
  return {
    asOf: estimate.asOf,
    stage: estimate.stage,
    comparableIds: estimate.comparableIds,
    comparableCount: estimate.comparableCount,
    priceP25Ntd: estimate.priceP25Ntd,
    priceP50Ntd: estimate.priceP50Ntd,
    priceP75Ntd: estimate.priceP75Ntd,
    areaP25Ping: estimate.areaP25Ping,
    areaP50Ping: estimate.areaP50Ping,
    areaP75Ping: estimate.areaP75Ping,
  };
}

function bundleFor(
  subject: ScenarioMarketSubject,
  comparables: readonly ComparableEvidence[],
  parking: NonNullable<ReturnType<typeof estimateParking>> | null,
): BundleValueQuantiles | null {
  if (subject.parkingFamily === 'none' && subject.parkingCount === 0) {
    return noParkingBundle(subject.totalAreaPing, comparables);
  }
  if (!parking || subject.parkingCount === null || subject.parkingCount <= 0) return null;
  return bundleValueQuantiles(
    subject.totalAreaPing,
    comparables.flatMap((candidate) => finitePositive(candidate.transaction.buildingUnitPriceWan)
      ? [{
        id: candidate.transaction.id,
        unitPriceWan: candidate.transaction.buildingUnitPriceWan,
        weight: candidate.weight.total,
      }]
      : []),
    parking.directPairs.map((pair) => ({
      id: pair.id,
      priceNtd: pair.priceNtd * subject.parkingCount!,
      areaPing: pair.areaPing * subject.parkingCount!,
      weight: pair.weight,
    })),
  );
}

function gradeCounts(
  comparables: readonly ComparableEvidence[],
  bundleComparables: readonly ComparableEvidence[],
): Record<ParkingGrade, number> {
  const counts: Record<ParkingGrade, number> = { A: 0, B: 0, C: 0 };
  for (const candidate of [...comparables, ...bundleComparables]) counts[candidate.transaction.parkingEvidence.grade] += 1;
  return counts;
}

function bundleRelationship(
  bundleValue: BundleValueQuantiles | null,
  bundleComparables: readonly ComparableEvidence[],
): BundleRelationship {
  const observations = bundleComparables.flatMap((candidate) =>
    finitePositive(candidate.transaction.totalPriceNtd) && finitePositive(candidate.weight.total)
      ? [{ id: candidate.transaction.id, value: candidate.transaction.totalPriceNtd, weight: candidate.weight.total }]
      : [],
  );
  if (!bundleValue || observations.length < 3) return 'insufficient';
  const median = weightedQuantile(observations, 0.5);
  return median < bundleValue.p25Ntd || median > bundleValue.p75Ntd ? 'conflicts' : 'corroborates';
}

function insufficientScenario(
  primaryUse: Exclude<NormalizedPrimaryUse, 'unknown'>,
  role: ScenarioRole,
  selectedStage: number | null,
  comparables: ComparableEvidence[],
  bundleComparables: ComparableEvidence[],
  reasons: string[],
): UseScenarioEstimate {
  return {
    primaryUse,
    role,
    status: 'insufficient-sample',
    confidence: 'low',
    marketUnitPriceP25: null,
    marketUnitPriceMedian: null,
    marketUnitPriceP75: null,
    askingPremiumConservative: null,
    bundleValue: null,
    parkingEstimate: null,
    gradeCounts: gradeCounts(comparables, bundleComparables),
    selectedStage,
    comparables,
    bundleComparables,
    reasons: [...reasons, 'insufficient-comparables', 'bundle-evidence-insufficient'],
  };
}

function unavailableScenario(
  primaryUse: Exclude<NormalizedPrimaryUse, 'unknown'>,
  role: ScenarioRole,
  reasons: readonly string[],
): UseScenarioEstimate {
  return {
    primaryUse,
    role,
    status: 'unavailable',
    confidence: 'low',
    marketUnitPriceP25: null,
    marketUnitPriceMedian: null,
    marketUnitPriceP75: null,
    askingPremiumConservative: null,
    bundleValue: null,
    parkingEstimate: null,
    gradeCounts: { A: 0, B: 0, C: 0 },
    selectedStage: null,
    comparables: [],
    bundleComparables: [],
    reasons: [...reasons],
  };
}

function estimateScenario(
  subject: ScenarioMarketSubject,
  candidates: readonly MarketTransaction[],
  freshness: SourceFreshness,
  asOf: string,
  acceptance: BacktestAcceptance | null,
  primaryUse: Exclude<NormalizedPrimaryUse, 'unknown'>,
  role: ScenarioRole,
  commonReasons: readonly string[],
): UseScenarioEstimate {
  const useAccepted = useCohortAccepted(acceptance, primaryUse);
  const imputedParkingAccepted = parkingImputationAccepted(acceptance);
  const parking = subject.parkingFamily === 'flat' || subject.parkingFamily === 'mechanical'
    ? estimateParking({
      coordinate: subject.coordinate,
      matchedAddress: subject.matchedAddress,
      buildingType: subject.buildingType,
      family: subject.parkingFamily,
    }, candidates, asOf)
    : null;
  const parkingCount = subject.parkingCount ?? 0;
  const derivedBuildingArea = parking && parkingCount > 0
    ? subject.totalAreaPing - parking.areaP50Ping * parkingCount
    : subject.totalAreaPing;
  const buildingSubject = marketSubject(subject, derivedBuildingArea);
  const selection = selectScenarioComparables(buildingSubject, candidates, asOf, {
    primaryUse,
    allowImputedParking: imputedParkingAccepted,
  });
  const weighted = estimateWeightedBuildingPrices(selection.included);
  const bundleSelection = selectScenarioComparables(
    marketSubject(subject, subject.totalAreaPing),
    candidates,
    asOf,
    { primaryUse, allowImputedParking: false, bundleOnly: true },
  );
  const bundleComparables = bundleSelection.included.filter((candidate) =>
    Number.isFinite(candidate.weight.total) && candidate.weight.total > 0,
  );
  const scenarioReasons = [...commonReasons];
  if (!useAccepted) scenarioReasons.push('use-cohort-not-accepted');
  if ((subject.parkingFamily === 'flat' || subject.parkingFamily === 'mechanical') && !parking) {
    scenarioReasons.push('parking-estimate-unavailable');
  }
  if (parking && !imputedParkingAccepted) scenarioReasons.push('parking-cohort-not-accepted');
  if (weighted.comparables.length < 3) {
    return insufficientScenario(
      primaryUse,
      role,
      selection.selectedStage,
      weighted.comparables,
      bundleComparables,
      scenarioReasons,
    );
  }

  const p25 = weighted.marketUnitPriceP25!;
  const median = weighted.marketUnitPriceMedian!;
  const p75 = weighted.marketUnitPriceP75!;
  const confidence = commonReasons.includes('parking-family-unknown')
    ? 'low'
    : confidenceFor(weighted.comparables.length, p25, median, p75, selection.selectedStage, freshness);
  const bundleValue = bundleFor(subject, weighted.comparables, parking);
  const relationship = bundleRelationship(bundleValue, bundleComparables);
  scenarioReasons.push(`bundle-evidence-${relationship}`);
  const stale = freshness.transactionStale || freshness.doorplateStale;
  if (stale) scenarioReasons.push('source-stale');
  if (confidence === 'low') scenarioReasons.push('low-confidence');

  const verifiedPrimary = role === 'primary'
    && subject.registeredUse.value === primaryUse
    && subject.registeredUse.source !== 'unknown';
  const requiresParkingModel = (subject.parkingFamily === 'flat' || subject.parkingFamily === 'mechanical')
    && subject.parkingCount !== null
    && subject.parkingCount > 0;
  const parkingComponentAccepted = !requiresParkingModel || (parking !== null && imputedParkingAccepted);
  const componentAccepted = useAccepted && parkingComponentAccepted;
  const reliable = verifiedPrimary
    && componentAccepted
    && !stale
    && confidence !== 'low'
    && relationship !== 'conflicts'
    && commonReasons.length === 0;
  const needsReview = relationship === 'conflicts'
    || (useAccepted && (!componentAccepted || stale || confidence === 'low' || commonReasons.length > 0))
    || role === 'unknown-use-scenario';
  const status: UseScenarioEstimate['status'] = reliable
    ? 'reliable'
    : needsReview ? 'review' : 'diagnostic-only';

  return {
    primaryUse,
    role,
    status,
    confidence,
    marketUnitPriceP25: p25,
    marketUnitPriceMedian: median,
    marketUnitPriceP75: p75,
    askingPremiumConservative: bundleValue && finitePositive(subject.askingTotalPriceNtd)
      ? askingPremiumPercent(subject.askingTotalPriceNtd, bundleValue.p25Ntd)
      : null,
    bundleValue,
    parkingEstimate: publicParkingEvidence(parking),
    gradeCounts: gradeCounts(weighted.comparables, bundleComparables),
    selectedStage: selection.selectedStage,
    comparables: weighted.comparables,
    bundleComparables,
    reasons: scenarioReasons,
  };
}

/** Produces isolated official-use scenarios while the legacy estimate remains authoritative. */
export function estimateMarketScenarios(
  subject: ScenarioMarketSubject,
  index: TransactionIndex,
  freshness: SourceFreshness,
  asOf: string,
  acceptance: BacktestAcceptance | null,
): MarketScenarioEstimate {
  const reasons = subjectReasons(subject);
  const blocking = reasons.some((reason) => [
    'location-unreliable',
    'missing-district',
    'ownership-unknown',
    'invalid-total-area',
    'missing-subject-building-age',
    'invalid-parking-count',
    'parking-count-family-conflict',
  ].includes(reason));
  const requests = scenarioRequests(subject);
  const candidates = blocking ? [] : nearbyTransactions(subject, index);
  const scenarios = blocking
    ? requests.map(({ primaryUse, role }) => unavailableScenario(primaryUse, role, reasons))
    : requests.map(({ primaryUse, role }) => estimateScenario(
      subject,
      candidates,
      freshness,
      asOf,
      acceptance,
      primaryUse,
      role,
      reasons,
    ));
  return {
    registeredUse: subject.registeredUse,
    parkingFamily: subject.parkingFamily,
    parkingCountAssumption: subject.parkingCount,
    sourceFreshness: freshness,
    scenarios,
    reasons,
  };
}
