import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bundleValueQuantiles, estimateParking } from './parking.ts';
import type { MarketTransaction } from './types.ts';

const coordinate = { lat: 25.033, lng: 121.565 };
const matchedAddress = '台北市信義區測試路1號';
const METERS_PER_LNG = 111_320 * Math.cos(coordinate.lat * Math.PI / 180);

function coordinateAt(distanceM: number): { lat: number; lng: number } {
  return { lat: coordinate.lat, lng: coordinate.lng + distanceM / METERS_PER_LNG };
}

function directParkingTransaction(
  id: string,
  overrides: Partial<MarketTransaction> = {},
): MarketTransaction {
  return {
    id,
    transactionDate: '2025-12-14',
    sourceVersion: 'fixture',
    originalAddress: matchedAddress,
    location: {
      method: 'exact-doorplate',
      coordinate,
      normalizedAddress: matchedAddress,
      matchedAddress,
      uncertaintyMeters: 0,
      confidence: 'high',
      datasetVersion: 'fixture',
    },
    district: '信義區',
    ownership: 'freehold',
    buildingType: 'highrise',
    totalPriceNtd: 12_000_000,
    totalAreaPing: 40,
    buildingPriceNtd: 10_000_000,
    buildingAreaPing: 30,
    parkingPriceNtd: 2_000_000,
    parkingAreaPing: 10,
    buildingUnitPriceWan: 100,
    parkingEvidence: {
      grade: 'A',
      family: 'flat',
      originalType: '坡道平面',
      officialPriceNtd: 2_000_000,
      officialAreaPing: 10,
      imputation: null,
      reasons: [],
    },
    floor: 8,
    totalFloors: 20,
    floorGroup: 'middle',
    completionDate: '2010-01-01',
    notes: '',
    exclusionFlags: [],
    eligibility: 'reliable-eligible',
    eligibilityReasons: [],
    originalPrimaryUse: '住家用',
    primaryUse: 'residential',
    transferredBuildingCount: 1,
    ...overrides,
  };
}

const subject = {
  coordinate,
  matchedAddress,
  buildingType: 'highrise' as const,
  family: 'flat' as const,
};

test('uses only earlier grade-A direct pairs from the exact building', () => {
  const transactions = [
    directParkingTransaction('old-c', { transactionDate: '2024-12-14' }),
    directParkingTransaction('old-a', { transactionDate: '2025-10-14' }),
    directParkingTransaction('old-b', { transactionDate: '2025-11-14' }),
    directParkingTransaction('same-date', { transactionDate: '2026-01-15' }),
    directParkingTransaction('grade-b', {
      parkingEvidence: {
        grade: 'B', family: 'flat', originalType: '坡道平面',
        officialPriceNtd: 2_000_000, officialAreaPing: null, imputation: null, reasons: ['parking-area-missing'],
      },
    }),
    directParkingTransaction('grade-c', {
      parkingEvidence: {
        grade: 'C', family: 'flat', originalType: '坡道平面',
        officialPriceNtd: 2_000_000, officialAreaPing: 10, imputation: null, reasons: ['parking-evidence-conflict'],
      },
    }),
    directParkingTransaction('mechanical', {
      parkingEvidence: {
        grade: 'A', family: 'mechanical', originalType: '升降機械',
        officialPriceNtd: 2_000_000, officialAreaPing: 10, imputation: null, reasons: [],
      },
    }),
  ];

  const result = estimateParking(subject, transactions, '2026-01-15');

  assert.equal(result?.stage, 'same-building');
  assert.deepEqual(result?.comparableIds, ['old-a', 'old-b', 'old-c']);
  assert.ok(!result?.comparableIds.includes('same-date'));
  assert.ok(!result?.comparableIds.includes('grade-b'));
  assert.ok(!result?.comparableIds.includes('grade-c'));
  assert.ok(!result?.comparableIds.includes('mechanical'));
});

test('falls back to nearby same-type, same-family direct records and requires three', () => {
  const nearby = [
    directParkingTransaction('near-c', {
      originalAddress: '台北市信義區測試路2號',
      location: { ...directParkingTransaction('copy').location, coordinate: coordinateAt(450), matchedAddress: '台北市信義區測試路2號' },
    }),
    directParkingTransaction('near-a', {
      originalAddress: '台北市信義區測試路3號',
      location: { ...directParkingTransaction('copy').location, coordinate: coordinateAt(100), matchedAddress: '台北市信義區測試路3號' },
    }),
    directParkingTransaction('near-b', {
      originalAddress: '台北市信義區測試路4號',
      location: { ...directParkingTransaction('copy').location, coordinate: coordinateAt(250), matchedAddress: '台北市信義區測試路4號' },
    }),
    directParkingTransaction('far', {
      originalAddress: '台北市信義區測試路5號',
      location: { ...directParkingTransaction('copy').location, coordinate: coordinateAt(550), matchedAddress: '台北市信義區測試路5號' },
    }),
  ];

  const fallback = estimateParking(subject, nearby, '2026-01-15');
  assert.equal(fallback?.stage, 'nearby-500m');
  assert.deepEqual(fallback?.comparableIds, ['near-a', 'near-b', 'near-c']);
  assert.equal(estimateParking(subject, nearby.slice(0, 2), '2026-01-15'), null);
});

test('combines each valid building observation with each valid parking pair', () => {
  const bundle = bundleValueQuantiles(40, [
    { id: 'u1', unitPriceWan: 80, weight: 1 },
    { id: 'u2', unitPriceWan: 100, weight: 1 },
  ], [
    { id: 'p1', priceNtd: 2_000_000, areaPing: 10, weight: 1 },
    { id: 'p2', priceNtd: 3_000_000, areaPing: 12, weight: 1 },
  ]);

  assert.ok(bundle);
  assert.ok(bundle.p25Ntd <= bundle.p50Ntd);
  assert.ok(bundle.p50Ntd <= bundle.p75Ntd);
  assert.equal(bundle.observationCount, 4);
});

test('caps bundle inputs at the fifty highest-weight observations per side', () => {
  const buildingObservations = Array.from({ length: 51 }, (_, index) => ({
    id: `b-${String(index).padStart(2, '0')}`,
    unitPriceWan: 80 + index,
    weight: 1,
  }));
  const parkingPairs = Array.from({ length: 51 }, (_, index) => ({
    id: `p-${String(index).padStart(2, '0')}`,
    priceNtd: 2_000_000 + index,
    areaPing: 10,
    weight: 1,
  }));

  const bundle = bundleValueQuantiles(40, buildingObservations, parkingPairs);

  assert.ok(bundle);
  assert.equal(bundle.observationCount, 2_500);
});
