import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { attachMarketEstimates } from '../steps.ts';
import type { PreMarketEnrichedListing } from '../types.ts';
import type { MarketDataBundle } from './types.ts';

const AS_OF = '2026-07-25';
const bundle = JSON.parse(
  readFileSync(new URL('./fixtures/enriched-market-index.json', import.meta.url), 'utf8'),
) as MarketDataBundle;

function listing(overrides: Partial<PreMarketEnrichedListing> = {}): PreMarketEnrichedListing {
  return {
    id: 1,
    title: '測試華廈',
    url: null,
    addressOrArea: '台北市中正區測試路1號',
    nearbyStation: null,
    coordinate: { lat: 25.033964, lng: 121.564468 },
    publishedDate: null,
    totalPrice: '3000萬',
    totalPing: '30坪',
    unitPrice: '100萬/坪',
    floor: '5',
    totalFloors: '10',
    typeLayout: '3房2廳',
    age: '15',
    parking: '無車位',
    realPriceUrl: null,
    listingHistory: [],
    source: null,
    sourceLink: null,
    room: 3,
    livingRoom: 2,
    bathroom: 2,
    queryHouseType: '17',
    buildingType: 'midrise',
    totalPriceWan: 3000,
    totalPriceNtd: 30_000_000,
    totalPingNum: 30,
    unitPriceWan: 100,
    ageNum: 15,
    monthlyMortgage: 96_000,
    district: '中正區',
    walk: null,
    withinWalk: null,
    regionGate: 'review',
    reliability: { coordPresent: true, coordConsistent: true, routeOk: null, ratio: null, reason: null },
    signals: { auctionKeyword: false },
    hardExclusion: { excluded: false, reasons: [] },
    tenure: { firstListedDate: null, daysOnMarket: null, recordCount: 0, sourceCount: 0, priceTrend: 'unknown', firstPrice: null, latestPrice: null },
    ...overrides,
  };
}

test('enrich attaches an auditable market estimate once per typed listing', () => {
  const [result] = attachMarketEstimates([listing()], bundle, AS_OF);

  assert.equal(result.marketEstimate.status, 'reliable');
  assert.equal(result.marketEstimate.comparables.length, 5);
  assert.equal(result.marketEstimate.selectedStage, 1);
  assert.equal(result.marketEstimate.subjectOwnershipEvidence, 'profile-default-freehold');
});

test('untyped, unreliable GPS, and inseparable listing parking stay unavailable or review', () => {
  const untyped = attachMarketEstimates([listing({ queryHouseType: null, buildingType: null })], bundle, AS_OF)[0]!;
  const unreliable = attachMarketEstimates([
    listing({ reliability: { coordPresent: true, coordConsistent: false, routeOk: null, ratio: null, reason: 'district mismatch' } }),
  ], bundle, AS_OF)[0]!;
  const parking = attachMarketEstimates([listing({ parking: '平面車位' })], bundle, AS_OF)[0]!;

  assert.deepEqual(untyped.marketEstimate.unavailableReasons, ['listing-building-type-unavailable']);
  assert.deepEqual(unreliable.marketEstimate.unavailableReasons, ['listing-coordinate-unreliable']);
  assert.equal(parking.marketEstimate.status, 'review');
  assert.deepEqual(parking.marketEstimate.unavailableReasons, ['listing-parking-not-separable']);
});

test('explicit non-freehold title is retained as listing evidence', () => {
  const [result] = attachMarketEstimates([listing({ title: '地上權華廈' })], bundle, AS_OF);

  assert.equal(result.marketEstimate.subjectOwnershipEvidence, 'title-explicit-non-freehold');
  assert.equal(result.marketEstimate.status, 'unavailable');
  assert.ok(result.marketEstimate.unavailableReasons.includes('no-comparables'));
});

test('missing local market data leaves the independent enrichment record usable', () => {
  const [result] = attachMarketEstimates([listing()], null, AS_OF);

  assert.equal(result.marketEstimate.status, 'unavailable');
  assert.deepEqual(result.marketEstimate.unavailableReasons, ['market-data-unavailable']);
  assert.equal(result.walk, null);
  assert.equal(result.withinWalk, null);
});
