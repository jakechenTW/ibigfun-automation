import { haversineMeters } from '../geo.ts';
import { SEARCH_STAGES, WEIGHTS } from './config.ts';
import type {
  ComparableEvidence,
  FloorGroup,
  MarketSubject,
  MarketTransaction,
  SelectionResult,
  WeightBreakdown,
} from './types.ts';

type SearchStage = typeof SEARCH_STAGES[number];

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
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

function hardReasons(subject: MarketSubject, transaction: MarketTransaction, asOf: Date, months: number): string[] {
  const reasons: string[] = [];
  if (transaction.district !== subject.district) reasons.push('district-mismatch');
  if (transaction.buildingType !== subject.buildingType) reasons.push('building-type-mismatch');
  if (transaction.ownership !== subject.ownership || transaction.ownership === 'unknown') reasons.push('ownership-mismatch');
  if (!finitePositive(transaction.buildingUnitPriceWan)) reasons.push('invalid-building-unit-price');
  if (!finitePositive(transaction.buildingAreaPing)) reasons.push('invalid-building-area');
  if (!transaction.location.coordinate || transaction.location.method === 'unresolved') reasons.push('location-unresolved');
  if (months < 0) reasons.push('transaction-in-future');
  if (months > 36) reasons.push('transaction-too-old');
  if (subject.buildingType !== 'apartment' && (subject.ageYears === null || ageYearsAt(transaction.completionDate, asOf) === null)) {
    reasons.push('missing-building-age');
  }
  return reasons;
}

function stageReasons(
  subject: MarketSubject,
  transaction: MarketTransaction,
  stage: SearchStage,
  distances: { min: number; max: number } | null,
  transactionMonths: number,
  asOf: Date,
): string[] {
  const reasons: string[] = [];
  if (!distances || distances.min > stage.radiusM) reasons.push('distance-too-far');
  if (transactionMonths > stage.months) reasons.push('transaction-too-old-for-stage');
  const areaDifference = Math.abs(transaction.buildingAreaPing - subject.buildingAreaPing) / subject.buildingAreaPing;
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
  transactionMonths: number,
  asOf: Date,
): WeightBreakdown {
  const distance = !distances || distances.max > 800 ? 0
    : distances.max <= 300 ? WEIGHTS.distance[0]
      : distances.max <= 500 ? WEIGHTS.distance[1]
        : WEIGHTS.distance[2];
  const time = transactionMonths < 0 || transactionMonths > 36 ? 0
    : transactionMonths <= 12 ? WEIGHTS.time[0]
      : transactionMonths <= 24 ? WEIGHTS.time[1]
        : WEIGHTS.time[2];
  const locationPrecision = transaction.location.method === 'address-range'
    ? Math.max(0.5, 1 / (1 + (transaction.location.uncertaintyMeters ?? 0) / 400))
    : transaction.location.coordinate ? 1 : 0;
  const areaDifference = finitePositive(subject.buildingAreaPing)
    ? Math.abs(transaction.buildingAreaPing - subject.buildingAreaPing) / subject.buildingAreaPing
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
}

/** Selects exact-stage comparables using only official transaction metadata and GPS evidence. */
export function selectComparables(
  subject: MarketSubject,
  candidates: readonly MarketTransaction[],
  asOf: string,
): SelectionResult {
  const targetDate = parseIsoDate(asOf);
  if (!targetDate) throw new RangeError('Comparable selection requires a valid as-of date');
  if (!Number.isFinite(subject.coordinate.lat) || !Number.isFinite(subject.coordinate.lng)) {
    throw new RangeError('Comparable selection requires a finite subject coordinate');
  }

  const states = candidates.map((transaction): CandidateState => {
    const transactionDate = parseIsoDate(transaction.transactionDate);
    const transactionMonths = transactionDate ? completeMonthsBetween(transactionDate, targetDate) : Number.POSITIVE_INFINITY;
    const distances = locationDistances(subject, transaction);
    const hard = transactionDate ? hardReasons(subject, transaction, targetDate, transactionMonths) : ['invalid-transaction-date'];
    return {
      evidence: {
        transaction,
        distanceMinM: distances?.min ?? Number.POSITIVE_INFINITY,
        distanceMaxM: distances?.max ?? Number.POSITIVE_INFINITY,
        transactionAgeMonths: transactionMonths,
        weight: weightBreakdown(subject, transaction, distances, transactionMonths, targetDate),
        included: false,
        reasons: [],
      },
      hardReasons: hard,
    };
  });

  let selectedStage: number | null = null;
  let selectedStates: CandidateState[] = [];
  const finalStageReasons = new Map<CandidateState, string[]>();
  for (const [index, stage] of SEARCH_STAGES.entries()) {
    const qualifying = states.filter((state) => {
      const reasons = state.hardReasons.length > 0
        ? state.hardReasons
        : stageReasons(subject, state.evidence.transaction, stage, {
          min: state.evidence.distanceMinM,
          max: state.evidence.distanceMaxM,
        }, state.evidence.transactionAgeMonths, targetDate);
      finalStageReasons.set(state, reasons);
      return reasons.length === 0;
    });
    if (qualifying.length >= 3 || index === SEARCH_STAGES.length - 1) {
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
    excluded: all.filter((candidate) => !candidate.included),
    candidates: all,
  };
}
