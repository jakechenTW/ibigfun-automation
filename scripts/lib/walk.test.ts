import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeWalk } from './walk.ts';
import type { OfflineEnriched } from './enrich-offline.ts';
import type { MrtExit, NearestExit } from './mrt.ts';

const exit = (nameZh: string, exitId: string): MrtExit => ({
  stationId: 'S', line: 'L', nameZh, exitId, lat: 25, lng: 121,
});
const cand = (nameZh: string, exitId: string, straightM: number): NearestExit => ({
  exit: exit(nameZh, exitId), distanceM: straightM,
});

function offline(over: Partial<OfflineEnriched>): OfflineEnriched {
  return {
    title: '美寓', url: null, addressOrArea: '台北市中正區X街', coordinate: { lat: 25, lng: 121 },
    publishedDate: null, totalPrice: '1000萬', totalPing: '20坪', unitPrice: '50萬/坪',
    floor: '3', totalFloors: '5', typeLayout: '公寓', age: '30', parking: '無車位', realPriceUrl: null,
    totalPriceWan: 1000, totalPriceNtd: 10_000_000, totalPingNum: 20, unitPriceWan: 50, ageNum: 30,
    monthlyMortgage: 32031, district: '中正區', coordConsistent: true,
    candidates: [cand('東門', '4', 600)], hasAuction: false, ...over,
  };
}

test('within 800m walk -> withinWalk true, not excluded', () => {
  const e = finalizeWalk(offline({}), [700]);
  assert.equal(e.withinWalk, true);
  assert.equal(e.walk?.stationZh, '東門');
  assert.equal(e.walk?.minutes, Math.round(700 / 80));
  assert.equal(e.hardExclusion.excluded, false);
});

test('over 800m walk -> withinWalk false and hard-excluded with reason', () => {
  const e = finalizeWalk(offline({ candidates: [cand('東門', '4', 800)] }), [1000]);
  assert.equal(e.withinWalk, false);
  assert.equal(e.hardExclusion.excluded, true);
  assert.match(e.hardExclusion.reasons.join(), /10-min walk/);
});

test('picks the shortest-walk candidate, not the straight-line nearest', () => {
  const o = offline({ candidates: [cand('A', '1', 500), cand('B', '2', 550)] });
  const e = finalizeWalk(o, [900, 650]); // straight-nearest A walks 900; B walks 650
  assert.equal(e.walk?.stationZh, 'B');
  assert.equal(e.withinWalk, true);
});

test('inconsistent coordinate -> withinWalk null (manual), no auto-exclude', () => {
  const e = finalizeWalk(offline({ coordConsistent: false }), [700]);
  assert.equal(e.withinWalk, null);
  assert.equal(e.reliability.reason, 'coordinate inconsistent with district');
  assert.equal(e.hardExclusion.excluded, false);
});

test('no coordinate -> withinWalk null, reason no coordinate', () => {
  const e = finalizeWalk(offline({ candidates: [], coordinate: null }), null);
  assert.equal(e.withinWalk, null);
  assert.equal(e.reliability.reason, 'no coordinate');
});

test('routing unavailable -> withinWalk null, routeOk false', () => {
  const e = finalizeWalk(offline({}), null);
  assert.equal(e.withinWalk, null);
  assert.equal(e.reliability.routeOk, false);
  assert.equal(e.reliability.reason, 'routing unavailable');
});

test('implausible routed/straight ratio -> not trusted (manual)', () => {
  const e = finalizeWalk(offline({ candidates: [cand('東門', '4', 100)] }), [500]); // ratio 5
  assert.equal(e.withinWalk, null);
  assert.equal(e.reliability.routeOk, false);
  assert.equal(e.reliability.reason, 'route ratio implausible');
});

test('auction keyword excludes even when within walk', () => {
  const e = finalizeWalk(offline({ hasAuction: true }), [600]);
  assert.equal(e.withinWalk, true);
  assert.equal(e.hardExclusion.excluded, true);
  assert.match(e.hardExclusion.reasons.join(), /auction/);
});
