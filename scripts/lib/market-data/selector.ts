import { haversineMeters } from '../geo.ts';
import { ACTIVE_ESTIMATOR_POLICY, PARKING_POLICY, WEIGHTS } from './config.ts';
import type { EstimatorPolicy, SearchStage } from './config.ts';
import type {
  ComparableEvidence,
  FloorGroup,
  MarketSubject,
  MarketTransaction,
  NormalizedPrimaryUse,
  SelectionResult,
  WeightBreakdown,
} from './types.ts';

function finitePositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
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

function subtractCalendarMonths(date: Date, months: number): Date {
  const totalMonths = date.getUTCFullYear() * 12 + date.getUTCMonth() - months;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

function ageYearsAt(completionDate: string | null, asOf: Date): number | null {
  if (!completionDate) return null;
  const completion = parseIsoDate(completionDate);
  if (!completion || completion > asOf) return null;
  return completeMonthsBetween(completion, asOf) / 12;
}

function adjacentFloorGroup(type: MarketSubject['buildingType'], left: FloorGroup, right: FloorGroup): boolean {
  if (left === 'first' || right === 'first') return false;
  const groups = type === 'apartment'
    ? ['low', 'middle', 'top']
    : ['low', 'middle', 'high'];
  return Math.abs(groups.indexOf(left) - groups.indexOf(right)) === 1;
}

function locationDistances(subject: MarketSubject, transaction: MarketTransaction): { min: number; max: number } | null {
  const coordinate = transaction.location.coordinate;
  if (!coordinate || !Number.isFinite(coordinate.lat) || !Number.isFinite(coordinate.lng)) return null;
  const distance = haversineMeters(subject.coordinate, coordinate);
  const uncertainty = transaction.location.method === 'address-range' && finitePositive(transaction.location.uncertaintyMeters ?? 0)
    ? transaction.location.uncertaintyMeters!
    : 0;
  return { min: Math.max(0, distance - uncertainty), max: distance + uncertainty };
}

function commonHardReasons(
  subject: MarketSubject,
  transaction: MarketTransaction,
  transactionDate: Date,
  asOf: Date,
  maximumMonths: number,
): string[] {
  const reasons: string[] = [];
  if (transaction.district !== subject.district) reasons.push('district-mismatch');
  if (transaction.buildingType !== subject.buildingType) reasons.push('building-type-mismatch');
  if (transaction.ownership !== subject.ownership || transaction.ownership === 'unknown') reasons.push('ownership-mismatch');
  if (!transaction.location.coordinate || transaction.location.method === 'unresolved') reasons.push('location-unresolved');
  if (transactionDate > asOf) reasons.push('transaction-in-future');
  if (transactionDate < subtractCalendarMonths(asOf, maximumMonths)) reasons.push('transaction-too-old');
  if (subject.buildingType !== 'apartment' && (subject.ageYears === null || ageYearsAt(transaction.completionDate, asOf) === null)) {
    reasons.push('missing-building-age');
  }
  return reasons;
}

function legacyHardReasons(
  subject: MarketSubject,
  transaction: MarketTransaction,
  transactionDate: Date,
  asOf: Date,
  maximumMonths: number,
): string[] {
  return [
    ...(transaction.eligibility !== 'reliable-eligible' ? ['review-only-evidence'] : []),
    ...commonHardReasons(subject, transaction, transactionDate, asOf, maximumMonths),
    ...(!finitePositive(transaction.buildingUnitPriceWan) ? ['invalid-building-unit-price'] : []),
    ...(!finitePositive(transaction.buildingAreaPing) ? ['invalid-building-area'] : []),
  ];
}

function stageReasons(
  subject: MarketSubject,
  transaction: MarketTransaction,
  stage: SearchStage,
  distances: { min: number; max: number } | null,
  transactionDate: Date,
  asOf: Date,
  comparableAreaPing: number | null,
): string[] {
  const reasons: string[] = [];
  if (!finitePositive(comparableAreaPing)) return ['invalid-building-area'];
  if (!distances || distances.min > stage.radiusM) reasons.push('distance-too-far');
  if (transactionDate < subtractCalendarMonths(asOf, stage.months)) reasons.push('transaction-too-old-for-stage');
  const areaDifference = Math.abs(comparableAreaPing - subject.buildingAreaPing) / subject.buildingAreaPing;
  if (areaDifference > stage.areaTolerance) reasons.push('area-difference-too-large');

  const sameFloor = transaction.floorGroup === subject.floorGroup;
  if (!sameFloor && (!stage.allowAdjacentFloor || !adjacentFloorGroup(subject.buildingType, subject.floorGroup, transaction.floorGroup))) {
    reasons.push('floor-group-mismatch');
  }

  if (subject.buildingType !== 'apartment') {
    const comparableAge = ageYearsAt(transaction.completionDate, asOf);
    const ageTolerance = stage.areaTolerance === 0.2 ? 10 : 15;
    if (subject.ageYears === null || comparableAge === null || Math.abs(subject.ageYears - comparableAge) > ageTolerance) {
      reasons.push('building-age-difference-too-large');
    }
  }
  return reasons;
}

function weightBreakdown(
  subject: MarketSubject,
  transaction: MarketTransaction,
  distances: { min: number; max: number } | null,
  transactionDate: Date | null,
  asOf: Date,
  policy: EstimatorPolicy,
  comparableAreaPing: number | null,
): WeightBreakdown {
  const distance = !distances
    ? 0
    : policy.distanceWeightBands.find((band) => distances.max <= band.maxDistanceM)?.weight ?? 0;
  const time = !transactionDate || transactionDate > asOf
    ? 0
    : policy.timeWeightBands.find((band) =>
      transactionDate >= subtractCalendarMonths(asOf, band.maxAgeMonths),
    )?.weight ?? 0;
  const locationPrecision = transaction.location.method === 'address-range'
    ? Math.max(0.5, 1 / (1 + (transaction.location.uncertaintyMeters ?? 0) / 400))
    : transaction.location.coordinate ? 1 : 0;
  const areaDifference = finitePositive(subject.buildingAreaPing) && finitePositive(comparableAreaPing)
    ? Math.abs(comparableAreaPing - subject.buildingAreaPing) / subject.buildingAreaPing
    : Number.POSITIVE_INFINITY;
  const area = areaDifference <= 0.2 ? 1 : areaDifference <= 0.3 ? WEIGHTS.relaxedArea : 0;
  const comparableAge = ageYearsAt(transaction.completionDate, asOf);
  const buildingAge = subject.buildingType === 'apartment' ? 1
    : subject.ageYears === null || comparableAge === null ? 0
      : Math.abs(subject.ageYears - comparableAge) <= 10 ? 1
        : Math.abs(subject.ageYears - comparableAge) <= 15 ? WEIGHTS.relaxedAge : 0;
  const floor = transaction.floorGroup === subject.floorGroup ? 1
    : adjacentFloorGroup(subject.buildingType, subject.floorGroup, transaction.floorGroup) ? WEIGHTS.adjacentFloor
      : 0;
  return { distance, time, locationPrecision, area, buildingAge, floor, total: distance * time * locationPrecision * area * buildingAge * floor };
}

interface CandidateState {
  evidence: ComparableEvidence;
  hardReasons: string[];
  transactionDate: Date | null;
}

interface SelectionRules {
  comparableAreaPing(transaction: MarketTransaction): number | null;
  hardReasons(
    subject: MarketSubject,
    transaction: MarketTransaction,
    transactionDate: Date,
    asOf: Date,
    maximumMonths: number,
  ): string[];
  adjustWeight(transaction: MarketTransaction, weight: WeightBreakdown): WeightBreakdown;
}

function selectWithRules(
  subject: MarketSubject,
  candidates: readonly MarketTransaction[],
  asOf: string,
  policy: EstimatorPolicy,
  rules: SelectionRules,
): SelectionResult {
  const targetDate = parseIsoDate(asOf);
  if (!targetDate) throw new RangeError('Comparable selection requires a valid as-of date');
  if (!Number.isFinite(subject.coordinate.lat) || !Number.isFinite(subject.coordinate.lng)) {
    throw new RangeError('Comparable selection requires a finite subject coordinate');
  }

  const maximumMonths = Math.max(...policy.stages.map((stage) => stage.months));
  const states = candidates.map((transaction): CandidateState => {
    const transactionDate = parseIsoDate(transaction.transactionDate);
    const transactionMonths = transactionDate ? completeMonthsBetween(transactionDate, targetDate) : Number.POSITIVE_INFINITY;
    const distances = locationDistances(subject, transaction);
    const comparableAreaPing = rules.comparableAreaPing(transaction);
    const hard = transactionDate
      ? rules.hardReasons(subject, transaction, transactionDate, targetDate, maximumMonths)
      : ['invalid-transaction-date'];
    return {
      evidence: {
        transaction,
        distanceMinM: distances?.min ?? Number.POSITIVE_INFINITY,
        distanceMaxM: distances?.max ?? Number.POSITIVE_INFINITY,
        transactionAgeMonths: transactionMonths,
        weight: rules.adjustWeight(
          transaction,
          weightBreakdown(subject, transaction, distances, transactionDate, targetDate, policy, comparableAreaPing),
        ),
        included: false,
        reasons: [],
      },
      hardReasons: hard,
      transactionDate,
    };
  });

  let selectedStage: number | null = null;
  let selectedStates: CandidateState[] = [];
  const finalStageReasons = new Map<CandidateState, string[]>();
  for (const [index, stage] of policy.stages.entries()) {
    const qualifying = states.filter((state) => {
      const reasons = !state.transactionDate
        ? state.hardReasons
        : [...state.hardReasons, ...stageReasons(subject, state.evidence.transaction, stage, {
          min: state.evidence.distanceMinM,
          max: state.evidence.distanceMaxM,
        }, state.transactionDate, targetDate, rules.comparableAreaPing(state.evidence.transaction))];
      finalStageReasons.set(state, reasons);
      return reasons.length === 0;
    });
    if (qualifying.length >= 3 || index === policy.stages.length - 1) {
      selectedStates = qualifying;
      selectedStage = qualifying.length > 0 ? index + 1 : null;
      break;
    }
  }

  const selectedSet = new Set(selectedStates);
  const all = states.map((state) => ({
    ...state.evidence,
    included: selectedSet.has(state),
    reasons: selectedSet.has(state) ? [] : (finalStageReasons.get(state) ?? state.hardReasons),
  }));
  return {
    selectedStage,
    included: all.filter((candidate) => candidate.included),
    reviewOnly: all.filter((candidate) => !candidate.included
      && candidate.reasons.length === 1 && candidate.reasons[0] === 'review-only-evidence'),
    excluded: all.filter((candidate) => !candidate.included),
    candidates: all,
  };
}

/** Selects exact-stage comparables using only official transaction metadata and GPS evidence. */
export function selectComparables(
  subject: MarketSubject,
  candidates: readonly MarketTransaction[],
  asOf: string,
  policy: EstimatorPolicy = ACTIVE_ESTIMATOR_POLICY,
): SelectionResult {
  return selectWithRules(subject, candidates, asOf, policy, {
    comparableAreaPing: (transaction) => transaction.buildingAreaPing,
    hardReasons: legacyHardReasons,
    adjustWeight: (_transaction, weight) => weight,
  });
}

export interface ScenarioSelectionOptions {
  primaryUse: Exclude<NormalizedPrimaryUse, 'unknown'>;
  allowImputedParking: boolean;
  /** Grade-B evidence is limited to parking families with accepted masked holdouts. */
  acceptedParkingFamilies?: ReadonlyArray<'flat' | 'mechanical'>;
  bundleOnly?: boolean;
}

function scenarioHardReasons(
  options: ScenarioSelectionOptions,
  subject: MarketSubject,
  transaction: MarketTransaction,
  transactionDate: Date,
  asOf: Date,
  maximumMonths: number,
): string[] {
  const reasons = commonHardReasons(subject, transaction, transactionDate, asOf, maximumMonths);
  if (transaction.primaryUse !== options.primaryUse) reasons.push('primary-use-mismatch');
  if (transaction.transferredBuildingCount !== 1) reasons.push('building-count-not-one');

  if (options.bundleOnly) {
    if (transaction.parkingEvidence.grade !== 'C') reasons.push('parking-grade-not-bundle-evidence');
    if (!finitePositive(transaction.totalPriceNtd)) reasons.push('invalid-total-price');
    if (!finitePositive(transaction.totalAreaPing)) reasons.push('invalid-total-area');
    return reasons;
  }

  if (transaction.parkingEvidence.grade === 'C') reasons.push('parking-grade-not-building-evidence');
  if (transaction.parkingEvidence.grade === 'B') {
    if (!options.allowImputedParking) reasons.push('parking-imputation-not-accepted');
    else if (options.acceptedParkingFamilies
      && ((transaction.parkingEvidence.family !== 'flat'
          && transaction.parkingEvidence.family !== 'mechanical')
        || !options.acceptedParkingFamilies.includes(transaction.parkingEvidence.family))) {
      reasons.push('parking-family-cohort-not-accepted');
    }
    else if (transaction.parkingEvidence.imputation === null) reasons.push('parking-imputation-unavailable');
    const bounds = transaction.buildingUnitPriceBoundsWan;
    if (!bounds
      || !finitePositive(bounds.p25)
      || !finitePositive(bounds.p50)
      || !finitePositive(bounds.p75)
      || bounds.p25 > bounds.p50
      || bounds.p50 > bounds.p75
      || !Number.isFinite(bounds.relativeIqrRatio)
      || bounds.relativeIqrRatio < 0) {
      reasons.push('parking-imputation-uncertainty-unavailable');
    } else if (bounds.relativeIqrRatio > PARKING_POLICY.maximumBuildingUnitPriceIqrRatio) {
      reasons.push('parking-imputation-uncertainty-too-wide');
    }
  }
  if (!finitePositive(transaction.buildingPriceNtd)) reasons.push('invalid-building-price');
  if (!finitePositive(transaction.buildingUnitPriceWan)) reasons.push('invalid-building-unit-price');
  if (!finitePositive(transaction.buildingAreaPing)) reasons.push('invalid-building-area');
  return reasons;
}

/** Selects one exact-use cohort without allowing parking quality to cross evidence paths. */
export function selectScenarioComparables(
  subject: MarketSubject,
  candidates: readonly MarketTransaction[],
  asOf: string,
  options: ScenarioSelectionOptions,
  policy: EstimatorPolicy = ACTIVE_ESTIMATOR_POLICY,
): SelectionResult {
  return selectWithRules(subject, candidates, asOf, policy, {
    comparableAreaPing: (transaction) => options.bundleOnly
      ? transaction.totalAreaPing
      : transaction.buildingAreaPing,
    hardReasons: (selectionSubject, transaction, transactionDate, targetDate, maximumMonths) =>
      scenarioHardReasons(options, selectionSubject, transaction, transactionDate, targetDate, maximumMonths),
    adjustWeight: (transaction, weight) => {
      if (transaction.parkingEvidence.grade !== 'B') return weight;
      const uncertainty = transaction.buildingUnitPriceBoundsWan?.relativeIqrRatio
        ?? PARKING_POLICY.maximumBuildingUnitPriceIqrRatio;
      const factor = Math.max(
        PARKING_POLICY.minimumImputedWeightFactor,
        1 - uncertainty / PARKING_POLICY.maximumBuildingUnitPriceIqrRatio,
      );
      return {
        ...weight,
        total: Math.min(
          weight.total,
          PARKING_POLICY.imputedComparableWeightCap * factor,
        ),
      };
    },
  });
}
