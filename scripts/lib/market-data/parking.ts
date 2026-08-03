import { haversineMeters } from '../geo.ts';
import { ACTIVE_ESTIMATOR_POLICY, PARKING_POLICY } from './config.ts';
import { weightedQuantile } from './statistics.ts';
import type { Coordinate } from '../coords.ts';
import type {
  BuildingType,
  BundleValueQuantiles,
  MarketTransaction,
  ParkingFamily,
  ParkingImputationEvidence,
} from './types.ts';

export interface ParkingSubject {
  coordinate: Coordinate;
  matchedAddress: string | null;
  buildingType: BuildingType;
  family: Exclude<ParkingFamily, 'none' | 'unknown'>;
}

export interface ParkingEstimate extends ParkingImputationEvidence {
  family: 'flat' | 'mechanical';
  directPairs: Array<{ id: string; priceNtd: number; areaPing: number; weight: number }>;
}

interface DirectParkingPair {
  id: string;
  transaction: MarketTransaction;
  priceNtd: number;
  areaPing: number;
  transactionDate: Date;
}

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

function subtractCalendarMonths(date: Date, months: number): Date {
  const totalMonths = date.getUTCFullYear() * 12 + date.getUTCMonth() - months;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

function locationPrecision(transaction: MarketTransaction): number {
  if (!transaction.location.coordinate) return 0;
  return transaction.location.method === 'address-range'
    ? Math.max(0.5, 1 / (1 + (transaction.location.uncertaintyMeters ?? 0) / 400))
    : 1;
}

function directPair(
  transaction: MarketTransaction,
  subject: ParkingSubject,
  asOf: Date,
): DirectParkingPair | null {
  const transactionDate = parseIsoDate(transaction.transactionDate);
  const priceNtd = transaction.parkingEvidence.officialPriceNtd;
  const areaPing = transaction.parkingEvidence.officialAreaPing;
  if (!transactionDate || transactionDate >= asOf || transactionDate < subtractCalendarMonths(asOf, PARKING_POLICY.maximumAgeMonths)) {
    return null;
  }
  if (transaction.parkingEvidence.grade !== 'A' || transaction.parkingEvidence.family !== subject.family) return null;
  if (!finitePositive(priceNtd) || !finitePositive(areaPing)) return null;
  return { id: transaction.id, transaction, priceNtd, areaPing, transactionDate };
}

function timeWeight(transactionDate: Date, asOf: Date): number {
  return ACTIVE_ESTIMATOR_POLICY.timeWeightBands.find((band) =>
    transactionDate >= subtractCalendarMonths(asOf, band.maxAgeMonths),
  )?.weight ?? 0;
}

function nearbyWeight(subject: ParkingSubject, pair: DirectParkingPair, asOf: Date): number {
  const coordinate = pair.transaction.location.coordinate;
  if (!coordinate) return 0;
  const distance = haversineMeters(subject.coordinate, coordinate);
  const distanceWeight = ACTIVE_ESTIMATOR_POLICY.distanceWeightBands.find((band) => distance <= band.maxDistanceM)?.weight ?? 0;
  return distanceWeight * timeWeight(pair.transactionDate, asOf) * locationPrecision(pair.transaction);
}

function sameBuildingWeight(pair: DirectParkingPair, asOf: Date): number {
  return timeWeight(pair.transactionDate, asOf) * locationPrecision(pair.transaction);
}

function estimate(
  stage: ParkingEstimate['stage'],
  pairs: readonly DirectParkingPair[],
  asOf: string,
  weightFor: (pair: DirectParkingPair) => number,
): ParkingEstimate | null {
  const directPairs = pairs
    .map((pair) => ({ id: pair.id, priceNtd: pair.priceNtd, areaPing: pair.areaPing, weight: weightFor(pair) }))
    .filter((pair) => Number.isFinite(pair.weight) && pair.weight > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (directPairs.length < PARKING_POLICY.minimumDirectComparables) return null;

  return {
    asOf,
    stage,
    family: pairs[0]!.transaction.parkingEvidence.family as 'flat' | 'mechanical',
    comparableIds: directPairs.map((pair) => pair.id),
    comparableCount: directPairs.length,
    priceP25Ntd: weightedQuantile(directPairs.map((pair) => ({ id: pair.id, value: pair.priceNtd, weight: pair.weight })), 0.25),
    priceP50Ntd: weightedQuantile(directPairs.map((pair) => ({ id: pair.id, value: pair.priceNtd, weight: pair.weight })), 0.5),
    priceP75Ntd: weightedQuantile(directPairs.map((pair) => ({ id: pair.id, value: pair.priceNtd, weight: pair.weight })), 0.75),
    areaP25Ping: weightedQuantile(directPairs.map((pair) => ({ id: pair.id, value: pair.areaPing, weight: pair.weight })), 0.25),
    areaP50Ping: weightedQuantile(directPairs.map((pair) => ({ id: pair.id, value: pair.areaPing, weight: pair.weight })), 0.5),
    areaP75Ping: weightedQuantile(directPairs.map((pair) => ({ id: pair.id, value: pair.areaPing, weight: pair.weight })), 0.75),
    directPairs,
  };
}

/** Estimates a parking pair only from earlier, direct grade-A official records. */
export function estimateParking(
  subject: ParkingSubject,
  candidates: readonly MarketTransaction[],
  asOf: string,
): ParkingEstimate | null {
  const targetDate = parseIsoDate(asOf);
  if (!targetDate) throw new RangeError('Parking estimation requires a valid as-of date');
  if (!Number.isFinite(subject.coordinate.lat) || !Number.isFinite(subject.coordinate.lng)) {
    throw new RangeError('Parking estimation requires a finite subject coordinate');
  }

  const directPairs = candidates
    .map((candidate) => directPair(candidate, subject, targetDate))
    .filter((pair): pair is DirectParkingPair => pair !== null);
  const sameBuilding = subject.matchedAddress === null ? [] : directPairs.filter((pair) =>
    pair.transaction.location.matchedAddress === subject.matchedAddress,
  );
  const exactEstimate = estimate('same-building', sameBuilding, asOf, (pair) => sameBuildingWeight(pair, targetDate));
  if (exactEstimate) return exactEstimate;

  const nearby = directPairs.filter((pair) => {
    const coordinate = pair.transaction.location.coordinate;
    return pair.transaction.buildingType === subject.buildingType
      && coordinate !== null
      && haversineMeters(subject.coordinate, coordinate) <= PARKING_POLICY.nearbyRadiusM;
  });
  return estimate('nearby-500m', nearby, asOf, (pair) => nearbyWeight(subject, pair, targetDate));
}

export interface BuildingObservation {
  id: string;
  unitPriceWan: number;
  weight: number;
}

export interface ParkingPairObservation {
  id: string;
  priceNtd: number;
  areaPing: number;
  weight: number;
}

function topWeighted<T extends { id: string; weight: number }>(observations: readonly T[]): T[] {
  return observations
    .filter((observation) => Number.isFinite(observation.weight) && observation.weight > 0)
    .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id))
    .slice(0, 50);
}

/** Combines paired building and parking evidence without independently mixing their extrema. */
export function bundleValueQuantiles(
  totalAreaPing: number,
  buildingObservations: readonly BuildingObservation[],
  parkingPairs: readonly ParkingPairObservation[],
): BundleValueQuantiles | null {
  if (!Number.isFinite(totalAreaPing) || totalAreaPing <= 0) return null;
  const buildings = topWeighted(buildingObservations.filter((observation) =>
    Number.isFinite(observation.unitPriceWan) && observation.unitPriceWan > 0,
  ));
  const parking = topWeighted(parkingPairs.filter((pair) =>
    Number.isFinite(pair.priceNtd) && pair.priceNtd > 0
    && Number.isFinite(pair.areaPing) && pair.areaPing > 0,
  ));
  const observations = buildings.flatMap((building) => parking.map((pair) => {
    const netAreaPing = totalAreaPing - pair.areaPing;
    const valueNtd = netAreaPing * building.unitPriceWan * 10_000 + pair.priceNtd;
    const weight = building.weight * pair.weight;
    return { id: `${building.id}\u0000${pair.id}`, value: valueNtd, weight, netAreaPing };
  })).filter((observation) =>
    Number.isFinite(observation.netAreaPing) && observation.netAreaPing > 0
    && Number.isFinite(observation.value) && observation.value > 0
    && Number.isFinite(observation.weight) && observation.weight > 0,
  );
  if (observations.length === 0) return null;

  return {
    p25Ntd: weightedQuantile(observations, 0.25),
    p50Ntd: weightedQuantile(observations, 0.5),
    p75Ntd: weightedQuantile(observations, 0.75),
    observationCount: observations.length,
  };
}
