import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXPERIMENTAL_48_MONTH_POLICY } from './config.ts';
import { selectComparables } from './selector.ts';
import type { LocationEvidence, MarketSubject, MarketTransaction } from './types.ts';

const AS_OF = '2026-07-25';
const SUBJECT_COORDINATE = { lat: 25.033964, lng: 121.564468 };
const METERS_PER_LNG = 111_320 * Math.cos(SUBJECT_COORDINATE.lat * Math.PI / 180);

function coordinateAt(distanceM: number): { lat: number; lng: number } {
  return { lat: SUBJECT_COORDINATE.lat, lng: SUBJECT_COORDINATE.lng + distanceM / METERS_PER_LNG };
}

function location(distanceM: number, overrides: Partial<LocationEvidence> = {}): LocationEvidence {
  return {
    method: 'exact-doorplate',
    coordinate: coordinateAt(distanceM),
    normalizedAddress: '台北市中正區測試路1號',
    matchedAddress: '台北市中正區測試路1號',
    uncertaintyMeters: 0,
    confidence: 'high',
    datasetVersion: 'fixture',
    ...overrides,
  };
}

const subject: MarketSubject = {
  listingId: 1,
  coordinate: SUBJECT_COORDINATE,
  district: '中正區',
  ownership: 'freehold',
  buildingType: 'midrise',
  buildingAreaPing: 30,
  askingUnitPriceWan: 105,
  floor: 5,
  totalFloors: 10,
  floorGroup: 'middle',
  ageYears: 15,
  parkingSeparable: true,
};

function transaction(id: string, overrides: Partial<MarketTransaction> = {}): MarketTransaction {
  return {
    id,
    transactionDate: '2026-01-25',
    sourceVersion: 'fixture',
    originalAddress: '台北市中正區測試路1號',
    location: location(200),
    district: '中正區',
    ownership: 'freehold',
    buildingType: 'midrise',
    totalPriceNtd: 30_000_000,
    buildingPriceNtd: 30_000_000,
    buildingAreaPing: 30,
    parkingPriceNtd: 0,
    parkingAreaPing: 0,
    buildingUnitPriceWan: 100,
    floor: 5,
    totalFloors: 10,
    floorGroup: 'middle',
    completionDate: '2011-01-01',
    notes: '',
    exclusionFlags: [],
    eligibility: 'reliable-eligible',
    eligibilityReasons: [],
    primaryUse: 'residential',
    transferredBuildingCount: 1,
    ...overrides,
  };
}

test('segregates otherwise matching review-only evidence from reliable comparables', () => {
  const result = selectComparables(subject, [
    transaction('reliable', { eligibility: 'reliable-eligible' }),
    transaction('mixed', { eligibility: 'review-only' }),
  ], AS_OF);

  assert.deepEqual(result.included.map((item) => item.transaction.id), ['reliable']);
  assert.deepEqual(result.reviewOnly.map((item) => item.transaction.id), ['mixed']);
  assert.ok(result.reviewOnly[0]?.reasons.includes('review-only-evidence'));
});

test('uses a 48-month stage only when that experimental policy is supplied', () => {
  const olderComparable = transaction('forty-two-months-old', { transactionDate: '2023-01-25' });

  const baseline = selectComparables(subject, [olderComparable], AS_OF);
  const experimental = selectComparables(subject, [olderComparable], AS_OF, EXPERIMENTAL_48_MONTH_POLICY);

  assert.equal(baseline.included.length, 0);
  assert.deepEqual(experimental.included.map((item) => item.transaction.id), ['forty-two-months-old']);
  assert.equal(experimental.selectedStage, 6);
});

test('stops at the first stage with three comparables', () => {
  const result = selectComparables(subject, [
    transaction('near-a'),
    transaction('near-b', { location: location(250) }),
    transaction('expanded-radius', { location: location(400) }),
    transaction('later-stage', { transactionDate: '2024-12-25' }),
  ], AS_OF);

  assert.equal(result.selectedStage, 2);
  assert.equal(result.included.length, 3);
  assert.ok(result.included.every((candidate) => candidate.distanceMaxM <= 500));
  assert.ok(result.excluded.some((candidate) => candidate.transaction.id === 'later-stage'));
});

test('apartment age never excludes or downweights', () => {
  const apartmentSubject: MarketSubject = {
    ...subject,
    buildingType: 'apartment',
    floor: 4,
    totalFloors: 5,
    floorGroup: 'middle',
    ageYears: 5,
  };
  const oldApartment = transaction('old-apartment', {
    buildingType: 'apartment',
    floor: 4,
    totalFloors: 5,
    floorGroup: 'middle',
    completionDate: '1950-01-01',
  });

  const result = selectComparables(apartmentSubject, [oldApartment], AS_OF);
  assert.equal(result.candidates[0]?.weight.buildingAge, 1);
  assert.equal(result.included.length, 1);
});

test('first floor never relaxes into low floor', () => {
  const firstFloorSubject = { ...subject, floor: 1, floorGroup: 'first' as const };
  const secondFloor = transaction('second-floor', { floor: 2, floorGroup: 'low' });

  const result = selectComparables(firstFloorSubject, [secondFloor], AS_OF);
  assert.equal(result.included.length, 0);
  assert.ok(result.excluded[0]?.reasons.includes('floor-group-mismatch'));
});

test('hard gates reject another district, type, ownership, invalid price, and transactions over 36 months old', () => {
  const result = selectComparables(subject, [
    transaction('district', { district: '大安區' }),
    transaction('type', { buildingType: 'highrise' }),
    transaction('ownership', { ownership: 'non-freehold' }),
    transaction('price', { buildingUnitPriceWan: 0 }),
    transaction('too-old', { transactionDate: '2023-06-24' }),
  ], AS_OF);

  const reasons = new Map(result.excluded.map((candidate) => [candidate.transaction.id, candidate.reasons]));
  assert.ok(reasons.get('district')?.includes('district-mismatch'));
  assert.ok(reasons.get('type')?.includes('building-type-mismatch'));
  assert.ok(reasons.get('ownership')?.includes('ownership-mismatch'));
  assert.ok(reasons.get('price')?.includes('invalid-building-unit-price'));
  assert.ok(reasons.get('too-old')?.includes('transaction-too-old'));
});

test('uses a range minimum distance for eligibility and maximum distance for weight', () => {
  const result = selectComparables(subject, [transaction('range', {
    location: location(400, { method: 'address-range', uncertaintyMeters: 400, confidence: 'medium' }),
  })], AS_OF);

  const candidate = result.included[0];
  assert.ok(candidate);
  assert.ok(candidate.distanceMinM < 300);
  assert.ok(candidate.distanceMaxM > 500);
  assert.equal(candidate.weight.distance, 0.5);
  assert.equal(candidate.weight.locationPrecision, 0.5);
});

test('applies every approved relaxation weight and lower time weight after twelve months', () => {
  const result = selectComparables(subject, [transaction('relaxed', {
    transactionDate: '2025-01-24',
    location: location(550, { method: 'address-range', uncertaintyMeters: 40, confidence: 'medium' }),
    buildingAreaPing: 38,
    floor: 8,
    floorGroup: 'high',
    completionDate: '1998-01-01',
  })], AS_OF);

  const candidate = result.included[0];
  assert.ok(candidate);
  assert.equal(result.selectedStage, 5);
  assert.equal(candidate.weight.distance, 0.5);
  assert.equal(candidate.weight.time, 0.7);
  assert.equal(candidate.weight.locationPrecision, 1 / 1.1);
  assert.equal(candidate.weight.area, 0.85);
  assert.equal(candidate.weight.buildingAge, 0.85);
  assert.equal(candidate.weight.floor, 0.7);
  assert.equal(candidate.weight.total, 0.5 * 0.7 * (1 / 1.1) * 0.85 * 0.85 * 0.7);
});

test('uses the exact twelve-month calendar cutoff for stage eligibility and time weight', () => {
  const cases = [
    { date: '2025-07-24', stage: 3, time: 0.7 },
    { date: '2025-07-25', stage: 1, time: 1 },
    { date: '2025-07-26', stage: 1, time: 1 },
  ] as const;

  for (const { date, stage, time } of cases) {
    const result = selectComparables(subject, [
      transaction(`${date}-a`, { transactionDate: date }),
      transaction(`${date}-b`, { transactionDate: date }),
      transaction(`${date}-c`, { transactionDate: date }),
    ], AS_OF);
    assert.equal(result.selectedStage, stage, date);
    assert.ok(result.included.every((candidate) => candidate.weight.time === time), date);
  }
});

test('uses exact day boundaries at the twenty-four and thirty-six month cutoffs', () => {
  const cases = [
    { date: '2024-07-24', time: 0.4, included: true },
    { date: '2024-07-25', time: 0.7, included: true },
    { date: '2024-07-26', time: 0.7, included: true },
    { date: '2023-07-24', time: 0, included: false },
    { date: '2023-07-25', time: 0.4, included: true },
    { date: '2023-07-26', time: 0.4, included: true },
  ] as const;

  for (const expected of cases) {
    const result = selectComparables(subject, [transaction(expected.date, { transactionDate: expected.date })], AS_OF);
    assert.equal(result.candidates[0]?.weight.time, expected.time, expected.date);
    assert.equal(result.included.length === 1, expected.included, expected.date);
    if (!expected.included) {
      assert.ok(result.excluded[0]?.reasons.includes('transaction-too-old'), expected.date);
    }
  }
});

test('clamps leap-day calendar cutoffs to the last day of February', () => {
  const cases = [
    { date: '2023-02-27', time: 0.7, included: true },
    { date: '2023-02-28', time: 1, included: true },
    { date: '2023-03-01', time: 1, included: true },
    { date: '2022-02-27', time: 0.4, included: true },
    { date: '2022-02-28', time: 0.7, included: true },
    { date: '2022-03-01', time: 0.7, included: true },
    { date: '2021-02-27', time: 0, included: false },
    { date: '2021-02-28', time: 0.4, included: true },
    { date: '2021-03-01', time: 0.4, included: true },
  ] as const;

  for (const expected of cases) {
    const result = selectComparables(
      subject,
      [transaction(expected.date, { transactionDate: expected.date })],
      '2024-02-29',
    );
    assert.equal(result.candidates[0]?.weight.time, expected.time, expected.date);
    assert.equal(result.included.length === 1, expected.included, expected.date);
  }
});
