// scripts/lib/api.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchBody, pageCount, SEARCH_LIST_URL, historyUrl, OFF_MARKET_URL, buildOffMarketBody } from './api.ts';

test('buildSearchBody sets both add_date params to the target date', () => {
  const b = buildSearchBody('2026-06-26', 1);
  assert.match(b, /(^|&)add_date=2026-06-26(&|$)/);
  assert.match(b, /(^|&)add_date_max=2026-06-26(&|$)/);
});

test('buildSearchBody keeps the captured filter + source allow-list', () => {
  const b = buildSearchBody('2026-06-26', 2);
  assert.match(b, /(^|&)page=2(&|$)/);
  assert.match(b, /method=all_case/);
  assert.match(b, /on_market=1/);
  assert.match(b, /price_segment%5Bmax_val%5D=2500/);
  assert.match(b, /floor_segment%5Bmin_val%5D=2/);
  assert.match(b, /floor_segment%5Bmax_val%5D=4/);
  assert.match(b, /total_floor%5Bmax_val%5D=5/);
  assert.match(b, /source_web%5B%5D=370/);
  assert.match(b, /source%5B%5D=372/);
  assert.match(b, /(^|&)exclude_land=1(&|$)/);
});

test('buildSearchBody defaults to page 1', () => {
  assert.match(buildSearchBody('2026-06-26'), /(^|&)page=1(&|$)/);
});

test('pageCount = ceil(total / perPage), 0 when perPage invalid', () => {
  assert.equal(pageCount(78, 20), 4);
  assert.equal(pageCount(40, 20), 2);
  assert.equal(pageCount(0, 20), 0);
  assert.equal(pageCount(78, 0), 0);
});

test('SEARCH_LIST_URL points at the listing API', () => {
  assert.equal(SEARCH_LIST_URL, 'https://www.ibigfun.com/api/search/list');
});

test('historyUrl puts the numeric listing id in the path', () => {
  assert.equal(historyUrl(53200935), 'https://api.ibigfun.com/on-market/53200935/history');
});

test('OFF_MARKET_URL points at the off-market endpoint', () => {
  assert.equal(OFF_MARKET_URL, 'https://www.ibigfun.com/api/query_off_market_by_id');
});

test('buildOffMarketBody encodes the uuid as id_encode', () => {
  assert.equal(buildOffMarketBody('A_1FF424'), 'id_encode=A_1FF424');
});
