# 刊登紀錄 via real history + off-market APIs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken `o2o-same` 刊登紀錄 fetch with the two endpoints the live page uses — on-market `/history` and `query_off_market_by_id` — so listing history (and tenure) is populated again, including 下架 records.

**Architecture:** Per listing (from `search/list`, which carries both `id` and `uuid`), fetch on-market history (`GET api.ibigfun.com/on-market/{id}/history`) and off-market history (`POST www.ibigfun.com/api/query_off_market_by_id`, body `id_encode={uuid}`), map each into `RawHistoryRow[]`, merge+dedupe into `ListingHistoryEntry[]`, and feed the unchanged `computeTenure`. Calls run through a small concurrency pool with retry+backoff; a listing that still fails is skipped with a loud WARN and counted in a summary.

**Tech Stack:** TypeScript ESM run by `tsx`; Node ≥20 (global `fetch`, `Headers.getSetCookie()`); tests via `node:test` + `node:assert/strict`.

## Global Constraints

- Node ≥20, TypeScript ESM, run by `tsx`; tests use `node:test` + `node:assert/strict`. Relative imports keep the `.ts` extension.
- Do NOT modify `computeTenure` (tenure.ts), `types.ts`, enrich, route, or notification templates. The change is contained to api/map/http/extract/config + their tests + `docs/fetching.md`.
- Dedupe key for merging history rows is exactly `source + "|" + date + "|" + active`.
- Defaults: `HISTORY_CONCURRENCY = 4`, `HISTORY_RETRIES = 3`, `HISTORY_RETRY_BASE_MS = 500`.
- Per-listing failure policy: after retries are exhausted (or on-market history is empty for a live listing), skip that listing with **empty** `listingHistory`, emit a `console.error` WARN naming the listing `id`, increment a dropped counter, and print a final summary line `history: <ok> listings ok, <dropped> dropped (see WARN above)`. Never drop history silently.
- `history.total` is a **number**; off-market `total` is a **string with commas** (e.g. `"1,234"`). Both map to the raw `price` token via `String(total)`; downstream `firstNumber` strips commas.
- Security (AGENTS.md): never print `IBIGFUN_ACCOUNT`/`IBIGFUN_PASSWORD`; never commit `.cookies.json`, `reports/`, or `state/`.
- Endpoints require the logged-in session cookies. The existing flat cookie jar already sends all cookies to both `api.ibigfun.com` and `www.ibigfun.com` hosts — no jar changes.

## File Structure

- `scripts/lib/api.ts` — endpoint URLs/body builders + response types. Add history + off-market; remove o2o-same (in cleanup).
- `scripts/lib/map.ts` — pure JSON→`RawHistoryRow[]`/`Listing` mappers. Add on/off-market row mappers + `mergeHistory`; change `apiItemToListing` to take pre-merged history; remove `o2oToRawHistory` (in cleanup).
- `scripts/lib/http.ts` — session + network. Add `withRetry` + per-listing fetchers; widen `looksLikeSignin`; repoint `defaultDeps`; remove batched `fetchHistory` (in cleanup).
- `scripts/lib/extract.ts` — orchestration. New `CollectDeps`; concurrency pool; skip/warn/summary.
- `scripts/lib/config.ts` — add the three knobs.
- `docs/fetching.md` — document the two endpoints + accepted limitation (in cleanup).
- Tests co-located: `api.test.ts`, `map.test.ts`, `http.test.ts`, `extract.test.ts`.

The cut-over (Task 4) changes `apiItemToListing`'s signature, which all its call sites share, so the map-signature change, the extract orchestration, and both test rewrites land together in one atomic task. Tasks 1–3 are purely additive (old o2o path stays green); Task 5 removes the now-dead o2o code.

---

### Task 1: api.ts — add history + off-market contract (additive)

**Files:**
- Modify: `scripts/lib/api.ts`
- Test: `scripts/lib/api.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `historyUrl(id: number): string`
  - `OFF_MARKET_URL: string`
  - `buildOffMarketBody(uuid: string): string`
  - `interface HistoryEntry { source: string; source_id: string; total: number; subject: string; add_time: string; link: string }`
  - `interface HistoryResponse { status: string; data: HistoryEntry[] }`
  - `interface OffMarketEntry { source: string; source_id: string; total: string | number; subject: string; add_time: string; link: string }`
  - `interface OffMarketResponse { status: string; msg: string; total_records: number; data: OffMarketEntry[] }`

- [ ] **Step 1: Write the failing tests**

Add to `scripts/lib/api.test.ts` (extend the import on line 4 to include the new symbols):

```ts
import { buildSearchBody, pageCount, SEARCH_LIST_URL, historyUrl, OFF_MARKET_URL, buildOffMarketBody } from './api.ts';

test('historyUrl puts the numeric listing id in the path', () => {
  assert.equal(historyUrl(53200935), 'https://api.ibigfun.com/on-market/53200935/history');
});

test('OFF_MARKET_URL points at the off-market endpoint', () => {
  assert.equal(OFF_MARKET_URL, 'https://www.ibigfun.com/api/query_off_market_by_id');
});

test('buildOffMarketBody encodes the uuid as id_encode', () => {
  assert.equal(buildOffMarketBody('A_1FF424'), 'id_encode=A_1FF424');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -A2 historyUrl`
Expected: FAIL — `historyUrl` / `OFF_MARKET_URL` / `buildOffMarketBody` are not exported.

- [ ] **Step 3: Add the contract to api.ts**

In `scripts/lib/api.ts`, keep the existing `O2O_SAME_URL` and `O2o*` types for now. After the `O2O_SAME_URL` line, add:

```ts
/** On-market cross-source posting history for one listing (id in the path). */
export function historyUrl(id: number): string {
  return `https://api.ibigfun.com/on-market/${id}/history`;
}

/** Off-market (下架) posting history endpoint; body is id_encode=<uuid>. */
export const OFF_MARKET_URL = 'https://www.ibigfun.com/api/query_off_market_by_id';

/** Build the URL-encoded query_off_market_by_id POST body for a listing uuid. */
export function buildOffMarketBody(uuid: string): string {
  const p = new URLSearchParams();
  p.set('id_encode', uuid);
  return p.toString();
}

/** One on-market posting from /on-market/{id}/history. `total` is a number. */
export interface HistoryEntry {
  source: string;
  source_id: string;
  total: number;
  subject: string;
  add_time: string;
  link: string;
}

export interface HistoryResponse {
  status: string;
  data: HistoryEntry[];
}

/** One off-market (下架) posting. `total` is a comma string here, e.g. "1,234". */
export interface OffMarketEntry {
  source: string;
  source_id: string;
  total: string | number;
  subject: string;
  add_time: string;
  link: string;
}

export interface OffMarketResponse {
  status: string;
  msg: string;
  total_records: number;
  data: OffMarketEntry[];
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npm test 2>&1 | tail -5 && npx tsc --noEmit`
Expected: all tests PASS; `tsc` exits 0 (no output).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/api.ts scripts/lib/api.test.ts
git commit -m "feat: add history + off-market endpoint contract to api.ts"
```

---

### Task 2: map.ts — add row mappers + mergeHistory (additive)

**Files:**
- Modify: `scripts/lib/map.ts`
- Test: `scripts/lib/map.test.ts`

**Interfaces:**
- Consumes: `HistoryEntry`, `OffMarketEntry` (Task 1); `RawHistoryRow`, `normalizeHistory` (history.ts); `ListingHistoryEntry` (types.ts).
- Produces:
  - `onMarketToRows(entries: HistoryEntry[]): RawHistoryRow[]`
  - `offMarketToRows(entries: OffMarketEntry[]): RawHistoryRow[]`
  - `mergeHistory(onRows: RawHistoryRow[], offRows: RawHistoryRow[]): ListingHistoryEntry[]`

- [ ] **Step 1: Write the failing tests**

Add to `scripts/lib/map.test.ts` (add imports at the top of the file):

```ts
import { onMarketToRows, offMarketToRows, mergeHistory } from './map.ts';
import type { HistoryEntry, OffMarketEntry } from './api.ts';

const ON: HistoryEntry[] = [
  { source: '樂屋網', source_id: 'a', total: 1688, subject: 's', add_time: '2026-06-27', link: 'x' },
];
const OFF: OffMarketEntry[] = [
  { source: '住商', source_id: 'b', total: '1,234', subject: 's', add_time: '2025-12-01', link: 'y' },
];

test('onMarketToRows maps numeric total to a string price, active:true', () => {
  assert.deepEqual(onMarketToRows(ON), [
    { price: '1688', source: '樂屋網', date: '2026-06-27', active: true },
  ]);
});

test('offMarketToRows keeps the comma-string total, active:false', () => {
  assert.deepEqual(offMarketToRows(OFF), [
    { price: '1,234', source: '住商', date: '2025-12-01', active: false },
  ]);
});

test('mergeHistory normalizes on+off and keeps same source/date when active differs', () => {
  const on = onMarketToRows([{ source: 'A', source_id: '1', total: 100, subject: '', add_time: '2026-01-01', link: '' }]);
  const off = offMarketToRows([{ source: 'A', source_id: '1', total: '100', subject: '', add_time: '2026-01-01', link: '' }]);
  assert.equal(mergeHistory(on, off).length, 2); // active true vs false -> distinct
});

test('mergeHistory dedupes identical rows', () => {
  assert.equal(mergeHistory(onMarketToRows(ON), onMarketToRows(ON)).length, 1);
});

test('mergeHistory of empty inputs is empty', () => {
  assert.deepEqual(mergeHistory([], []), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -A2 onMarketToRows`
Expected: FAIL — `onMarketToRows` / `offMarketToRows` / `mergeHistory` are not exported.

- [ ] **Step 3: Add the mappers to map.ts**

In `scripts/lib/map.ts`, add imports near the existing ones:

```ts
import type { ListItem, O2oForId, HistoryEntry, OffMarketEntry } from './api.ts';
import type { ListingHistoryEntry } from './types.ts';
```

(That replaces the existing `import type { ListItem, O2oForId } from './api.ts';` line — keep `O2oForId` for now, it's still used by `o2oToRawHistory`.)

Then add, after the `numStr` helper:

```ts
/** A listing `total` (number on-market, comma-string off-market) as a raw price token. */
function totalToPrice(total: string | number | null | undefined): string | null {
  return total === null || total === undefined ? null : String(total);
}

/** On-market /history entries → raw rows (all active). */
export function onMarketToRows(entries: HistoryEntry[]): RawHistoryRow[] {
  return entries.map((e) => ({
    price: totalToPrice(e.total),
    source: e.source ?? '',
    date: e.add_time ?? null,
    active: true,
  }));
}

/** Off-market (下架) entries → raw rows (all inactive). */
export function offMarketToRows(entries: OffMarketEntry[]): RawHistoryRow[] {
  return entries.map((e) => ({
    price: totalToPrice(e.total),
    source: e.source ?? '',
    date: e.add_time ?? null,
    active: false,
  }));
}

/** Merge on+off raw rows, dedupe by source|date|active, then normalize. */
export function mergeHistory(onRows: RawHistoryRow[], offRows: RawHistoryRow[]): ListingHistoryEntry[] {
  const seen = new Set<string>();
  const merged: RawHistoryRow[] = [];
  for (const r of [...onRows, ...offRows]) {
    const key = `${r.source}|${r.date}|${r.active}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(r);
  }
  return normalizeHistory(merged);
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npm test 2>&1 | tail -5 && npx tsc --noEmit`
Expected: all tests PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/map.ts scripts/lib/map.test.ts
git commit -m "feat: add on/off-market history row mappers and mergeHistory"
```

---

### Task 3: http.ts — withRetry, per-listing fetchers, config knobs

**Files:**
- Modify: `scripts/lib/http.ts`, `scripts/lib/config.ts`
- Test: `scripts/lib/http.test.ts`

**Interfaces:**
- Consumes: `historyUrl`, `OFF_MARKET_URL`, `buildOffMarketBody`, `HistoryResponse`, `OffMarketResponse`, `HistoryEntry`, `OffMarketEntry` (Task 1); existing `withRelogin`, `rawGet`, `rawPostForm`, `applySetCookies`, `getJar`, `looksLikeSignin`, `assertApiOk`.
- Produces:
  - `withRetry<T>(fn: () => Promise<T>, opts: { retries: number; baseMs: number; sleep?: (ms: number) => Promise<void> }): Promise<T>`
  - `fetchOnMarketHistory(id: number): Promise<HistoryEntry[]>` (module-internal, used by `defaultDeps` in Task 4)
  - `fetchOffMarketHistory(uuid: string): Promise<OffMarketEntry[]>` (module-internal, used by `defaultDeps` in Task 4)
  - config: `HISTORY_CONCURRENCY = 4`, `HISTORY_RETRIES = 3`, `HISTORY_RETRY_BASE_MS = 500`

- [ ] **Step 1: Write the failing tests**

Add to `scripts/lib/http.test.ts` (extend the import on line 4 to include `withRetry`):

```ts
import { looksLikeSignin, assertApiOk, withRetry } from './http.ts';

test('withRetry returns immediately on success (one call)', async () => {
  let calls = 0;
  const v = await withRetry(async () => { calls++; return 42; }, { retries: 3, baseMs: 0, sleep: async () => {} });
  assert.equal(v, 42);
  assert.equal(calls, 1);
});

test('withRetry retries then succeeds', async () => {
  let calls = 0;
  const v = await withRetry(async () => { calls++; if (calls < 3) throw new Error('x'); return 'ok'; },
    { retries: 3, baseMs: 0, sleep: async () => {} });
  assert.equal(v, 'ok');
  assert.equal(calls, 3);
});

test('withRetry gives up after retries+1 attempts and throws the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('always'); }, { retries: 2, baseMs: 0, sleep: async () => {} }),
    /always/,
  );
  assert.equal(calls, 3);
});

test('withRetry doubles the backoff each attempt', async () => {
  const delays: number[] = [];
  await assert.rejects(
    withRetry(async () => { throw new Error('e'); }, { retries: 3, baseMs: 100, sleep: async (ms) => { delays.push(ms); } }),
  );
  assert.deepEqual(delays, [100, 200, 400]);
});

test('an HTML body on the history URL is a kick', () => {
  assert.equal(
    looksLikeSignin({ status: 200, finalUrl: 'https://api.ibigfun.com/on-market/53200935/history', contentType: 'text/html' }),
    true,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -A2 withRetry`
Expected: FAIL — `withRetry` not exported; the history-URL kick test fails (current `looksLikeSignin` only matches `/api/` or `o2o-same`).

- [ ] **Step 3: Add the knobs to config.ts**

Append to `scripts/lib/config.ts`:

```ts
/** Max listings fetched concurrently when pulling per-listing history. */
export const HISTORY_CONCURRENCY = 4;

/** Retry budget per history API call (in addition to the first attempt). */
export const HISTORY_RETRIES = 3;

/** Base backoff (ms) for history retries; doubles each attempt. */
export const HISTORY_RETRY_BASE_MS = 500;
```

- [ ] **Step 4: Widen looksLikeSignin and add the fetchers to http.ts**

In `scripts/lib/http.ts`, update the imports (extend the `api.ts` imports):

```ts
import { SIGNIN_URL, LOGIN_URL, SEARCH_LIST_URL, O2O_SAME_URL, buildSearchBody, historyUrl, OFF_MARKET_URL, buildOffMarketBody } from './api.ts';
import type { SearchListResponse, O2oResponse, HistoryResponse, OffMarketResponse, HistoryEntry, OffMarketEntry } from './api.ts';
import { SIGNIN_PATH_FRAGMENT, BLOCKING_SIGNALS, COOKIE_JAR_PATH, HISTORY_RETRIES, HISTORY_RETRY_BASE_MS } from './config.ts';
```

In `looksLikeSignin`, widen the data-URL check so the `api.ibigfun.com/on-market/{id}/history` host counts as a data URL:

```ts
  if (res.contentType.includes('text/html')) {
    const isDataUrl =
      res.finalUrl.includes('/api/') ||
      res.finalUrl.includes('/on-market/') ||
      res.finalUrl.includes('o2o-same');
    if (isDataUrl) return true;
  }
```

Add `withRetry` (place it just above `fetchPage`):

```ts
/** Retry an async call with exponential backoff. Empty results are NOT errors. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < opts.retries) await sleep(opts.baseMs * 2 ** attempt);
    }
  }
  throw lastErr;
}
```

Add the two per-listing fetchers (near `fetchHistory`):

```ts
async function fetchOnMarketHistory(id: number): Promise<HistoryEntry[]> {
  return withRetry(
    () =>
      withRelogin(async () => {
        const r = await rawGet(historyUrl(id));
        applySetCookies(getJar(), r.setCookies);
        if (looksLikeSignin(r)) return { kicked: true };
        const parsed = JSON.parse(r.text) as HistoryResponse;
        assertApiOk(`history ${id}`, r.status, parsed.status);
        return { kicked: false, value: parsed.data ?? [] };
      }),
    { retries: HISTORY_RETRIES, baseMs: HISTORY_RETRY_BASE_MS },
  );
}

async function fetchOffMarketHistory(uuid: string): Promise<OffMarketEntry[]> {
  return withRetry(
    () =>
      withRelogin(async () => {
        const r = await rawPostForm(OFF_MARKET_URL, buildOffMarketBody(uuid), 'https://www.ibigfun.com/lists/latest');
        applySetCookies(getJar(), r.setCookies);
        if (looksLikeSignin(r)) return { kicked: true };
        const parsed = JSON.parse(r.text) as OffMarketResponse;
        assertApiOk('query_off_market_by_id', r.status, parsed.status);
        return { kicked: false, value: parsed.data ?? [] };
      }),
    { retries: HISTORY_RETRIES, baseMs: HISTORY_RETRY_BASE_MS },
  );
}
```

Leave `fetchHistory` and `defaultDeps` as they are for now (Task 4 repoints `defaultDeps`; Task 5 deletes `fetchHistory`). The two new functions are currently unused — that's expected and not a `tsc` error.

- [ ] **Step 5: Run the tests and the type check**

Run: `npm test 2>&1 | tail -5 && npx tsc --noEmit`
Expected: all tests PASS; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/http.ts scripts/lib/config.ts scripts/lib/http.test.ts
git commit -m "feat: add withRetry + per-listing history fetchers; widen signin detection"
```

---

### Task 4: Cut over collectListings to per-listing history (pool, skip/warn/summary)

**Files:**
- Modify: `scripts/lib/map.ts` (change `apiItemToListing` signature), `scripts/lib/extract.ts` (orchestration), `scripts/lib/http.ts` (`defaultDeps`)
- Test: `scripts/lib/map.test.ts` (update `apiItemToListing` calls), `scripts/lib/extract.test.ts` (rewrite)

**Interfaces:**
- Consumes: `onMarketToRows`, `offMarketToRows`, `mergeHistory`, `apiItemToListing` (map.ts); `fetchOnMarketHistory`, `fetchOffMarketHistory` (http.ts, Task 3); `HistoryEntry`, `OffMarketEntry` (api.ts); `HISTORY_CONCURRENCY` (config.ts); `pageCount`, `SearchListResponse` (api.ts); `MAX_PAGES` (config.ts).
- Produces:
  - `apiItemToListing(it: ListItem, history: ListingHistoryEntry[]): Listing` (changed second param)
  - `interface CollectDeps { ensureSession; fetchPage; fetchOnMarketHistory; fetchOffMarketHistory }`
  - `collectListings(date: string, deps?: CollectDeps): Promise<Listing[]>` (same signature, new behavior)

- [ ] **Step 1: Rewrite the extract tests (failing)**

Replace the entire contents of `scripts/lib/extract.test.ts` with:

```ts
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
```

- [ ] **Step 2: Run to verify the new extract tests fail**

Run: `npm test 2>&1 | grep -A3 'collectListings'`
Expected: FAIL — `CollectDeps` has no `fetchOnMarketHistory`; `collectListings` still calls the old `fetchHistory`.

- [ ] **Step 3: Change apiItemToListing to take pre-merged history**

In `scripts/lib/map.ts`, change the signature and body of `apiItemToListing`. Replace:

```ts
/** Map one API item (+ its history) to a Listing. */
export function apiItemToListing(it: ListItem, historyForId: O2oForId): Listing {
```
…and its `listingHistory:` line…
```ts
    listingHistory: normalizeHistory(o2oToRawHistory(historyForId)),
```

with:

```ts
/** Map one API item (+ its already-merged history) to a Listing. */
export function apiItemToListing(it: ListItem, history: ListingHistoryEntry[]): Listing {
```
```ts
    listingHistory: history,
```

(Leave `o2oToRawHistory` and the `O2oForId` import in place — Task 5 removes them.)

- [ ] **Step 4: Update the existing map.test apiItemToListing calls**

In `scripts/lib/map.test.ts`, the `apiItemToListing` tests currently pass an `O2oForId` (`{}` or `HISTORY`). Update them to pass `ListingHistoryEntry[]`:

- Replace the `HISTORY` fixture usage in the tenure test. Add near the other fixtures:

```ts
import type { ListingHistoryEntry } from './types.ts';

const MERGED: ListingHistoryEntry[] = [
  { date: '2026-05-09', source: '591', price: '1790', active: true },
  { date: '2025-06-21', source: '中信房屋', price: '1790', active: false },
];
```

- In `apiItemToListing maps core fields…` and `apiItemToListing fills the new structured fields` and `apiItemToListing coerces a numeric source…`, change `apiItemToListing(ITEM, {})` → `apiItemToListing(ITEM, [])`.
- Replace the `listingHistory feeds tenure…` test body with:

```ts
test('listingHistory feeds tenure: earliest record is first listed', () => {
  const l = apiItemToListing(ITEM, MERGED);
  assert.equal(l.listingHistory.length, 2);
  const t = computeTenure(l.listingHistory, '2026-06-26');
  assert.equal(t.firstListedDate, '2025-06-21');
  assert.equal(t.sourceCount, 2);
});
```

- Replace the `empty history maps to an empty listingHistory array` test with:

```ts
test('empty history maps to an empty listingHistory array', () => {
  assert.deepEqual(apiItemToListing(ITEM, []).listingHistory, []);
});
```

(The `o2oToRawHistory turns each source into a raw history row` test and the `HISTORY: O2oForId` fixture stay untouched in this task — they are removed in Task 5.)

- [ ] **Step 5: Repoint defaultDeps in http.ts**

In `scripts/lib/http.ts`, update `defaultDeps` to expose the new fetchers:

```ts
/** Real dependencies for collectListings (network-backed). */
export function defaultDeps(): CollectDeps {
  return { ensureSession, fetchPage, fetchOnMarketHistory, fetchOffMarketHistory };
}
```

(`fetchHistory` is now unreferenced — leave it; Task 5 deletes it.)

- [ ] **Step 6: Rewrite collectListings in extract.ts**

Replace the entire contents of `scripts/lib/extract.ts` with:

```ts
/**
 * Collect the filtered target-date listings from iBigFun's JSON APIs (no
 * browser). Paginates /api/search/list, then for each listing fetches its
 * on-market history (/on-market/{id}/history) and off-market history
 * (query_off_market_by_id) through a small concurrency pool with retry. A
 * listing whose history can't be fetched (or whose on-market history is empty
 * for a live listing) is kept with empty history and warned about — never
 * dropped silently. HTTP deps are injected so this is unit-tested offline.
 */
import type { Listing } from './types.ts';
import { MAX_PAGES, HISTORY_CONCURRENCY } from './config.ts';
import { pageCount, type SearchListResponse, type ListItem, type HistoryEntry, type OffMarketEntry } from './api.ts';
import { apiItemToListing, onMarketToRows, offMarketToRows, mergeHistory } from './map.ts';
import { defaultDeps } from './http.ts';

export interface CollectDeps {
  ensureSession: () => Promise<void>;
  fetchPage: (date: string, page: number) => Promise<SearchListResponse>;
  fetchOnMarketHistory: (id: number) => Promise<HistoryEntry[]>;
  fetchOffMarketHistory: (uuid: string) => Promise<OffMarketEntry[]>;
}

/** Run worker over items with at most `limit` in flight; preserves input order. */
async function runPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function runner(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => runner());
  await Promise.all(runners);
  return results;
}

export async function collectListings(date: string, deps: CollectDeps = defaultDeps()): Promise<Listing[]> {
  await deps.ensureSession();

  // 1) Gather all listing rows across pages.
  const first = await deps.fetchPage(date, 1);
  const pages = Math.min(pageCount(first.total_records, first.per_page), MAX_PAGES);
  const items: ListItem[] = [];
  for (let p = 1; p <= Math.max(pages, 1); p++) {
    const res = p === 1 ? first : await deps.fetchPage(date, p);
    if (!res.data || res.data.length === 0) break;
    items.push(...res.data);
  }

  // 2) Fetch per-listing history through a small pool; skip+warn on failure.
  let dropped = 0;
  const listings = await runPool(items, HISTORY_CONCURRENCY, async (it) => {
    try {
      const on = await deps.fetchOnMarketHistory(it.id);
      if (on.length === 0) {
        // A live listing always has >=1 on-market source; empty == suspicious.
        console.error(`WARN history: listing ${it.id} returned no on-market records (likely throttled); dropping history`);
        dropped++;
        return apiItemToListing(it, []);
      }
      const off = await deps.fetchOffMarketHistory(it.uuid);
      return apiItemToListing(it, mergeHistory(onMarketToRows(on), offMarketToRows(off)));
    } catch (e) {
      console.error(`WARN history: listing ${it.id} failed after retries (${(e as Error).message}); dropping history`);
      dropped++;
      return apiItemToListing(it, []);
    }
  });

  console.error(`history: ${items.length - dropped} listings ok, ${dropped} dropped (see WARN above)`);
  return listings;
}
```

- [ ] **Step 7: Run all tests and the type check**

Run: `npm test 2>&1 | tail -8 && npx tsc --noEmit`
Expected: all tests PASS (map, extract, http, api green); `tsc` exits 0.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/map.ts scripts/lib/map.test.ts scripts/lib/http.ts scripts/lib/extract.ts scripts/lib/extract.test.ts
git commit -m "feat: fetch per-listing history (on+off market) with pool, skip/warn/summary"
```

---

### Task 5: Remove the dead o2o-same path + update docs

**Files:**
- Modify: `scripts/lib/api.ts`, `scripts/lib/map.ts`, `scripts/lib/map.test.ts`, `scripts/lib/http.ts`, `docs/fetching.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: removal only — no new exports.

- [ ] **Step 1: Confirm o2o-same has no live consumers**

Run: `grep -rn "o2oToRawHistory\|O2O_SAME_URL\|O2oForId\|O2oResponse\|O2oEntry\|fetchHistory\b" scripts/`
Expected: matches only in `api.ts` (definitions), `map.ts` (`o2oToRawHistory` + `O2oForId` import), `map.test.ts` (the o2o test + `HISTORY` fixture + `O2oForId` import), and `http.ts` (`fetchHistory`). No references in `extract.ts`.

- [ ] **Step 2: Remove from api.ts**

In `scripts/lib/api.ts` delete: the `O2O_SAME_URL` constant, and the `O2oEntry`, `O2oForId`, `O2oResponse` interfaces (the block with the `/** One cross-source posting record from on-market/o2o-same. */` comment through `O2oResponse`).

- [ ] **Step 3: Remove from map.ts**

In `scripts/lib/map.ts`: delete the `o2oToRawHistory` function, and drop `O2oForId` from the `./api.ts` type import (leaving `import type { ListItem, HistoryEntry, OffMarketEntry } from './api.ts';`).

- [ ] **Step 4: Remove the o2o test + fixture from map.test.ts**

In `scripts/lib/map.test.ts`: delete the `o2oToRawHistory turns each source into a raw history row` test, the `HISTORY: O2oForId` fixture, and update the top import to drop `o2oToRawHistory` and `O2oForId` (`import { apiItemToListing, onMarketToRows, offMarketToRows, mergeHistory } from './map.ts';` and `import type { ListItem } from './api.ts';`).

- [ ] **Step 5: Remove fetchHistory from http.ts**

In `scripts/lib/http.ts`: delete the `fetchHistory` function. Drop `O2O_SAME_URL` from the `./api.ts` value import and `O2oResponse` from its type import (they're now unused).

- [ ] **Step 6: Run the full suite + type check**

Run: `npm test 2>&1 | tail -6 && npx tsc --noEmit`
Expected: all tests PASS; `tsc` exits 0 (no unused-symbol or missing-symbol errors).

- [ ] **Step 7: Update docs/fetching.md**

In `docs/fetching.md`, replace the `o2o-same` history section with the two endpoints and the accepted limitation. Use this content (adapt headings to the file's existing style):

```markdown
### Listing history (刊登紀錄)

History is fetched per listing from the two endpoints the live site uses:

- On-market: `GET https://api.ibigfun.com/on-market/{id}/history` — `{id}` is the
  numeric listing id from `search/list`. Returns `{ status, data: [{ source,
  source_id, total (number), subject, add_time, link }] }`, the cross-source
  posting list (each `add_time` is that source's listing date).
- Off-market (下架): `POST https://www.ibigfun.com/api/query_off_market_by_id`
  with form body `id_encode=<uuid>` (the `uuid` from `search/list`, NOT the
  numeric id). Returns `{ status, msg, total_records, data: [{ source, total
  (comma string), add_time, … }] }` — delisted postings (UI shows the latest 10).

On-market rows map to `active: true`, off-market rows to `active: false`; they
are merged (dedup key `source|date|active`) into `listingHistory` and feed
`computeTenure`. Calls run through a concurrency pool (`HISTORY_CONCURRENCY`)
with retry + exponential backoff (`HISTORY_RETRIES`, `HISTORY_RETRY_BASE_MS`).

A listing whose history can't be fetched after retries — or whose on-market
history comes back empty for a still-live listing (a sign of throttling) — is
kept with empty history, logged as a `WARN` with its id, and counted in the
end-of-run summary. Never dropped silently.

**Accepted limitation:** under heavy throttle the API can return `200 ok` with
an empty `data` array, which is indistinguishable from a genuinely-empty result
for off-market records (empty is normal there). This is only flagged for
on-market history (empty-when-live → WARN).
```

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/api.ts scripts/lib/map.ts scripts/lib/map.test.ts scripts/lib/http.ts docs/fetching.md
git commit -m "chore: remove dead o2o-same history path; document history+off-market"
```

---

## Plan Self-Review

**Spec coverage:**
- Both endpoints adopted → Tasks 1–4. ✅
- Body `id_encode=<uuid>` (not numeric id) → Task 1 `buildOffMarketBody`, Task 4 passes `it.uuid`. ✅
- `total` number vs comma-string → Task 2 `totalToPrice` + tests. ✅
- active:true / active:false + merge dedupe `source|date|active` → Task 2 `mergeHistory`. ✅
- Per-listing pool, concurrency 4 → Task 4 `runPool` + `HISTORY_CONCURRENCY`. ✅
- Retry + backoff (3 / 500ms) → Task 3 `withRetry` + config. ✅
- Skip + WARN(id) + dropped counter + summary line → Task 4 + tests. ✅
- Empty on-market-when-live = soft failure → Task 4 + test. ✅
- Empty off-market = normal (no warning) → Task 4 (off-market never triggers the empty-check). ✅
- Signin-kick still handled by withRelogin → Task 3 fetchers wrap `withRelogin` inside `withRetry`. ✅
- `computeTenure`/`types.ts`/enrich untouched → no task modifies them. ✅
- Accepted limitation documented → Task 5 docs. ✅
- Remove o2o-same → Task 5. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✅

**Type consistency:** `historyUrl`/`OFF_MARKET_URL`/`buildOffMarketBody`, `HistoryEntry`/`OffMarketEntry`/`HistoryResponse`/`OffMarketResponse`, `onMarketToRows`/`offMarketToRows`/`mergeHistory`, `withRetry`, `fetchOnMarketHistory`/`fetchOffMarketHistory`, `CollectDeps`, and `apiItemToListing(it, ListingHistoryEntry[])` are named identically across the tasks that define and consume them. ✅
