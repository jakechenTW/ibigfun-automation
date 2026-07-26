import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridKey } from './grid.ts';
import { estimateMarket } from './estimator.ts';
import type { MarketSubject, MarketTransaction, SourceFreshness, TransactionIndex } from './types.ts';

const AS_OF = '2026-07-25';
const coordinate = { lat: 25.033964, lng: 121.564468 };

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

function transaction(id: string, price: number): MarketTransaction {
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
    buildingPriceNtd: price * 300_000,
    buildingAreaPing: 30,
    parkingPriceNtd: 0,
    parkingAreaPing: 0,
    buildingUnitPriceWan: price,
    floor: 5,
    totalFloors: 10,
    floorGroup: 'middle',
    completionDate: '2011-01-01',
    notes: '',
    exclusionFlags: [],
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

test('median qualifies but P25 crossing threshold stays reviewable', () => {
  const estimate = estimateMarket({ ...subject, askingUnitPriceWan: 105 }, indexWithPrices([90, 100, 100, 110, 120]), fresh, AS_OF);
  assert.equal(estimate.askingPremiumMedian, 5);
  assert.ok((estimate.askingPremiumConservative ?? 0) > estimate.askingPremiumMedian!);
  assert.equal(estimate.status, 'reliable');
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
  assert.equal(hiddenOutcome.askingPremiumMedian, null);
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
