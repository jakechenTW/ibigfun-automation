// scripts/lib/extract.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectListings, type CollectDeps } from './extract.ts';
import type { ListItem, SearchListResponse, O2oResponse } from './api.ts';

function item(id: number): ListItem {
  return {
    id, subject: `s${id}`, source: '樂屋', link: `http://x/${id}`, address: 'addr',
    mrt: '', lat: 25, lng: 121, add_time: '2026-06-26 10:00:00', total: 1000,
    price_ave: 50, total_ping: 20, floor: 3, total_floor: 4, pattern: '2房',
    house_age_x: 30, parking_type: '無車位', room: 2, living_room: 1, bathroom: 1,
    id_encode: `e${id}`, uuid: `u${id}`,
  };
}
function page(items: ListItem[], total: number): SearchListResponse {
  return { status: 'ok', msg: '', total_records: total, per_page: 20, current_page: 1, data: items };
}

test('collectListings paginates by total_records/per_page and maps items', async () => {
  const pages: Record<number, SearchListResponse> = {
    1: page([item(1), item(2)], 40),
    2: page([item(3)], 40),
  };
  let historyCalls = 0;
  const deps: CollectDeps = {
    ensureSession: async () => {},
    fetchPage: async (_d, p) => pages[p],
    fetchHistory: async (ids) => { historyCalls++; assert.ok(ids.length > 0); return {} as O2oResponse['data']; },
  };
  const out = await collectListings('2026-06-26', deps);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 1);
  assert.equal(out[2].id, 3);
  assert.equal(historyCalls, 2); // one per page
});

test('collectListings stops at an empty page', async () => {
  const pages: Record<number, SearchListResponse> = {
    1: page([item(1)], 100),
    2: page([], 100),
  };
  const deps: CollectDeps = {
    ensureSession: async () => {},
    fetchPage: async (_d, p) => pages[p] ?? page([], 100),
    fetchHistory: async () => ({}) as O2oResponse['data'],
  };
  const out = await collectListings('2026-06-26', deps);
  assert.equal(out.length, 1);
});

test('collectListings attaches o2o-same history by id', async () => {
  const deps: CollectDeps = {
    ensureSession: async () => {},
    fetchPage: async () => page([item(7)], 1),
    fetchHistory: async () => ({ '7': { '591': { source_id: 'a', link: 'b', total: 1200, add_date: '2025-01-02' } } }),
  };
  const out = await collectListings('2026-06-26', deps);
  assert.equal(out[0].listingHistory.length, 1);
  assert.equal(out[0].listingHistory[0].date, '2025-01-02');
});
