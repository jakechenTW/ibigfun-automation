import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichOffline, CANDIDATE_EXITS } from './enrich-offline.ts';
import type { MrtExit } from './mrt.ts';
import type { Listing } from './types.ts';

const EXITS: MrtExit[] = [
  { stationId: 'O06', line: '松山新店線', nameZh: '東門', exitId: '4', lat: 25.0335, lng: 121.5285 },
  { stationId: 'G09', line: '松山新店線', nameZh: '小南門', exitId: '3', lat: 25.0353, lng: 121.5108 },
  { stationId: 'R08', line: '淡水信義線', nameZh: '中正紀念堂', exitId: '2', lat: 25.0325, lng: 121.5183 },
  { stationId: 'BL10', line: '板南線', nameZh: '善導寺', exitId: '5', lat: 25.0447, lng: 121.5236 },
];

function listing(over: Partial<Listing>): Listing {
  return {
    title: '美寓', url: null, addressOrArea: '台北市中正區金山南路一段', nearbyStation: null, coordinate: { lat: 25.033, lng: 121.522 },
    publishedDate: null, totalPrice: '1000萬', totalPing: '20坪', unitPrice: '50萬/坪',
    floor: '3', totalFloors: '5', typeLayout: '公寓', age: '30', parking: '無車位', realPriceUrl: null, ...over,
  };
}

test('parses numbers, mortgage, district, and picks K candidate exits', () => {
  const o = enrichOffline(listing({}), EXITS);
  assert.equal(o.totalPriceNtd, 10_000_000);
  assert.ok(Math.abs((o.monthlyMortgage ?? 0) - 32031) < 5);
  assert.equal(o.district, '中正區');
  assert.equal(o.coordConsistent, true);
  assert.equal(o.candidates.length, Math.min(CANDIDATE_EXITS, EXITS.length));
  assert.ok(o.candidates[0].distanceM <= o.candidates[1].distanceM); // sorted
  assert.equal(o.hasAuction, false);
});

test('no coordinate -> no candidates, consistency unknown', () => {
  const o = enrichOffline(listing({ coordinate: null }), EXITS);
  assert.equal(o.candidates.length, 0);
  assert.equal(o.coordConsistent, null);
});

test('auction keyword in title is flagged', () => {
  const o = enrichOffline(listing({ title: '法拍美寓' }), EXITS);
  assert.equal(o.hasAuction, true);
});
