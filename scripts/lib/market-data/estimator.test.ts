import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridKey } from './grid.ts';
import { estimateMarket, estimateWeightedBuildingPrices } from './estimator.ts';
import { selectComparables } from './selector.ts';
import {
  EXPERIMENTAL_1000_METER_POLICY,
  EXPERIMENTAL_48_MONTH_POLICY,
} from './config.ts';
import type { MarketSubject, MarketTransaction, SourceFreshness, TransactionIndex } from './types.ts';

const AS_OF = '2026-07-25';
const coordinate = { lat: 25.033964, lng: 121.564468 };
const METERS_PER_LNG = 111_320 * Math.cos(coordinate.lat * Math.PI / 180);

function coordinateAt(distanceM: number): { lat: number; lng: number } {
  return { lat: coordinate.lat, lng: coordinate.lng + distanceM / METERS_PER_LNG };
}

const subject: MarketSubject = {
  listingId: 1,
  coordinate,
  district: '中正區',
  ownership: 'freehold',
  buildingType: 'midrise',
  buildingAreaPing: 30,
  askingUnitPriceWan: 100,
  floor: 5,
  totalFloors: 10,
  floorGroup: 'middle',
  ageYears: 15,
  parkingSeparable: true,
};

const fresh: SourceFreshness = {
  transactionCheckedAt: '2026-07-25T00:00:00.000Z',
  doorplateCheckedAt: '2026-07-25T00:00:00.000Z',
  transactionStale: false,
  doorplateStale: false,
};

function transaction(id: string, price: number, overrides: Partial<MarketTransaction> = {}): MarketTransaction {
  return {
    id,
    transactionDate: '2026-01-25',
    sourceVersion: 'fixture',
    originalAddress: '台北市中正區測試路1號',
    location: {
      method: 'exact-doorplate',
      coordinate,
      normalizedAddress: '台北市中正區測試路1號',
      matchedAddress: '台北市中正區測試路1號',
      uncertaintyMeters: 0,
      confidence: 'high',
      datasetVersion: 'fixture',
    },
    district: '中正區',
    ownership: 'freehold',
    buildingType: 'midrise',
    totalPriceNtd: price * 300_000,
    totalAreaPing: 30,
    buildingPriceNtd: price * 300_000,
    buildingAreaPing: 30,
    parkingPriceNtd: 0,
    parkingAreaPing: 0,
    buildingUnitPriceWan: price,
    buildingUnitPriceBoundsWan: null,
    floor: 5,
    totalFloors: 10,
    floorGroup: 'middle',
    completionDate: '2011-01-01',
    notes: '',
    exclusionFlags: [],
    eligibility: 'reliable-eligible',
    eligibilityReasons: [],
    originalPrimaryUse: '住家用',
    primaryUse: 'residential',
    transferredBuildingCount: 1,
    transferredParkingCount: 0,
    parkingEvidence: {
      grade: 'A', family: 'none', originalType: '無車位',
      officialPriceNtd: 0, officialAreaPing: 0, imputation: null, reasons: [],
    },
    ...overrides,
  };
}

function indexWithPrices(prices: number[]): TransactionIndex {
  return indexWithTransactions(prices.map((price, index) => transaction(`tx-${index}`, price)));
}

function indexWithTransactions(transactions: MarketTransaction[]): TransactionIndex {
  return {
    schemaVersion: 1,
    datasetVersion: 'fixture',
    builtAt: '2026-07-25T00:00:00.000Z',
    cells: { [gridKey(coordinate)]: transactions },
  };
}

test('reliable estimates expose quantile valuation evidence', () => {
  const estimate = estimateMarket({ ...subject, askingUnitPriceWan: 105 }, indexWithPrices([90, 100, 100, 110, 120]), fresh, AS_OF);
  assert.equal(estimate.marketUnitPriceP25, 97.5);
  assert.equal(estimate.marketUnitPriceMedian, 100);
  assert.equal(estimate.marketUnitPriceP75, 112.5);
  assert.equal(estimate.status, 'reliable');
});

test('market estimates expose only the allowed evidence fields', () => {
  const estimate = estimateMarket(subject, indexWithPrices([90, 100, 100, 110, 120]), fresh, AS_OF);

  assert.deepEqual(Object.keys(estimate).sort(), [
    'comparables',
    'confidence',
    'excludedCandidates',
    'marketUnitPriceMedian',
    'marketUnitPriceP25',
    'marketUnitPriceP75',
    'selectedStage',
    'sourceFreshness',
    'status',
    'subjectLocationEvidence',
    'subjectOwnershipEvidence',
    'unavailableReasons',
  ]);
});

test('wide IQR cannot be reliable', () => {
  const estimate = estimateMarket(subject, indexWithPrices([60, 80, 100, 130, 160]), fresh, AS_OF);
  assert.equal(estimate.status, 'review');
  assert.equal(estimate.confidence, 'low');
});

test('preserves outlier provenance after weighted MAD excludes an extreme price', () => {
  const estimate = estimateMarket(subject, indexWithPrices([99, 100, 101, 102, 1_000]), fresh, AS_OF);
  assert.equal(estimate.comparables.length, 4);
  const outlier = estimate.excludedCandidates.find((candidate) => candidate.transaction.id === 'tx-4');
  assert.ok(outlier?.reasons.includes('weighted-mad-outlier'));
});

test('listing-side hard conflicts make an otherwise supported estimate unavailable', () => {
  const estimate = estimateMarket({ ...subject, parkingSeparable: false }, indexWithPrices([100, 101, 102]), fresh, AS_OF);
  assert.equal(estimate.status, 'unavailable');
  assert.ok(estimate.unavailableReasons.includes('parking-not-separable'));
});

test('evaluation mode allows a missing asking price but not an invalid supplied asking price', () => {
  const hiddenOutcome = estimateMarket(
    { ...subject, askingUnitPriceWan: null }, indexWithPrices([100, 101, 102]), fresh, AS_OF,
    { allowMissingAskingUnitPrice: true },
  );
  const invalidAskingPrice = estimateMarket(
    { ...subject, askingUnitPriceWan: 0 }, indexWithPrices([100, 101, 102]), fresh, AS_OF,
    { allowMissingAskingUnitPrice: true },
  );

  assert.equal(hiddenOutcome.status, 'reliable');
  assert.equal(invalidAskingPrice.status, 'unavailable');
  assert.ok(invalidAskingPrice.unavailableReasons.includes('invalid-asking-unit-price'));
});

test('unreliable listing GPS makes the estimate unavailable without querying grid cells', () => {
  const estimate = estimateMarket({ ...subject, coordinate: { lat: Number.NaN, lng: coordinate.lng } }, indexWithPrices([100, 101, 102]), fresh, AS_OF);
  assert.equal(estimate.status, 'unavailable');
  assert.equal(estimate.comparables.length, 0);
  assert.ok(estimate.unavailableReasons.includes('location-unreliable'));
});

test('keeps an eligible address range beyond the final weighting band as excluded review evidence', () => {
  const uncertain = transaction('uncertain-range', 100);
  uncertain.location = {
    ...uncertain.location,
    method: 'address-range',
    coordinate: { lat: coordinate.lat, lng: coordinate.lng + 900 / (111_320 * Math.cos(coordinate.lat * Math.PI / 180)) },
    uncertaintyMeters: 200,
    confidence: 'medium',
  };
  const estimate = estimateMarket(subject, indexWithTransactions([uncertain]), fresh, AS_OF);

  assert.equal(estimate.status, 'unavailable');
  assert.equal(estimate.comparables.length, 0);
  const excluded = estimate.excludedCandidates.find((candidate) => candidate.transaction.id === 'uncertain-range');
  assert.ok(excluded?.reasons.includes('distance-max-outside-supported-weight'));
});

test('review-only transactions produce a review estimate without price statistics', () => {
  const estimate = estimateMarket(subject, indexWithTransactions([
    transaction('mixed-a', 99, { eligibility: 'review-only' }),
    transaction('mixed-b', 100, { eligibility: 'review-only' }),
    transaction('mixed-c', 101, { eligibility: 'review-only' }),
  ]), fresh, AS_OF);

  assert.equal(estimate.status, 'review');
  assert.equal(estimate.marketUnitPriceMedian, null);
  assert.equal(estimate.marketUnitPriceP25, null);
  assert.equal(estimate.marketUnitPriceP75, null);
  assert.deepEqual(estimate.unavailableReasons, ['review-only-comparables']);
});

test('48-month fallback produces a weighted estimate but never high confidence', () => {
  const oldTransactions = [98, 99, 100, 101, 102].map((price, index) =>
    transaction(`old-${index}`, price, { transactionDate: '2023-01-25' }),
  );

  const baseline = estimateMarket(subject, indexWithTransactions(oldTransactions), fresh, AS_OF);
  const experimental = estimateMarket(
    subject,
    indexWithTransactions(oldTransactions),
    fresh,
    AS_OF,
    { policy: EXPERIMENTAL_48_MONTH_POLICY },
  );

  assert.equal(baseline.marketUnitPriceMedian, null);
  assert.equal(experimental.marketUnitPriceMedian, 100);
  assert.ok(experimental.comparables.every((candidate) => candidate.weight.total > 0));
  assert.equal(experimental.selectedStage, 6);
  assert.equal(experimental.confidence, 'medium');
});

test('1000-meter fallback produces a weighted estimate while baseline excludes it', () => {
  const distantTransactions = [99, 100, 101].map((price, index) =>
    transaction(`distant-${index}`, price, {
      location: {
        ...transaction(`coordinate-${index}`, price).location,
        coordinate: coordinateAt(900),
      },
    }),
  );

  const baseline = estimateMarket(subject, indexWithTransactions(distantTransactions), fresh, AS_OF);
  const experimental = estimateMarket(
    subject,
    indexWithTransactions(distantTransactions),
    fresh,
    AS_OF,
    { policy: EXPERIMENTAL_1000_METER_POLICY },
  );

  assert.equal(baseline.marketUnitPriceMedian, null);
  assert.equal(experimental.marketUnitPriceMedian, 100);
  assert.ok(experimental.comparables.every((candidate) => candidate.weight.total > 0));
  assert.equal(experimental.selectedStage, 7);
  assert.equal(experimental.confidence, 'medium');
});

test('extended policy does not promote baseline fallback comparables to high confidence', () => {
  const baselineFallback = [98, 99, 100, 101, 102].map((price, index) =>
    transaction(`baseline-fallback-${index}`, price, {
      location: {
        ...transaction(`coordinate-${index}`, price).location,
        coordinate: coordinateAt(600),
      },
    }),
  );

  const baseline = estimateMarket(subject, indexWithTransactions(baselineFallback), fresh, AS_OF);
  const extended = estimateMarket(
    subject,
    indexWithTransactions(baselineFallback),
    fresh,
    AS_OF,
    { policy: EXPERIMENTAL_1000_METER_POLICY },
  );

  assert.equal(baseline.selectedStage, 5);
  assert.equal(baseline.confidence, 'medium');
  assert.equal(extended.selectedStage, 5);
  assert.equal(extended.confidence, 'medium');
});

test('reusable weighted building prices preserve MAD exclusions for scenario estimation', () => {
  const selection = selectComparables(
    subject,
    [99, 100, 101, 102, 1_000].map((price, index) => transaction(`weighted-${index}`, price)),
    AS_OF,
  );
  const estimate = estimateWeightedBuildingPrices(selection.included);

  assert.ok(estimate);
  assert.deepEqual(estimate.comparables.map((candidate) => candidate.transaction.id), [
    'weighted-0', 'weighted-1', 'weighted-2', 'weighted-3',
  ]);
  assert.equal(estimate.marketUnitPriceMedian, 100.5);
  assert.ok(estimate.excludedCandidates[0]?.reasons.includes('weighted-mad-outlier'));
});
