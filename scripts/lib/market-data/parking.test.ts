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
    buildingUnitPriceBoundsWan: null,
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
    transferredParkingCount: 1,
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

test('excludes later-than-as-of records and honors the exact 36-calendar-month cutoff', () => {
  const transactions = [
    directParkingTransaction('at-cutoff', { transactionDate: '2023-01-15' }),
    directParkingTransaction('recent-a', { transactionDate: '2025-10-14' }),
    directParkingTransaction('recent-b', { transactionDate: '2025-11-14' }),
    directParkingTransaction('too-old', { transactionDate: '2023-01-14' }),
    directParkingTransaction('same-date', { transactionDate: '2026-01-15' }),
    directParkingTransaction('later-date', { transactionDate: '2026-01-16' }),
  ];

  const result = estimateParking(subject, transactions, '2026-01-15');

  assert.deepEqual(result?.comparableIds, ['at-cutoff', 'recent-a', 'recent-b']);
});

test('keeps exact-building evidence ahead of otherwise viable nearby evidence', () => {
  const exact = ['exact-a', 'exact-b', 'exact-c'].map((id) => directParkingTransaction(id));
  const nearby = [100, 200, 300].map((distanceM, index) => directParkingTransaction(`near-${index}`, {
    originalAddress: `台北市信義區測試路${index + 2}號`,
    location: {
      ...directParkingTransaction('copy').location,
      coordinate: coordinateAt(distanceM),
      matchedAddress: `台北市信義區測試路${index + 2}號`,
    },
  }));

  const result = estimateParking(subject, [...nearby, ...exact], '2026-01-15');

  assert.equal(result?.stage, 'same-building');
  assert.deepEqual(result?.comparableIds, ['exact-a', 'exact-b', 'exact-c']);
});

test('nearby fallback rejects a wrong building type or parking family', () => {
  const nearby = [100, 200, 300].map((distanceM, index) => directParkingTransaction(`near-${index}`, {
    originalAddress: `台北市信義區測試路${index + 2}號`,
    location: {
      ...directParkingTransaction('copy').location,
      coordinate: coordinateAt(distanceM),
      matchedAddress: `台北市信義區測試路${index + 2}號`,
    },
  }));
  const result = estimateParking(subject, [
    ...nearby,
    directParkingTransaction('wrong-type', {
      buildingType: 'midrise',
      location: { ...directParkingTransaction('copy').location, coordinate: coordinateAt(100), matchedAddress: '台北市信義區測試路10號' },
    }),
    directParkingTransaction('wrong-family', {
      location: { ...directParkingTransaction('copy').location, coordinate: coordinateAt(100), matchedAddress: '台北市信義區測試路11號' },
      parkingEvidence: {
        grade: 'A', family: 'mechanical', originalType: '升降機械',
        officialPriceNtd: 2_000_000, officialAreaPing: 10, imputation: null, reasons: [],
      },
    }),
  ], '2026-01-15');

  assert.deepEqual(result?.comparableIds, ['near-0', 'near-1', 'near-2']);
});

test('nearby evidence uses conservative address-range distance, precision, and time bands', () => {
  const stable = [100, 200, 250].map((distanceM, index) => directParkingTransaction(`stable-${index}`, {
    originalAddress: `台北市信義區測試路${index + 2}號`,
    location: {
      ...directParkingTransaction('copy').location,
      coordinate: coordinateAt(distanceM),
      matchedAddress: `台北市信義區測試路${index + 2}號`,
    },
  }));
  const rangeWeighted = directParkingTransaction('range-weighted', {
    transactionDate: '2025-01-14',
    originalAddress: '台北市信義區測試路8號',
    location: {
      ...directParkingTransaction('copy').location,
      method: 'address-range',
      coordinate: coordinateAt(280),
      matchedAddress: '台北市信義區測試路8號',
      uncertaintyMeters: 50,
      confidence: 'medium',
    },
  });
  const rangeOutside = directParkingTransaction('range-outside', {
    originalAddress: '台北市信義區測試路9號',
    location: {
      ...directParkingTransaction('copy').location,
      method: 'address-range',
      coordinate: coordinateAt(450),
      matchedAddress: '台北市信義區測試路9號',
      uncertaintyMeters: 100,
      confidence: 'medium',
    },
  });

  const result = estimateParking(subject, [...stable, rangeWeighted, rangeOutside], '2026-01-15');

  assert.equal(result?.stage, 'nearby-500m');
  assert.ok(!result?.comparableIds.includes('range-outside'));
  assert.ok(Math.abs((result?.directPairs.find((pair) => pair.id === 'range-weighted')?.weight ?? 0) - (7 / 15)) < 1e-12);
});

test('does not train on grade-A evidence with non-positive official parking pairs', () => {
  const result = estimateParking(subject, [
    directParkingTransaction('valid-a'),
    directParkingTransaction('valid-b'),
    directParkingTransaction('valid-c'),
    directParkingTransaction('zero-price', {
      parkingEvidence: {
        grade: 'A', family: 'flat', originalType: '坡道平面',
        officialPriceNtd: 0, officialAreaPing: 10, imputation: null, reasons: [],
      },
    }),
    directParkingTransaction('zero-area', {
      parkingEvidence: {
        grade: 'A', family: 'flat', originalType: '坡道平面',
        officialPriceNtd: 2_000_000, officialAreaPing: 0, imputation: null, reasons: [],
      },
    }),
  ], '2026-01-15');

  assert.deepEqual(result?.comparableIds, ['valid-a', 'valid-b', 'valid-c']);
});

test('trains only on structurally sound single-building single-space grade-A pairs', () => {
  const result = estimateParking(subject, [
    directParkingTransaction('valid-a'),
    directParkingTransaction('valid-b'),
    directParkingTransaction('valid-c'),
    directParkingTransaction('multiple-buildings', { transferredBuildingCount: 2 }),
    directParkingTransaction('multiple-spaces', {
      transferredParkingCount: 2,
      parkingEvidence: {
        grade: 'A', family: 'flat', originalType: '坡道平面',
        officialPriceNtd: 4_000_000, officialAreaPing: 20, imputation: null, reasons: [],
      },
    }),
    directParkingTransaction('unknown-space-count', { transferredParkingCount: null }),
  ], '2026-01-15');

  assert.deepEqual(result?.comparableIds, ['valid-a', 'valid-b', 'valid-c']);
});

test('selects a real joint price-area pair instead of combining independent marginal medians', () => {
  const candidates = [
    directParkingTransaction('joint-a', {
      parkingEvidence: {
        grade: 'A', family: 'flat', originalType: '坡道平面',
        officialPriceNtd: 1_000_000, officialAreaPing: 30, imputation: null, reasons: [],
      },
    }),
    directParkingTransaction('joint-b', {
      parkingEvidence: {
        grade: 'A', family: 'flat', originalType: '坡道平面',
        officialPriceNtd: 2_000_000, officialAreaPing: 10, imputation: null, reasons: [],
      },
    }),
    directParkingTransaction('joint-c', {
      parkingEvidence: {
        grade: 'A', family: 'flat', originalType: '坡道平面',
        officialPriceNtd: 3_000_000, officialAreaPing: 20, imputation: null, reasons: [],
      },
    }),
  ];

  const result = estimateParking(subject, candidates, '2026-01-15');

  assert.ok(result);
  assert.ok(result.directPairs.some((pair) =>
    pair.priceNtd === result.priceP50Ntd && pair.areaPing === result.areaP50Ping));
  assert.deepEqual(result.pairP50, {
    priceNtd: result.priceP50Ntd,
    areaPing: result.areaP50Ping,
  });
});

test('conditions the joint parking observation on an official known component', () => {
  const candidates = [
    directParkingTransaction('known-a', {
      parkingEvidence: {
        grade: 'A', family: 'flat', originalType: '坡道平面',
        officialPriceNtd: 1_000_000, officialAreaPing: 30, imputation: null, reasons: [],
      },
    }),
    directParkingTransaction('known-b', {
      parkingEvidence: {
        grade: 'A', family: 'flat', originalType: '坡道平面',
        officialPriceNtd: 2_000_000, officialAreaPing: 10, imputation: null, reasons: [],
      },
    }),
    directParkingTransaction('known-c', {
      parkingEvidence: {
        grade: 'A', family: 'flat', originalType: '坡道平面',
        officialPriceNtd: 3_000_000, officialAreaPing: 20, imputation: null, reasons: [],
      },
    }),
  ];

  const result = estimateParking({ ...subject, knownPriceNtd: 3_000_000 }, candidates, '2026-01-15');

  assert.deepEqual(result?.pairP50, { priceNtd: 3_000_000, areaPing: 20 });
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
  assert.equal(bundle.p25Ntd, 25_700_000);
  assert.equal(bundle.p50Ntd, 28_500_000);
  assert.equal(bundle.p75Ntd, 31_500_000);
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

test('filters bundle observations with invalid net area, value, or weight', () => {
  const bundle = bundleValueQuantiles(40, [
    { id: 'valid-building', unitPriceWan: 80, weight: 1 },
    { id: 'zero-value', unitPriceWan: 0, weight: 1 },
    { id: 'overflow-value', unitPriceWan: Number.MAX_VALUE, weight: 1 },
    { id: 'zero-weight-building', unitPriceWan: 80, weight: 0 },
  ], [
    { id: 'valid-pair', priceNtd: 2_000_000, areaPing: 10, weight: 1 },
    { id: 'no-net-area', priceNtd: 2_000_000, areaPing: 40, weight: 1 },
    { id: 'zero-weight-pair', priceNtd: 2_000_000, areaPing: 10, weight: 0 },
  ]);

  assert.deepEqual(bundle, {
    p25Ntd: 26_000_000,
    p50Ntd: 26_000_000,
    p75Ntd: 26_000_000,
    observationCount: 1,
  });
});

test('breaks 50-record cap ties by ID before forming bundle quantiles', () => {
  const buildings = [
    { id: 'z-tie', unitPriceWan: 125, weight: 1 },
    ...Array.from({ length: 50 }, (_, index) => ({
      id: `a-${String(index).padStart(2, '0')}`,
      unitPriceWan: 100 + index,
      weight: 1,
    })),
  ];
  const bundle = bundleValueQuantiles(40, buildings, [
    { id: 'pair', priceNtd: 2_000_000, areaPing: 10, weight: 1 },
  ]);

  assert.deepEqual(bundle, {
    p25Ntd: 35_600_000,
    p50Ntd: 39_350_000,
    p75Ntd: 43_100_000,
    observationCount: 50,
  });
});
