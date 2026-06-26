import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildListUrl } from './url.ts';

test('buildListUrl includes the target date on both add_date params', () => {
  const url = buildListUrl('2026-06-26');
  assert.match(url, /add_date=2026-06-26(&|$)/);
  assert.match(url, /add_date_max=2026-06-26(&|$)/);
});

test('buildListUrl keeps the documented filter params (comma-encoded)', () => {
  const url = buildListUrl('2026-06-26');
  assert.ok(url.startsWith('https://www.ibigfun.com/lists/latest?'));
  assert.match(url, /method=all_case/);
  assert.match(url, /on_market=1/);
  assert.match(url, /price_segment=%2C2500/);
  assert.match(url, /floor_segment=2%2C4/);
  assert.match(url, /total_floor=%2C5/);
});

test('buildListUrl defaults to page 1 and accepts an explicit page', () => {
  assert.match(buildListUrl('2026-06-26'), /(\?|&)page=1(&|$)/);
  assert.match(buildListUrl('2026-06-26', 3), /(\?|&)page=3(&|$)/);
});
