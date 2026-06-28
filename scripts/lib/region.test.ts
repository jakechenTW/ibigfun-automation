import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGION_ALLOWLIST, classifyRegion } from './region.ts';
import { loadExits } from './mrt.ts';

test('allowlist has exactly 35 stations', () => {
  assert.equal(REGION_ALLOWLIST.size, 35);
});

test('every allowlist station exists in the MRT exit dataset', () => {
  const names = new Set(loadExits('data/taipei_mrt_exits.csv').map((e) => e.nameZh));
  for (const s of REGION_ALLOWLIST) {
    assert.ok(names.has(s), `allowlist station not in MRT data: ${s}`);
  }
});

test('excluded stations are NOT in the allowlist (sanity)', () => {
  for (const s of ['圓山', '龍山寺', '後山埤', '南京三民', '松山', '萬隆', '劍南路', '科技大樓']) {
    assert.equal(REGION_ALLOWLIST.has(s), false, `should be excluded: ${s}`);
  }
});

test('in-allowlist + within walk -> in', () => {
  assert.equal(classifyRegion('大安', true), 'in');
});

test('out of allowlist -> out-of-region regardless of walk', () => {
  assert.equal(classifyRegion('後山埤', true), 'out-of-region');
  assert.equal(classifyRegion('後山埤', false), 'out-of-region');
});

test('in-allowlist but too far -> in-region-too-far', () => {
  assert.equal(classifyRegion('大安', false), 'in-region-too-far');
});

test('unreliable (withinWalk null) -> review, even if station present', () => {
  assert.equal(classifyRegion('大安', null), 'review');
  assert.equal(classifyRegion(null, null), 'review');
});

test('null station with a definite walk decision -> out-of-region', () => {
  assert.equal(classifyRegion(null, true), 'out-of-region');
});
