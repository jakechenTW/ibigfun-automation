import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasAuctionKeyword, evaluateHardExclusion } from './exclude.ts';

test('detects auction/special-disposition keywords', () => {
  assert.equal(hasAuctionKeyword('法拍屋整層'), true);
  assert.equal(hasAuctionKeyword('應買案件'), true);
  assert.equal(hasAuctionKeyword('溫馨美寓近公園'), false);
});

test('auto-excludes only when MRT is clearly over the boundary (>900m)', () => {
  assert.deepEqual(evaluateHardExclusion({ title: '美寓', mrtDistanceM: 1200 }).excluded, true);
  assert.deepEqual(evaluateHardExclusion({ title: '美寓', mrtDistanceM: 850 }).excluded, false); // boundary
  assert.deepEqual(evaluateHardExclusion({ title: '美寓', mrtDistanceM: 500 }).excluded, false);
});

test('missing distance never excludes on MRT grounds', () => {
  assert.deepEqual(evaluateHardExclusion({ title: '美寓', mrtDistanceM: null }).excluded, false);
});

test('keyword excludes regardless of distance, and reasons are listed', () => {
  const r = evaluateHardExclusion({ title: '法拍美寓', mrtDistanceM: 100 });
  assert.equal(r.excluded, true);
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /auction/);
});
