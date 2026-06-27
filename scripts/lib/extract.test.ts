// scripts/lib/extract.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectListings, type CollectDeps } from './extract.ts';
import type { ListItem, SearchListResponse, HistoryEntry } from './api.ts';

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
function on(id: number, date = '2026-06-26'): HistoryEntry {
  return { source: '樂屋網', source_id: `o${id}`, total: 1000, subject: `s${id}`, add_time: date, link: `http://x/${id}` };
}
function captureErr<T>(fn: () => Promise<T>): Promise<{ out: T; errs: string[] }> {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(' ')); };
  return fn().then(
    (out) => { console.error = orig; return { out, errs }; },
    (e) => { console.error = orig; throw e; },
  );
}

const okDeps = (over: Partial<CollectDeps>): CollectDeps => ({
  ensureSession: async () => {},
  fetchPage: async () => page([item(1)], 1),
  fetchOnMarketHistory: async (id) => [on(id)],
  fetchOffMarketHistory: async () => [],
  ...over,
});

test('collectListings paginates by total_records/per_page and maps items in order', async () => {
  const pages: Record<number, SearchListResponse> = {
    1: page([item(1), item(2)], 40),
    2: page([item(3)], 40),
  };
  const out = await collectListings('2026-06-26', okDeps({
    fetchPage: async (_d, p) => pages[p],
    fetchOnMarketHistory: async (id) => [on(id)],
  }));
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 1);
  assert.equal(out[2].id, 3);
});

test('collectListings stops at an empty page', async () => {
  const pages: Record<number, SearchListResponse> = { 1: page([item(1)], 100), 2: page([], 100) };
  const out = await collectListings('2026-06-26', okDeps({
    fetchPage: async (_d, p) => pages[p] ?? page([], 100),
  }));
  assert.equal(out.length, 1);
});

test('collectListings merges on-market and off-market history', async () => {
  const out = await collectListings('2026-06-27', okDeps({
    fetchPage: async () => page([item(7)], 1),
    fetchOnMarketHistory: async () => [{ source: '樂屋網', source_id: 'a', total: 1688, subject: 's', add_time: '2026-06-27', link: 'x' }],
    fetchOffMarketHistory: async () => [{ source: '信義房屋', source_id: 'b', total: '1,500', subject: 's', add_time: '2025-12-01', link: 'y' }],
  }));
  const h = out[0].listingHistory;
  assert.equal(h.length, 2);
  const off = h.find((e) => e.source === '信義房屋');
  assert.equal(off?.active, false);
  assert.equal(off?.date, '2025-12-01');
});

test('collectListings drops history and warns when a listing fetch fails', async () => {
  const { out, errs } = await captureErr(() => collectListings('2026-06-26', okDeps({
    fetchPage: async () => page([item(1), item(2)], 2),
    fetchOnMarketHistory: async (id) => { if (id === 1) throw new Error('boom'); return [on(id)]; },
  })));
  assert.deepEqual(out.find((l) => l.id === 1)?.listingHistory, []);
  assert.equal(out.find((l) => l.id === 2)?.listingHistory.length, 1);
  assert.ok(errs.some((e) => /WARN/.test(e) && e.includes('1')));
  assert.ok(errs.some((e) => /1 dropped/.test(e)));
});

test('collectListings treats an empty on-market history as a drop', async () => {
  const { out, errs } = await captureErr(() => collectListings('2026-06-26', okDeps({
    fetchPage: async () => page([item(5)], 1),
    fetchOnMarketHistory: async () => [],
  })));
  assert.deepEqual(out[0].listingHistory, []);
  assert.ok(errs.some((e) => /1 dropped/.test(e)));
});
