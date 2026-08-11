import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDualRouteWalkLine,
  reliableOrsTrialWalk,
  selectRouteTrialListings,
  unavailableTrialWalk,
  valhallaTrialWalk,
} from './route-trial.ts';
import type { MrtExit } from './mrt.ts';
import type { RunRange } from './range.ts';
import type { EnrichResult, EnrichedListing, FetchResult, Listing } from './types.ts';

const range: RunRange = { from: '2026-08-10', to: '2026-08-10', label: '2026-08-10' };

const exits: MrtExit[] = [
  { stationId: 'G15', line: '松山新店線', nameZh: '松江南京', exitId: '4', lat: 25.056, lng: 121.537 },
  { stationId: 'G15', line: '松山新店線', nameZh: '松江南京', exitId: '3', lat: 25.057, lng: 121.538 },
];

function listing(index: number, overrides: Partial<Listing> = {}): Listing {
  return {
    title: `物件 ${index}`,
    url: `https://example.test/listing/${index}`,
    addressOrArea: '台北市中山區南京東路二段',
    nearbyStation: '松江南京',
    coordinate: { lat: 25.052 + index / 10_000, lng: 121.533 + index / 10_000 },
    publishedDate: '2026-08-10',
    totalPrice: '1500萬',
    totalPing: '30坪',
    unitPrice: '50萬/坪',
    floor: '3', totalFloors: '10', typeLayout: '華廈', age: '20', parking: '無車位',
    realPriceUrl: null, listingHistory: [], id: index === 2 ? null : 10_000 + index,
    source: '591', sourceLink: `https://example.test/listing/${index}`,
    room: 2, livingRoom: 1, bathroom: 1, queryHouseType: null, buildingType: null,
    ...overrides,
  };
}

function enriched(original: Listing): EnrichedListing {
  return {
    ...original,
    totalPriceWan: 1500, totalPriceNtd: 15_000_000, totalPingNum: 30, unitPriceWan: 50,
    ageNum: 20, monthlyMortgage: 48_000, district: '中山區', walk: null, withinWalk: null,
    regionGate: 'review',
    reliability: { coordPresent: true, coordConsistent: true, routeOk: null, ratio: null, reason: null },
    signals: { auctionKeyword: false }, hardExclusion: { excluded: false, reasons: [] },
    tenure: { firstListedDate: null, daysOnMarket: null, recordCount: 0, sourceCount: 0, priceTrend: 'unknown', firstPrice: null, latestPrice: null },
    tenureGate: 'review',
    marketEstimate: {
      status: 'unavailable', confidence: 'low', subjectOwnershipEvidence: 'unspecified',
      subjectLocationEvidence: null, marketUnitPriceMedian: null, marketUnitPriceP25: null,
      marketUnitPriceP75: null, selectedStage: null,
      sourceFreshness: {
        transactionCheckedAt: null, doorplateCheckedAt: null,
        transactionStale: false, doorplateStale: false,
      },
      unavailableReasons: ['fixture'], comparables: [], excludedCandidates: [],
    },
    marketScenarios: {
      registeredUse: { value: 'unknown', source: 'unknown', detail: null },
      parkingFamily: 'unknown', parkingCountAssumption: null,
      sourceFreshness: {
        transactionCheckedAt: null, doorplateCheckedAt: null,
        transactionStale: false, doorplateStale: false,
      },
      scenarios: [], reasons: ['fixture'],
    },
  };
}

function fixtures(): { fetched: FetchResult; enriched: EnrichResult } {
  const listings = [listing(0), listing(1), listing(2)];
  return {
    fetched: { from: range.from, to: range.to, fetchedAt: '2026-08-11T00:00:00.000Z', count: listings.length, listings },
    enriched: {
      from: range.from, to: range.to, enrichedAt: '2026-08-11T00:05:00.000Z', count: listings.length,
      withinWalkCount: 0, manualReviewCount: listings.length, hardExcludedCount: 0,
      tenureEligible: 0, tenureExpired: 0, tenureReview: listings.length,
      outOfRegionCount: 0, inRegionTooFarCount: 0, marketReliable: 0, marketReview: 0,
      marketUnavailable: listings.length, marketDataStale: 0, listings: listings.map(enriched),
    },
  };
}

test('selectRouteTrialListings preserves requested indexes and addresses null source IDs', () => {
  const { fetched, enriched } = fixtures();

  const selected = selectRouteTrialListings(
    { schemaVersion: 1, profileId: 'p', rangeLabel: range.label, listingIndexes: [2, 0] },
    'p', range, fetched, enriched, exits,
  );

  assert.deepEqual(selected.map((x) => x.listingIndex), [2, 0]);
  assert.equal(selected[0].listingId, null);
  assert.equal(selected[0].routeKey, '25.05220,121.53320|G15:4,G15:3');
  assert.notEqual(selected[0].offline, selected[0].original);
});

test('reliableOrsTrialWalk trusts only reliable ORS walk evidence and recomputes minutes', () => {
  const with720mWalk = {
    ...enriched(listing(0)),
    walk: { stationZh: '松江南京', line: '松山新店線', exitId: '4', distanceM: 720, minutes: 1 },
    reliability: { coordPresent: true, coordConsistent: true, routeOk: true, ratio: 1.2, reason: null },
  } as EnrichedListing;

  assert.deepEqual(reliableOrsTrialWalk(with720mWalk), {
    status: 'reliable', stationZh: '松江南京', exitId: '4', distanceM: 720, minutes: 9,
  });
  assert.deepEqual(reliableOrsTrialWalk({ ...with720mWalk, walk: null }), unavailableTrialWalk());
  assert.deepEqual(reliableOrsTrialWalk({
    ...with720mWalk,
    reliability: { ...with720mWalk.reliability, routeOk: false },
  }), unavailableTrialWalk());
  assert.deepEqual(reliableOrsTrialWalk({
    ...with720mWalk,
    reliability: { ...with720mWalk.reliability, coordConsistent: false },
  }), unavailableTrialWalk());
});

test('valhallaTrialWalk selects its own plausible exit and rejects unavailable routes', () => {
  const { fetched, enriched: enrichedResult } = fixtures();
  const [selection] = selectRouteTrialListings(
    { schemaVersion: 1, profileId: 'p', rangeLabel: range.label, listingIndexes: [0] },
    'p', range, fetched, enrichedResult, exits,
  );

  assert.deepEqual(valhallaTrialWalk(selection, [900, 780]), {
    status: 'reliable', stationZh: '松江南京', exitId: '3', distanceM: 780, minutes: 10,
  });
  assert.deepEqual(valhallaTrialWalk({ ...selection, routeKey: null }, [900, 780]), unavailableTrialWalk());
  assert.deepEqual(valhallaTrialWalk(selection, null), unavailableTrialWalk());
  assert.deepEqual(valhallaTrialWalk(selection, [null, null]), unavailableTrialWalk());
  assert.deepEqual(valhallaTrialWalk(selection, [10_000, 10_000]), unavailableTrialWalk());
});

test('formatDualRouteWalkLine renders only trial-facing walk evidence', () => {
  const comparison = {
    listingIndex: 0,
    listingId: 10000,
    ors: { status: 'reliable', stationZh: '松江南京', exitId: '4', distanceM: 720, minutes: 9 },
    valhalla: { status: 'reliable', stationZh: '松江南京', exitId: '3', distanceM: 780, minutes: 10 },
    error: 'transport failure with raw ID 123',
  } as const;

  assert.equal(
    formatDualRouteWalkLine(comparison, { lat: 25.1, lng: 121.5 }),
    '🚶 ORS 松江南京 4號出口・9分｜Valhalla 松江南京 3號出口・10分（試行）・[地圖](https://www.google.com/maps?q=25.1,121.5)',
  );
  assert.equal(formatDualRouteWalkLine(comparison, null), '🚶 無位置資訊');

  const blankExit = formatDualRouteWalkLine({
    ...comparison,
    ors: unavailableTrialWalk(),
    valhalla: { ...comparison.valhalla, exitId: '' },
  }, { lat: 25.1, lng: 121.5 });
  assert.equal(blankExit, '🚶 ORS 待確認｜Valhalla 松江南京・10分（試行）・[地圖](https://www.google.com/maps?q=25.1,121.5)');
  assert.doesNotMatch(blankExit, /720|780|10000|transport|reliable|unavailable/);
});

test('selectRouteTrialListings rejects malformed requests and misbound results', () => {
  const { fetched, enriched } = fixtures();
  const valid = { schemaVersion: 1, profileId: 'p', rangeLabel: range.label, listingIndexes: [0] };
  const invalidRequests: unknown[] = [
    { ...valid, schemaVersion: 2 },
    { ...valid, profileId: 'other' },
    { ...valid, rangeLabel: '2026-08-09' },
    { ...valid, listingIndexes: undefined },
    { ...valid, listingIndexes: '0' },
    { ...valid, listingIndexes: [0, 0] },
    { ...valid, listingIndexes: [-1] },
    { ...valid, listingIndexes: [0.5] },
    { ...valid, listingIndexes: [3] },
    { ...valid, listingIndexes: Array.from({ length: 26 }, (_, index) => index) },
  ];

  for (const request of invalidRequests) {
    assert.throws(() => selectRouteTrialListings(request, 'p', range, fetched, enriched, exits));
  }

  const mismatchedMetadata = { ...enriched, to: '2026-08-11' };
  assert.throws(() => selectRouteTrialListings(valid, 'p', range, fetched, mismatchedMetadata, exits));

  const mismatchedCount = { ...enriched, count: 2 };
  assert.throws(() => selectRouteTrialListings(valid, 'p', range, fetched, mismatchedCount, exits));

  const mismatchedArray = { ...enriched, listings: enriched.listings.slice(0, 2) };
  assert.throws(() => selectRouteTrialListings(valid, 'p', range, fetched, mismatchedArray, exits));

  const malformedEnrichedFields = [
    { walk: undefined },
    { walk: { stationZh: '松江南京', line: '松山新店線', exitId: '4', distanceM: '720', minutes: 9 } },
    { reliability: undefined },
    { reliability: { coordPresent: true, coordConsistent: true, routeOk: 'true', ratio: 1.2, reason: null } },
  ];
  for (const malformed of malformedEnrichedFields) {
    const malformedResult = {
      ...enriched,
      listings: enriched.listings.map((item, index) => index === 0 ? { ...item, ...malformed } : item),
    };
    assert.throws(() => selectRouteTrialListings(valid, 'p', range, fetched, malformedResult, exits));
  }

  const driftedFields = [
    { id: 99999 },
    { title: 'different title' },
    { url: 'https://example.test/different' },
    { coordinate: { lat: 25.1, lng: 121.5 } },
  ];
  for (const drift of driftedFields) {
    const identityDrift = {
      ...enriched,
      listings: enriched.listings.map((item, index) => index === 0 ? { ...item, ...drift } : item),
    };
    assert.throws(() => selectRouteTrialListings(valid, 'p', range, fetched, identityDrift, exits));
  }
});
