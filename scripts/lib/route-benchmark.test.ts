import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheKey, type RouteCache } from './route-cache.ts';
import { enrichOffline } from './enrich-offline.ts';
import { type MrtExit } from './mrt.ts';
import type { FetchResult, Listing } from './types.ts';
import {
  compareBenchmarkCase,
  failedBenchmarkCase,
  selectBenchmarkCases,
  summarizeBenchmark,
  type BenchmarkCase,
} from './route-benchmark.ts';

const exits: MrtExit[] = [
  { stationId: 'R10', line: 'R', nameZh: '甲站', exitId: '1', lat: 25.032, lng: 121.518 },
  { stationId: 'R10', line: 'R', nameZh: '甲站', exitId: '2', lat: 25.033, lng: 121.519 },
  { stationId: 'G05', line: 'G', nameZh: '乙站', exitId: '1', lat: 25.034, lng: 121.520 },
];

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    title: '測試物件',
    url: null,
    addressOrArea: '台北市中正區測試路1號',
    nearbyStation: null,
    coordinate: { lat: 25.0325, lng: 121.5185 },
    publishedDate: null,
    totalPrice: null,
    totalPing: null,
    unitPrice: null,
    floor: null,
    totalFloors: null,
    typeLayout: null,
    age: null,
    parking: null,
    realPriceUrl: null,
    listingHistory: [],
    id: 1,
    source: null,
    sourceLink: null,
    room: null,
    livingRoom: null,
    bathroom: null,
    queryHouseType: null,
    buildingType: null,
    ...overrides,
  };
}

function fetchResult(listings: Listing[]): FetchResult {
  return { from: '2026-08-01', to: '2026-08-01', fetchedAt: '2026-08-02T00:00:00Z', count: listings.length, listings };
}

function routeKeyFor(value: Listing): string {
  const enriched = enrichOffline(value, exits);
  assert.ok(value.coordinate);
  return cacheKey(value.coordinate, enriched.candidates);
}

test('selectBenchmarkCases orders eligible cases and deduplicates route keys before limiting', () => {
  // Would fail if date, numeric-ID/null-last, route-key ordering, deduplication, or limit order changed.
  const duplicateEarlier = listing({ id: 1 });
  const duplicateSameDay = listing({ id: 2 });
  const duplicateLater = listing({ id: 0 });
  const numeric = listing({ id: 3, coordinate: { lat: 25.0335, lng: 121.5195 } });
  const nullId = listing({ id: null, coordinate: { lat: 25.0345, lng: 121.5205 } });
  const routeCache: RouteCache = {
    [routeKeyFor(duplicateEarlier)]: [300, 350, 400],
    [routeKeyFor(numeric)]: [400, 450, 500],
    [routeKeyFor(nullId)]: [500, 550, 600],
  };

  const selection = selectBenchmarkCases([
    { date: '2026-08-02', result: fetchResult([duplicateLater]) },
    { date: '2026-08-01', result: fetchResult([nullId, duplicateSameDay, numeric, duplicateEarlier]) },
  ], exits, routeCache, 3);
  const limited = selectBenchmarkCases([
    { date: '2026-08-02', result: fetchResult([duplicateLater]) },
    { date: '2026-08-01', result: fetchResult([nullId, duplicateSameDay, numeric, duplicateEarlier]) },
  ], exits, routeCache, 2);

  assert.equal(selection.scanned, 5);
  assert.equal(selection.eligibleBeforeLimit, 3);
  assert.equal(selection.duplicateRouteKeys, 2);
  assert.deepEqual(selection.cases.map((item) => [item.date, item.listingId]), [
    ['2026-08-01', 1],
    ['2026-08-01', 3],
    ['2026-08-01', null],
  ]);
  assert.deepEqual(limited.cases.map((item) => [item.date, item.listingId]), [
    ['2026-08-01', 1],
    ['2026-08-01', 3],
  ]);
});

test('selectBenchmarkCases uses route key to break equal-date and equal-ID ties', () => {
  // Would fail if input order leaked through when the first two documented sort keys are equal.
  const lowerRouteKey = '25.03210,121.51810|R10:1,R10:2,G05:1';
  const upperRouteKey = '25.03390,121.51990|G05:1,R10:2,R10:1';
  const lower = listing({ id: 7, coordinate: { lat: 25.0321, lng: 121.5181 } });
  const upper = listing({ id: 7, coordinate: { lat: 25.0339, lng: 121.5199 } });
  const routeCache: RouteCache = {
    [lowerRouteKey]: [600, 700, 800],
    [upperRouteKey]: [610, 710, 810],
  };

  const selection = selectBenchmarkCases([
    { date: '2026-08-01', result: fetchResult([upper, lower]) },
  ], exits, routeCache, 25);

  assert.deepEqual(selection.cases.map((item) => item.routeKey), [lowerRouteKey, upperRouteKey]);
});

test('selectBenchmarkCases classifies eligibility failures and never mutates inputs', () => {
  // Would fail if the exact precedence or cache validation of selection changed, or it mutates historical inputs.
  const missingCoordinate = listing({ id: 1, coordinate: null });
  const conflict = listing({ id: 2, addressOrArea: '台北市北投區測試路1號' });
  const cacheMiss = listing({ id: 3, coordinate: { lat: 25.0335, lng: 121.5195 } });
  const wrongShape = listing({ id: 4, coordinate: { lat: 25.0345, lng: 121.5205 } });
  const noCandidates = listing({ id: 5 });
  const noExitKey = routeKeyFor(noCandidates);
  const routeCache: RouteCache = {
    [routeKeyFor(wrongShape)]: [500, 600],
    [noExitKey]: [],
  };
  const runs = [{ date: '2026-08-01', result: fetchResult([
    missingCoordinate, conflict, cacheMiss, wrongShape,
  ]) }];
  const listingsBefore = structuredClone(runs);
  const exitsBefore = structuredClone(exits);
  const cacheBefore = structuredClone(routeCache);

  const selection = selectBenchmarkCases(runs, exits, routeCache, 25);

  assert.equal(selection.scanned, 4);
  assert.deepEqual(selection.skipped, {
    'no-coordinate': 1,
    'coordinate-conflict': 1,
    'no-candidates': 0,
    'ors-cache-miss': 1,
    'ors-cache-shape': 1,
  });
  assert.equal(selection.cases.length, 0);
  assert.deepEqual(runs, listingsBefore);
  assert.deepEqual(exits, exitsBefore);
  assert.deepEqual(routeCache, cacheBefore);
});

test('selectBenchmarkCases counts listings without nearby MRT candidates', () => {
  // Would fail if coordinate-bearing listings with an empty exit dataset reached cache lookup.
  const selection = selectBenchmarkCases(
    [{ date: '2026-08-01', result: fetchResult([listing()]) }],
    [],
    {},
    25,
  );

  assert.deepEqual(selection.skipped, {
    'no-coordinate': 0,
    'coordinate-conflict': 0,
    'no-candidates': 1,
    'ors-cache-miss': 0,
    'ors-cache-shape': 0,
  });
});

function benchmarkCase(orsDistances: (number | null)[]): BenchmarkCase {
  return {
    date: '2026-08-01',
    listingId: 1,
    routeKey: 'test-route',
    origin: { lat: 25.032, lng: 121.518 },
    candidates: [
      { exit: exits[0], distanceM: 600 },
      { exit: exits[1], distanceM: 700 },
      { exit: exits[2], distanceM: 800 },
    ],
    orsDistances,
  };
}

test('compareBenchmarkCase compares independently picked routes and same-exit deltas', () => {
  // Would fail if either provider reused the other provider's selection, or delta math used the wrong baseline.
  const comparison = compareBenchmarkCase(benchmarkCase([680, 850, 1_000]), [800, 900, 1_100]);

  assert.equal(comparison.transition, 'true->true');
  assert.equal(comparison.nearestExitAgreement, true);
  assert.equal(comparison.boundaryCase, true);
  assert.equal(comparison.sameExitDeltaM, 120);
  assert.equal(comparison.sameExitDeltaPercent, 17.65);
});

test('compareBenchmarkCase records threshold flips and nearest-exit disagreement', () => {
  // Would fail if agreement ignores the selected exit or the 800m inclusive walk threshold changes.
  const comparison = compareBenchmarkCase(benchmarkCase([800, 850, 1_000]), [850, 700, 1_100]);

  assert.equal(comparison.transition, 'true->true');
  assert.equal(comparison.nearestExitAgreement, false);
  assert.equal(comparison.sameExitDeltaM, null);

  const flip = compareBenchmarkCase(benchmarkCase([800, 850, 1_000]), [801, 900, 1_100]);
  assert.equal(flip.transition, 'true->false');
});

test('compareBenchmarkCase distinguishes separate blank-ID exits with identical display labels', () => {
  // Would fail if agreement compared non-unique station/line/exit text instead of aligned candidate identity.
  const taipeiMainLikeExits: MrtExit[] = [
    { stationId: 'BL12', line: 'BL', nameZh: '台北車站', exitId: '', lat: 25.0461, lng: 121.5151 },
    { stationId: 'BL12', line: 'BL', nameZh: '台北車站', exitId: '', lat: 25.0471, lng: 121.5161 },
  ];
  const distinctRows: BenchmarkCase = {
    date: '2026-08-01',
    listingId: 1,
    routeKey: 'blank-id-distinct-rows',
    origin: { lat: 25.046, lng: 121.515 },
    candidates: [
      { exit: taipeiMainLikeExits[0], distanceM: 500 },
      { exit: taipeiMainLikeExits[1], distanceM: 600 },
    ],
    orsDistances: [600, 700],
  };

  const comparison = compareBenchmarkCase(distinctRows, [700, 650]);

  assert.equal(comparison.ors.walk?.stationZh, '台北車站');
  assert.equal(comparison.valhalla.walk?.stationZh, '台北車站');
  assert.equal(comparison.ors.walk?.exitId, '');
  assert.equal(comparison.valhalla.walk?.exitId, '');
  assert.equal(comparison.nearestExitAgreement, false);
  assert.equal(comparison.sameExitDeltaM, null);
  assert.equal(comparison.sameExitDeltaPercent, null);
});

test('compareBenchmarkCase excludes implausible routes and includes 700m and 900m boundaries', () => {
  // Would fail if the existing plausibility gate or inclusive boundary band is bypassed.
  const implausible = compareBenchmarkCase(benchmarkCase([700, 850, 1_000]), [1_600, 1_700, 1_800]);
  assert.equal(implausible.valhalla.withinWalk, null);
  assert.equal(implausible.nearestExitAgreement, null);

  const lowerBoundary = compareBenchmarkCase(benchmarkCase([700, 850, 1_000]), [950, 1_000, 1_100]);
  assert.equal(lowerBoundary.boundaryCase, true);
  const upperBoundary = compareBenchmarkCase(benchmarkCase([950, 1_000, 1_100]), [900, 1_000, 1_100]);
  assert.equal(upperBoundary.boundaryCase, true);
});

test('failedBenchmarkCase preserves the cached ORS pick and nulls Valhalla comparison fields', () => {
  // Would fail if a provider failure discarded already-cached ORS evidence.
  const comparison = failedBenchmarkCase(benchmarkCase([700, 850, 1_000]), 'Valhalla matrix timeout after 15000ms');

  assert.equal(comparison.error, 'Valhalla matrix timeout after 15000ms');
  assert.equal(comparison.ors.walk?.distanceM, 700);
  assert.equal(comparison.valhalla.walk, null);
  assert.equal(comparison.transition, 'true->null');
  assert.equal(comparison.nearestExitAgreement, null);
});

test('compareBenchmarkCase returns no percentage delta when the ORS distance is zero', () => {
  // Would fail if zero-distance input produces a finite percentage through the plausibility-gated picker.
  const comparison = compareBenchmarkCase(benchmarkCase([0, 850, 1_000]), [100, 900, 1_100]);

  assert.equal(comparison.sameExitDeltaPercent, null);
});

test('summarizeBenchmark counts comparisons and rounds absolute same-exit means', () => {
  // Would fail if failed calls count as completed, comparisons omit null-safe agreement metrics, or means are unrounded/signed.
  const first = compareBenchmarkCase(benchmarkCase([600, 850, 1_000]), [700, 900, 1_100]);
  const second = compareBenchmarkCase(benchmarkCase([800, 850, 1_000]), [750, 900, 1_100]);
  const failed = failedBenchmarkCase(benchmarkCase([700, 850, 1_000]), 'network unavailable');
  const selection = {
    scanned: 7,
    eligibleBeforeLimit: 4,
    duplicateRouteKeys: 2,
    skipped: {
      'no-coordinate': 1,
      'coordinate-conflict': 0,
      'no-candidates': 1,
      'ors-cache-miss': 1,
      'ors-cache-shape': 0,
    },
    cases: [first.benchmarkCase, second.benchmarkCase, failed.benchmarkCase],
  };

  const summary = summarizeBenchmark(selection, [first, second, failed]);

  assert.equal(summary.completed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.orsUsable, 3);
  assert.equal(summary.valhallaUsable, 2);
  assert.equal(summary.orsPlausible, 3);
  assert.equal(summary.valhallaPlausible, 2);
  assert.equal(summary.nearestExitAgreement, 2);
  assert.equal(summary.nearestExitCompared, 2);
  assert.equal(summary.withinWalkAgreement, 2);
  assert.equal(summary.withinWalkCompared, 2);
  assert.equal(summary.transitions['true->null'], 1);
  assert.equal(summary.boundaryCases, 3);
  assert.equal(summary.sameExitDeltaCount, 2);
  assert.equal(summary.sameExitMeanAbsoluteDeltaM, 75);
  assert.equal(summary.sameExitMeanAbsoluteDeltaPercent, 11.46);
});
