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
  const { out } = await captureErr(() => collectListings({ from: '2026-06-26', to: '2026-06-26' }, okDeps({
    fetchPage: async (_from, _to, p) => pages[p],
    fetchOnMarketHistory: async (id) => [on(id)],
  })));
  assert.equal(out.listings.length, 3);
  assert.equal(out.listings[0].id, 1);
  assert.equal(out.listings[2].id, 3);
});

test('collectListings stops at an empty page', async () => {
  const pages: Record<number, SearchListResponse> = { 1: page([item(1)], 100), 2: page([], 100) };
  const { out } = await captureErr(() => collectListings({ from: '2026-06-26', to: '2026-06-26' }, okDeps({
    fetchPage: async (_from, _to, p) => pages[p] ?? page([], 100),
  })));
  assert.equal(out.listings.length, 1);
});

test('collectListings merges on-market and off-market history', async () => {
  const { out } = await captureErr(() => collectListings({ from: '2026-06-27', to: '2026-06-27' }, okDeps({
    fetchPage: async () => page([item(7)], 1),
    fetchOnMarketHistory: async () => [{ source: '樂屋網', source_id: 'a', total: 1688, subject: 's', add_time: '2026-06-27', link: 'x' }],
    fetchOffMarketHistory: async () => [{ source: '信義房屋', source_id: 'b', total: '1,500', subject: 's', add_time: '2025-12-01', link: 'y' }],
  })));
  const h = out.listings[0].listingHistory;
  assert.equal(h.length, 2);
  const off = h.find((e) => e.source === '信義房屋');
  assert.equal(off?.active, false);
  assert.equal(off?.date, '2025-12-01');
});

test('collectListings drops history and warns when a listing fetch fails', async () => {
  const { out, errs } = await captureErr(() => collectListings({ from: '2026-06-26', to: '2026-06-26' }, okDeps({
    fetchPage: async () => page([item(1), item(2)], 2),
    fetchOnMarketHistory: async (id) => { if (id === 1) throw new Error('boom'); return [on(id)]; },
  })));
  assert.deepEqual(out.listings.find((l) => l.id === 1)?.listingHistory, []);
  assert.equal(out.listings.find((l) => l.id === 2)?.listingHistory.length, 1);
  assert.ok(errs.some((e) => /WARN/.test(e) && e.includes('1')));
  assert.ok(errs.some((e) => /1 dropped/.test(e)));
});

test('collectListings treats an empty on-market history as a drop', async () => {
  const { out, errs } = await captureErr(() => collectListings({ from: '2026-06-26', to: '2026-06-26' }, okDeps({
    fetchPage: async () => page([item(5)], 1),
    fetchOnMarketHistory: async () => [],
  })));
  assert.deepEqual(out.listings[0].listingHistory, []);
  assert.ok(errs.some((e) => /1 dropped/.test(e)));
});

test('collectListings keeps on-market history when only off-market fails', async () => {
  const { out, errs } = await captureErr(() => collectListings({ from: '2026-06-26', to: '2026-06-26' }, okDeps({
    fetchPage: async () => page([item(8)], 1),
    fetchOnMarketHistory: async (id) => [on(id)],
    fetchOffMarketHistory: async () => { throw new Error('throttled'); },
  })));
  assert.equal(out.listings[0].listingHistory.length, 1); // on-market survived
  assert.ok(errs.some((e) => /off-market/.test(e) && e.includes('8')));
  assert.ok(errs.some((e) => /0 dropped/.test(e))); // off-market-only fail is not a drop
});

test('collectListings emits a history.drop event when on-market history is empty', async () => {
  const events: string[] = [];
  const logger = { event: (_l: string, ev: string) => { events.push(ev); } };
  const deps = {
    ensureSession: async () => {},
    fetchPage: async () => ({ status: 'ok', total_records: 1, per_page: 30,
      data: [{ id: 1, uuid: 'u1' }] } as any),
    fetchOnMarketHistory: async () => [],          // empty => drop
    fetchOffMarketHistory: async () => [],
  };
  const { listings, dropped } = await collectListings({ from: '2026-06-26', to: '2026-06-26' }, deps as any, logger as any);
  assert.equal(listings.length, 1);
  assert.equal(dropped, 1);
  assert.ok(events.includes('history.drop'));
});

test('collectListings dedupes repeated listing ids within a range (keeps first)', async () => {
  const events: string[] = [];
  const logger = { event: (_l: string, ev: string) => { events.push(ev); } };
  const pages: Record<number, SearchListResponse> = {
    1: page([item(1), item(2)], 40),
    2: page([item(2), item(3)], 40), // id 2 repeats across pages
  };
  const { listings, duplicates } = await collectListings(
    { from: '2026-06-20', to: '2026-06-25' },
    okDeps({ fetchPage: async (_f, _t, p) => pages[p], fetchOnMarketHistory: async (id) => [on(id)] }),
    logger as any,
  );
  assert.deepEqual(listings.map((l) => l.id), [1, 2, 3]);
  assert.equal(duplicates, 1);
  assert.ok(events.includes('fetch.dedup'));
});
