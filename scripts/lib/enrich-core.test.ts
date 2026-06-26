import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichListing } from './enrich-core.ts';
import type { MrtExit } from './mrt.ts';
import type { Listing } from './types.ts';

const EXITS: MrtExit[] = [
  { stationId: 'R10', line: '淡水信義線', nameZh: '台北車站', exitId: '2', lat: 25.047, lng: 121.517 },
];

function listing(over: Partial<Listing>): Listing {
  return {
    title: '美寓', url: null, addressOrArea: null, coordinate: null, publishedDate: null,
    totalPrice: '1000萬', totalPing: '20坪', unitPrice: '50萬/坪', floor: '3', totalFloors: '5',
    typeLayout: '公寓', age: '30', parking: '無車位', realPriceUrl: null, ...over,
  };
}

test('parses numbers and computes the mortgage', () => {
  const e = enrichListing(listing({}), EXITS);
  assert.equal(e.totalPriceWan, 1000);
  assert.equal(e.totalPriceNtd, 10_000_000);
  assert.equal(e.totalPingNum, 20);
  assert.equal(e.unitPriceWan, 50);
  // 1000萬 -> 800萬 loan -> ~32,031/mo (8x the 100萬 figure).
  assert.ok(Math.abs((e.monthlyMortgage ?? 0) - 32031) < 5, `got ${e.monthlyMortgage}`);
});

test('attaches the nearest exit and flags nothing when close', () => {
  const e = enrichListing(listing({ coordinate: { lat: 25.0471, lng: 121.5171 } }), EXITS);
  assert.equal(e.mrt?.nameZh, '台北車站');
  assert.ok(e.mrt!.distanceM < 50);
  assert.equal(e.mrtBoundaryCase, false);
  assert.equal(e.hardExclusion.excluded, false);
});

test('hard-excludes a coordinate clearly over 900m from any exit', () => {
  const e = enrichListing(listing({ coordinate: { lat: 25.10, lng: 121.60 } }), EXITS);
  assert.equal(e.hardExclusion.excluded, true);
  assert.match(e.hardExclusion.reasons.join(), /over 800m/);
});

test('no coordinate means no MRT data and no MRT exclusion', () => {
  const e = enrichListing(listing({ coordinate: null }), EXITS);
  assert.equal(e.mrt, null);
  assert.equal(e.hardExclusion.excluded, false);
});

test('auction keyword in the title hard-excludes regardless of distance', () => {
  const e = enrichListing(
    listing({ title: '法拍美寓', coordinate: { lat: 25.0471, lng: 121.5171 } }),
    EXITS,
  );
  assert.equal(e.hardExclusion.excluded, true);
});
