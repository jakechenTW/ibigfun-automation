# Browserless API-based Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Playwright HTML scraper with iBigFun's JSON APIs reached over pure Node `fetch` (cookie-jar login, no browser).

**Architecture:** A small HTTP/session layer (`http.ts` + pure `cookies.ts`) logs in via a plain form POST and persists a cookie jar. `api.ts` owns the typed `/api/search/list` + `on-market/o2o-same` calls and the POST body. `map.ts` purely converts API JSON to the existing `Listing` shape (plus a few new fields). `extract.ts`'s `collectListings(date)` orchestrates paginate → fetch history → map, with dependency injection so its logic is unit-tested without network. Playwright, `session.ts`, and the DOM selectors are deleted.

**Tech Stack:** TypeScript (ESM, `.ts` import specifiers) run by `tsx`; Node ≥ 20 built-in `fetch` / `Headers.getSetCookie()`; `node:test` runner. No new runtime dependencies.

## Global Constraints

- Node ≥ 20 (uses global `fetch` and `Headers.getSetCookie()`); repo runs Node 26. No new deps.
- ESM only; import siblings with explicit `.ts` specifiers (e.g. `./api.ts`).
- All imports must avoid pulling Playwright; after this plan, `playwright` is removed from `package.json`.
- Never log `IBIGFUN_ACCOUNT` / `IBIGFUN_PASSWORD`. The cookie-jar file is git-ignored. **Never commit captured live API output** (it contains phone numbers / personal data) — tests use small synthetic fixtures only.
- On CAPTCHA / 2FA / account-risk signals, or a login that yields no session cookie, throw `BlockedError` (from `scripts/lib/errors.ts`) — do not bypass (AGENTS.md Safety Rules).
- `Listing` stays a drop-in for downstream `enrich`; values stay display strings except `coordinate`. New fields are additive.
- Tests: `node --import tsx --test <files>`; mirror the existing style (`import { test } from 'node:test'; import assert from 'node:assert/strict'`).
- Captured reference (2026-06-27) for request shapes lives in the session scratchpad (`search-list.json`, `o2o-same.json`, `login-events.json`); not committed.

---

## File Structure

- **Create** `scripts/lib/cookies.ts` — pure cookie jar: parse `Set-Cookie`, serialize `Cookie`, load/save JSON.
- **Create** `scripts/lib/cookies.test.ts`.
- **Create** `scripts/lib/api.ts` — URL constants, response types, `buildSearchBody`, `pageCount`.
- **Create** `scripts/lib/api.test.ts`.
- **Create** `scripts/lib/map.ts` — `apiItemToListing`, o2o→history adapter; pure.
- **Create** `scripts/lib/map.test.ts`.
- **Create** `scripts/lib/http.ts` — `loadEnv`, cookie-jar persistence, `login`, `looksLikeSignin`, `postForm`/`getJson`, `defaultDeps`.
- **Create** `scripts/lib/http.test.ts` — covers the pure `looksLikeSignin`.
- **Modify** `scripts/lib/types.ts` — add `id`, `source`, `sourceLink`, `room`, `livingRoom`, `bathroom` to `Listing`.
- **Rewrite** `scripts/lib/extract.ts` — `collectListings(date, deps?)`, no Playwright.
- **Modify** `scripts/fetch.ts` — drop browser/session; call `collectListings(targetDate)`.
- **Modify** `scripts/lib/config.ts` — add `COOKIE_JAR_PATH`; remove `SELECTORS`, `SELECTORS_VERIFIED`, `STORAGE_STATE_PATH`; keep `SIGNIN_PATH_FRAGMENT`, `BLOCKING_SIGNALS`, `MAX_PAGES`.
- **Delete** `scripts/lib/session.ts`, `scripts/lib/url.ts`, `scripts/lib/url.test.ts`.
- **Modify** `package.json` — remove `playwright`; update `test` file list.
- **Modify** `.gitignore` — add `.cookies.json`.
- **Modify** docs — `AGENTS.md`, `docs/fetching.md`, `docs/credentials.md`.
- **Keep** `scripts/lib/coords.ts` (still provides the `Coordinate` type) and `scripts/lib/history.ts` (`normalizeHistory` reused).

---

## Task 1: Cookie jar (`cookies.ts`)

**Files:**
- Create: `scripts/lib/cookies.ts`
- Test: `scripts/lib/cookies.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Jar = Record<string, string>`
  - `applySetCookies(jar: Jar, setCookies: string[]): void` — mutate jar with `name=value` pairs (ignores attributes like `Path`/`HttpOnly`).
  - `cookieHeader(jar: Jar): string` — `"k1=v1; k2=v2"`.
  - `loadJar(path: string): Jar` — parsed JSON, or `{}` if missing/invalid.
  - `saveJar(path: string, jar: Jar): void` — write pretty JSON.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/lib/cookies.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applySetCookies, cookieHeader, loadJar, saveJar, type Jar } from './cookies.ts';

test('applySetCookies stores name=value and ignores attributes', () => {
  const jar: Jar = {};
  applySetCookies(jar, ['ibigfun_session=abc123; Path=/; HttpOnly; Secure', 'api_token=tok; Secure']);
  assert.equal(jar.ibigfun_session, 'abc123');
  assert.equal(jar.api_token, 'tok');
});

test('applySetCookies overwrites an existing cookie', () => {
  const jar: Jar = { ibigfun_session: 'old' };
  applySetCookies(jar, ['ibigfun_session=new; Path=/']);
  assert.equal(jar.ibigfun_session, 'new');
});

test('cookieHeader joins with "; "', () => {
  assert.equal(cookieHeader({ a: '1', b: '2' }), 'a=1; b=2');
});

test('loadJar returns {} for a missing file, round-trips via saveJar', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jar-')), 'c.json');
  assert.deepEqual(loadJar(p), {});
  saveJar(p, { ibigfun_session: 'z' });
  assert.deepEqual(loadJar(p), { ibigfun_session: 'z' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test scripts/lib/cookies.test.ts`
Expected: FAIL — `Cannot find module './cookies.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/lib/cookies.ts
/**
 * Minimal cookie jar for the browserless fetch flow. Pure + unit-tested.
 * A jar is a plain name->value map so it serializes straight to JSON.
 */
import * as fs from 'node:fs';

export type Jar = Record<string, string>;

/** Merge `Set-Cookie` header values into the jar (name=value only). */
export function applySetCookies(jar: Jar, setCookies: string[]): void {
  for (const sc of setCookies) {
    const pair = sc.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

/** Serialize the jar into a `Cookie` request header. */
export function cookieHeader(jar: Jar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** Load a persisted jar; return {} if the file is missing or unreadable. */
export function loadJar(path: string): Jar {
  try {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Jar) : {};
  } catch {
    return {};
  }
}

/** Persist the jar as pretty JSON. */
export function saveJar(path: string, jar: Jar): void {
  fs.writeFileSync(path, JSON.stringify(jar, null, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test scripts/lib/cookies.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/cookies.ts scripts/lib/cookies.test.ts
git commit -m "feat: cookie jar for browserless fetch"
```

---

## Task 2: API contract — body builder, types, pagination (`api.ts`)

**Files:**
- Create: `scripts/lib/api.ts`
- Test: `scripts/lib/api.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - URL constants: `SIGNIN_URL`, `LOGIN_URL`, `SEARCH_LIST_URL`, `O2O_SAME_URL`.
  - `interface ListItem` — `id, subject, source, link, address, mrt, lat, lng, add_time, total, price_ave, total_ping, floor, total_floor, pattern, house_age_x, parking_type, room, living_room, bathroom, id_encode, uuid` (numbers where numeric, strings otherwise; `house_age_x: number | null`).
  - `interface SearchListResponse` — `status: string; msg: string; total_records: number; per_page: number; current_page: number; data: ListItem[]`.
  - `interface O2oEntry` — `source_id: string; link: string; total: number; add_date: string`.
  - `type O2oForId = Record<string, O2oEntry>` (key = source name).
  - `interface O2oResponse` — `status: string; data: Record<string, O2oForId>`.
  - `buildSearchBody(date: string, page?: number): string` — URL-encoded POST body.
  - `pageCount(total: number, perPage: number): number`.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/lib/api.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchBody, pageCount, SEARCH_LIST_URL } from './api.ts';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test scripts/lib/api.test.ts`
Expected: FAIL — `Cannot find module './api.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/lib/api.ts
/**
 * iBigFun JSON API contract: endpoint URLs, request body builder, response
 * types, and pagination math. The filter + source allow-list mirrors the
 * /api/search/list POST captured from the live site on 2026-06-27 (see
 * docs/fetching.md). Keep this the single source of the request shape.
 */

export const SIGNIN_URL = 'https://www.ibigfun.com/user/signin';
export const LOGIN_URL = 'https://www.ibigfun.com/user/login';
export const SEARCH_LIST_URL = 'https://www.ibigfun.com/api/search/list';
export const O2O_SAME_URL = 'https://api.ibigfun.com/on-market/o2o-same';

/** One listing as returned by /api/search/list (fields we consume). */
export interface ListItem {
  id: number;
  subject: string;
  source: string;
  link: string;
  address: string;
  mrt: string;
  lat: number;
  lng: number;
  add_time: string;
  total: number;
  price_ave: number;
  total_ping: number;
  floor: number;
  total_floor: number;
  pattern: string;
  house_age_x: number | null;
  parking_type: string;
  room: number;
  living_room: number;
  bathroom: number;
  id_encode: string;
  uuid: string;
}

export interface SearchListResponse {
  status: string;
  msg: string;
  total_records: number;
  per_page: number;
  current_page: number;
  data: ListItem[];
}

/** One cross-source posting record from on-market/o2o-same. */
export interface O2oEntry {
  source_id: string;
  link: string;
  total: number;
  add_date: string;
}

/** sourceName -> record, for a single listing id. */
export type O2oForId = Record<string, O2oEntry>;

export interface O2oResponse {
  status: string;
  data: Record<string, O2oForId>;
}

/** Captured allow-lists (2026-06-27). Re-confirm if iBigFun changes sources. */
const SOURCE_WEB = ['370', '462', '371'];
const SOURCE = [
  '372', '373', '592', '382', '383', '384', '465', '381', '380', '374', '375',
  '376', '377', '378', '379', '463', '464', '478', '579', '590',
];

/** Build the URL-encoded /api/search/list POST body for a date + page. */
export function buildSearchBody(date: string, page = 1): string {
  const p = new URLSearchParams();
  p.set('page', String(page));
  p.set('expand', '0');
  p.set('method', 'all_case');
  p.set('on_market', '1');
  p.set('city', '1');
  p.set('price_segment[min_val]', '');
  p.set('price_segment[max_val]', '2500');
  p.set('floor_segment[min_val]', '2');
  p.set('floor_segment[max_val]', '4');
  p.set('total_floor[min_val]', '');
  p.set('total_floor[max_val]', '5');
  p.set('add_date', date);
  p.set('add_date_max', date);
  for (const s of SOURCE_WEB) p.append('source_web[]', s);
  for (const s of SOURCE) p.append('source[]', s);
  p.set('exclude_land', '1');
  return p.toString();
}

/** Number of result pages for a total at `perPage` per page. */
export function pageCount(total: number, perPage: number): number {
  if (!perPage || perPage <= 0) return 0;
  return Math.ceil((total || 0) / perPage);
}
```

Note: `URLSearchParams` encodes `[` as `%5B` and `]` as `%5D`, matching the captured body.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test scripts/lib/api.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/api.ts scripts/lib/api.test.ts
git commit -m "feat: iBigFun API contract (body builder, types, pagination)"
```

---

## Task 3: JSON → Listing mapping (`map.ts`) + `Listing` new fields

**Files:**
- Modify: `scripts/lib/types.ts` (add fields to `Listing`)
- Create: `scripts/lib/map.ts`
- Test: `scripts/lib/map.test.ts`

**Interfaces:**
- Consumes: `ListItem`, `O2oForId` (Task 2); `normalizeHistory`, `RawHistoryRow` (`history.ts`); `Coordinate` (`coords.ts`); `Listing`, `ListingHistoryEntry` (`types.ts`).
- Produces:
  - `apiItemToListing(item: ListItem, historyForId: O2oForId): Listing`.
  - `o2oToRawHistory(forId: O2oForId): RawHistoryRow[]` (exported for the test).

- [ ] **Step 1: Add the new fields to `Listing`**

In `scripts/lib/types.ts`, inside `interface Listing`, immediately after the
`listingHistory: ListingHistoryEntry[];` line, add:

```ts
  /** Stable iBigFun listing id (also the o2o-same key); null if absent. */
  id: number | null;
  /** Origin platform label, e.g. "樂屋"; null if absent. */
  source: string | null;
  /** Canonical source-site URL for the listing (same value as `url`). */
  sourceLink: string | null;
  /** Room counts parsed by iBigFun; null if absent. */
  room: number | null;
  livingRoom: number | null;
  bathroom: number | null;
```

- [ ] **Step 2: Write the failing test**

```ts
// scripts/lib/map.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiItemToListing, o2oToRawHistory } from './map.ts';
import { computeTenure } from './tenure.ts';
import type { ListItem, O2oForId } from './api.ts';

const ITEM: ListItem = {
  id: 53199422,
  subject: '國語實小學區低總首購美寓',
  source: '樂屋',
  link: 'https://www.rakuya.com.tw/sell_item/info?ehid=051d9a345427898',
  address: '台北市中正區汀州路一段',
  mrt: '植物園站(施工中)',
  lat: 25.0271901,
  lng: 121.5108709,
  add_time: '2026-06-26 23:34:22',
  total: 1588,
  price_ave: 90.2,
  total_ping: 17.61,
  floor: 4,
  total_floor: 4,
  pattern: '3房2廳1衛',
  house_age_x: 49.4,
  parking_type: '無車位',
  room: 3,
  living_room: 2,
  bathroom: 1,
  id_encode: '2lrnjfzqiahur',
  uuid: 'A_1FF424',
};

const HISTORY: O2oForId = {
  '591': { source_id: '20167211', link: 'x', total: 1790, add_date: '2026-05-09' },
  '中信房屋': { source_id: '2036990', link: 'y', total: 1790, add_date: '2025-06-21' },
};

test('apiItemToListing maps core fields from typed JSON', () => {
  const l = apiItemToListing(ITEM, {});
  assert.equal(l.title, '國語實小學區低總首購美寓');
  assert.equal(l.url, 'https://www.rakuya.com.tw/sell_item/info?ehid=051d9a345427898');
  assert.equal(l.addressOrArea, '台北市中正區汀州路一段');
  assert.equal(l.nearbyStation, '植物園站(施工中)');
  assert.deepEqual(l.coordinate, { lat: 25.0271901, lng: 121.5108709 });
  assert.equal(l.publishedDate, '2026-06-26'); // date only
  assert.equal(l.totalPrice, '1588');
  assert.equal(l.unitPrice, '90.2');
  assert.equal(l.totalPing, '17.61');
  assert.equal(l.floor, '4');
  assert.equal(l.totalFloors, '4');
  assert.equal(l.typeLayout, '3房2廳1衛');
  assert.equal(l.age, '49.4');
  assert.equal(l.parking, '無車位');
  assert.equal(l.realPriceUrl, null);
});

test('apiItemToListing fills the new structured fields', () => {
  const l = apiItemToListing(ITEM, {});
  assert.equal(l.id, 53199422);
  assert.equal(l.source, '樂屋');
  assert.equal(l.sourceLink, ITEM.link);
  assert.equal(l.room, 3);
  assert.equal(l.livingRoom, 2);
  assert.equal(l.bathroom, 1);
});

test('o2oToRawHistory turns each source into a raw history row', () => {
  const rows = o2oToRawHistory(HISTORY);
  assert.equal(rows.length, 2);
  const cic = rows.find((r) => r.source === '中信房屋');
  assert.deepEqual(cic, { price: '1790', source: '中信房屋', date: '2025-06-21', active: true });
});

test('listingHistory feeds tenure: earliest add_date is first listed', () => {
  const l = apiItemToListing(ITEM, HISTORY);
  assert.equal(l.listingHistory.length, 2);
  const t = computeTenure(l.listingHistory, '2026-06-26');
  assert.equal(t.firstListedDate, '2025-06-21');
  assert.equal(t.sourceCount, 2);
});

test('empty history maps to an empty listingHistory array', () => {
  assert.deepEqual(apiItemToListing(ITEM, {}).listingHistory, []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import tsx --test scripts/lib/map.test.ts`
Expected: FAIL — `Cannot find module './map.ts'`.

- [ ] **Step 4: Write minimal implementation**

```ts
// scripts/lib/map.ts
/**
 * Pure mapping from iBigFun's /api/search/list + on-market/o2o-same JSON into
 * the normalized `Listing`. Values stay as display strings (downstream enrich
 * parses numbers) except `coordinate`. No network, no DOM — unit-tested.
 */
import type { ListItem, O2oForId } from './api.ts';
import type { Coordinate } from './coords.ts';
import type { Listing } from './types.ts';
import { normalizeHistory, type RawHistoryRow } from './history.ts';

/** Stringify a numeric field, or null when it is null/undefined. */
function numStr(n: number | null | undefined): string | null {
  return n === null || n === undefined ? null : String(n);
}

/** Build a Coordinate from lat/lng when both are finite, else null. */
function coordinateOf(it: ListItem): Coordinate | null {
  if (Number.isFinite(it.lat) && Number.isFinite(it.lng) && (it.lat !== 0 || it.lng !== 0)) {
    return { lat: it.lat, lng: it.lng };
  }
  return null;
}

/** Convert one listing's o2o-same map into raw history rows (all active). */
export function o2oToRawHistory(forId: O2oForId): RawHistoryRow[] {
  return Object.entries(forId).map(([source, e]) => ({
    price: e.total !== null && e.total !== undefined ? String(e.total) : null,
    source,
    date: e.add_date ?? null,
    active: true, // o2o-same exposes no 下架 flag; see spec fidelity note
  }));
}

/** Map one API item (+ its history) to a Listing. */
export function apiItemToListing(it: ListItem, historyForId: O2oForId): Listing {
  return {
    title: it.subject ?? '',
    url: it.link || null,
    addressOrArea: it.address || null,
    nearbyStation: it.mrt || null,
    coordinate: coordinateOf(it),
    publishedDate: it.add_time ? it.add_time.slice(0, 10) : null,
    totalPrice: numStr(it.total),
    totalPing: numStr(it.total_ping),
    unitPrice: numStr(it.price_ave),
    floor: numStr(it.floor),
    totalFloors: numStr(it.total_floor),
    typeLayout: it.pattern || null,
    age: numStr(it.house_age_x),
    parking: it.parking_type || null,
    realPriceUrl: null, // not exposed by the API; intentionally dropped
    listingHistory: normalizeHistory(o2oToRawHistory(historyForId)),
    id: it.id ?? null,
    source: it.source || null,
    sourceLink: it.link || null,
    room: it.room ?? null,
    livingRoom: it.living_room ?? null,
    bathroom: it.bathroom ?? null,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test scripts/lib/map.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/types.ts scripts/lib/map.ts scripts/lib/map.test.ts
git commit -m "feat: map iBigFun API JSON to Listing (+ structured fields)"
```

---

## Task 4: HTTP/session layer (`http.ts`)

**Files:**
- Modify: `scripts/lib/config.ts` (add `COOKIE_JAR_PATH`)
- Create: `scripts/lib/http.ts`
- Test: `scripts/lib/http.test.ts`

**Interfaces:**
- Consumes: `cookies.ts`; `api.ts` URL constants + `buildSearchBody` + types; `config.ts` (`SIGNIN_PATH_FRAGMENT`, `BLOCKING_SIGNALS`, `COOKIE_JAR_PATH`); `relogin.ts` (`openWithRelogin`); `errors.ts` (`BlockedError`).
- Produces:
  - `loadEnv(path?: string): void` (moved from `session.ts`).
  - `looksLikeSignin(res: { status: number; finalUrl: string; contentType: string }): boolean`.
  - `defaultDeps(): CollectDeps` (the shape `CollectDeps` is defined in Task 5; `http.ts` imports it from `extract.ts`). To avoid a circular import, define `CollectDeps` in `extract.ts` and have `http.ts` import the type only.

> Implementation note: only the pure `looksLikeSignin` is unit-tested here; `login`/`postForm`/`getJson` are network code exercised by the live smoke in Task 7. The relogin loop they use is already covered by `relogin.test.ts`.

- [ ] **Step 1: Add the cookie-jar path constant to config**

In `scripts/lib/config.ts`, replace the `STORAGE_STATE_PATH` declaration (the last lines of the file) with:

```ts
/** Where the cookie jar is cached between runs (git-ignored). */
export const COOKIE_JAR_PATH = '.cookies.json';
```

(Leave `SIGNIN_PATH_FRAGMENT`, `BLOCKING_SIGNALS`, and `MAX_PAGES` in place. `SELECTORS`/`SELECTORS_VERIFIED` are removed in Task 6.)

- [ ] **Step 2: Write the failing test**

```ts
// scripts/lib/http.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSignin } from './http.ts';

test('a redirect to /user/signin is a kick', () => {
  assert.equal(
    looksLikeSignin({ status: 302, finalUrl: 'https://www.ibigfun.com/user/signin?return_url=/x', contentType: 'text/html' }),
    true,
  );
});

test('an HTML body on a data URL (logged out) is a kick', () => {
  assert.equal(
    looksLikeSignin({ status: 200, finalUrl: 'https://www.ibigfun.com/api/search/list', contentType: 'text/html; charset=utf-8' }),
    true,
  );
});

test('a 200 JSON response is not a kick', () => {
  assert.equal(
    looksLikeSignin({ status: 200, finalUrl: 'https://www.ibigfun.com/api/search/list', contentType: 'application/json; charset=UTF-8' }),
    false,
  );
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import tsx --test scripts/lib/http.test.ts`
Expected: FAIL — `Cannot find module './http.ts'`.

- [ ] **Step 4: Write minimal implementation**

```ts
// scripts/lib/http.ts
/**
 * Browserless HTTP/session layer. Logs in via a plain form POST, persists a
 * cookie jar, and calls the iBigFun JSON APIs with those cookies. Reuses the
 * pure relogin loop (relogin.ts) to recover from a mid-run session kick.
 */
import { SIGNIN_URL, LOGIN_URL, SEARCH_LIST_URL, O2O_SAME_URL, buildSearchBody } from './api.ts';
import type { SearchListResponse, O2oResponse } from './api.ts';
import { applySetCookies, cookieHeader, loadJar, saveJar, type Jar } from './cookies.ts';
import { SIGNIN_PATH_FRAGMENT, BLOCKING_SIGNALS, COOKIE_JAR_PATH } from './config.ts';
import { openWithRelogin } from './relogin.ts';
import { BlockedError } from './errors.ts';
import type { CollectDeps } from './extract.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Load project-local .env into process.env without overwriting existing vars. */
export function loadEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Missing .env is fine if vars are already exported; login fails loudly later.
  }
}

let jar: Jar | null = null;
function getJar(): Jar {
  if (jar === null) jar = loadJar(COOKIE_JAR_PATH);
  return jar;
}

/** True when a data response actually returned the signin page (a kick). */
export function looksLikeSignin(res: { status: number; finalUrl: string; contentType: string }): boolean {
  if (res.finalUrl.includes(SIGNIN_PATH_FRAGMENT)) return true;
  // A data endpoint returning HTML means we were bounced to a login page.
  if (!res.finalUrl.includes(SIGNIN_PATH_FRAGMENT) && res.contentType.includes('text/html')) {
    const isDataUrl = res.finalUrl.includes('/api/') || res.finalUrl.includes('o2o-same');
    if (isDataUrl) return true;
  }
  return false;
}

async function rawGet(url: string): Promise<{ status: number; finalUrl: string; contentType: string; text: string; setCookies: string[] }> {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, cookie: cookieHeader(getJar()), accept: 'application/json, text/javascript, */*; q=0.01' },
    redirect: 'manual',
  });
  return {
    status: r.status,
    finalUrl: r.headers.get('location') ?? url,
    contentType: r.headers.get('content-type') ?? '',
    text: await r.text(),
    setCookies: (r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [],
  };
}

async function rawPostForm(url: string, body: string, referer: string): Promise<{ status: number; finalUrl: string; contentType: string; text: string; setCookies: string[] }> {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json, text/javascript, */*; q=0.01',
      cookie: cookieHeader(getJar()),
      referer,
    },
    body,
    redirect: 'manual',
  });
  return {
    status: r.status,
    finalUrl: r.headers.get('location') ?? url,
    contentType: r.headers.get('content-type') ?? '',
    text: await r.text(),
    setCookies: (r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [],
  };
}

/** GET signin (prime cookies + scan for blocking controls), then POST login. */
export async function login(): Promise<void> {
  const j = getJar();
  const s = await fetch(SIGNIN_URL, { headers: { 'user-agent': UA, cookie: cookieHeader(j) }, redirect: 'manual' });
  applySetCookies(j, (s.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []);
  const body = (await s.text()).toLowerCase();
  const hit = BLOCKING_SIGNALS.find((sig) => body.includes(sig.toLowerCase()));
  if (hit) {
    throw new BlockedError(
      `Login is gated by a control ("${hit}") that must not be bypassed. Complete it manually, then re-run.`,
    );
  }
  const account = process.env.IBIGFUN_ACCOUNT;
  const password = process.env.IBIGFUN_PASSWORD;
  if (!account || !password) {
    throw new BlockedError('Missing IBIGFUN_ACCOUNT / IBIGFUN_PASSWORD. Copy .env.example to .env (see docs/credentials.md).');
  }
  const form = new URLSearchParams({ mobile: account, password, return_url: '' }).toString();
  const l = await rawPostForm(LOGIN_URL, form, SIGNIN_URL);
  applySetCookies(j, l.setCookies);
  if (!j.ibigfun_session) {
    throw new BlockedError('Login did not establish a session cookie; credentials or login flow may have changed.');
  }
  saveJar(COOKIE_JAR_PATH, j);
}

/** Run a request, re-logging-in and retrying if bounced to signin. */
async function withRelogin<T>(attempt: () => Promise<{ kicked: boolean; value?: T }>): Promise<T> {
  let out: T | undefined;
  await openWithRelogin({
    navigate: async () => {
      const r = await attempt();
      if (r.kicked) return SIGNIN_URL;
      out = r.value;
      return SEARCH_LIST_URL;
    },
    login: () => login(),
    isSignin: (u) => u.includes(SIGNIN_PATH_FRAGMENT),
    maxRelogin: 2,
    onRelogin: () =>
      console.error('  session was kicked (account logged in elsewhere); re-logging in — this logs out any other session.'),
  });
  return out as T;
}

async function fetchPage(date: string, page: number): Promise<SearchListResponse> {
  return withRelogin(async () => {
    const r = await rawPostForm(SEARCH_LIST_URL, buildSearchBody(date, page), 'https://www.ibigfun.com/lists/latest');
    applySetCookies(getJar(), r.setCookies);
    if (looksLikeSignin(r)) return { kicked: true };
    return { kicked: false, value: JSON.parse(r.text) as SearchListResponse };
  });
}

async function fetchHistory(ids: number[]): Promise<O2oResponse['data']> {
  if (ids.length === 0) return {};
  return withRelogin(async () => {
    const r = await rawGet(`${O2O_SAME_URL}?ids=${ids.join('%2C')}`);
    applySetCookies(getJar(), r.setCookies);
    if (looksLikeSignin(r)) return { kicked: true };
    return { kicked: false, value: (JSON.parse(r.text) as O2oResponse).data ?? {} };
  });
}

/** Ensure we hold a session: log in when the jar has no session cookie. */
async function ensureSession(): Promise<void> {
  if (!getJar().ibigfun_session) await login();
}

/** Real dependencies for collectListings (network-backed). */
export function defaultDeps(): CollectDeps {
  return { ensureSession, fetchPage, fetchHistory };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test scripts/lib/http.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/config.ts scripts/lib/http.ts scripts/lib/http.test.ts
git commit -m "feat: browserless HTTP/session layer with relogin"
```

---

## Task 5: Rewrite `collectListings` + `fetch.ts`

**Files:**
- Rewrite: `scripts/lib/extract.ts`
- Modify: `scripts/fetch.ts`
- Test: `scripts/lib/extract.test.ts` (new)

**Interfaces:**
- Consumes: `api.ts` (`SearchListResponse`, `O2oResponse`, `pageCount`); `map.ts` (`apiItemToListing`); `http.ts` (`defaultDeps`); `config.ts` (`MAX_PAGES`); `types.ts` (`Listing`).
- Produces:
  - `interface CollectDeps { ensureSession: () => Promise<void>; fetchPage: (date: string, page: number) => Promise<SearchListResponse>; fetchHistory: (ids: number[]) => Promise<O2oResponse['data']>; }`
  - `collectListings(date: string, deps?: CollectDeps): Promise<Listing[]>`

- [ ] **Step 1: Write the failing test (pagination with fake deps)**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test scripts/lib/extract.test.ts`
Expected: FAIL — current `extract.ts` exports a different `collectListings` signature / imports Playwright.

- [ ] **Step 3: Rewrite `extract.ts`**

Replace the entire contents of `scripts/lib/extract.ts` with:

```ts
/**
 * Collect the filtered target-date listings from iBigFun's JSON APIs (no
 * browser). Paginates /api/search/list by total_records/per_page, fetches the
 * cross-source history per page, and maps each item to a Listing. The HTTP
 * deps are injected so the pagination logic is unit-tested without network.
 */
import type { Listing } from './types.ts';
import { MAX_PAGES } from './config.ts';
import { pageCount, type SearchListResponse, type O2oResponse } from './api.ts';
import { apiItemToListing } from './map.ts';
import { defaultDeps } from './http.ts';

export interface CollectDeps {
  ensureSession: () => Promise<void>;
  fetchPage: (date: string, page: number) => Promise<SearchListResponse>;
  fetchHistory: (ids: number[]) => Promise<O2oResponse['data']>;
}

export async function collectListings(date: string, deps: CollectDeps = defaultDeps()): Promise<Listing[]> {
  await deps.ensureSession();

  const first = await deps.fetchPage(date, 1);
  const pages = Math.min(pageCount(first.total_records, first.per_page), MAX_PAGES);
  const all: Listing[] = [];

  for (let p = 1; p <= Math.max(pages, 1); p++) {
    const res = p === 1 ? first : await deps.fetchPage(date, p);
    if (!res.data || res.data.length === 0) break;
    const ids = res.data.map((it) => it.id);
    const history = await deps.fetchHistory(ids);
    for (const it of res.data) {
      all.push(apiItemToListing(it, history[String(it.id)] ?? {}));
    }
  }
  return all;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test scripts/lib/extract.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Update `fetch.ts` to the browserless flow**

In `scripts/fetch.ts`:

Replace the three import lines:

```ts
import { SELECTORS_VERIFIED } from './lib/config.ts';
import { loadEnv, createSession } from './lib/session.ts';
import { BlockedError } from './lib/errors.ts';
import { collectListings } from './lib/extract.ts';
```

with:

```ts
import { BlockedError } from './lib/errors.ts';
import { loadEnv } from './lib/http.ts';
import { collectListings } from './lib/extract.ts';
```

Delete the `if (!SELECTORS_VERIFIED) { ... }` block entirely.

Replace the session/try/finally body (`const { browser, context, page } = await createSession(); try { const listings = await collectListings(page, context, targetDate); ... } finally { await browser.close(); }`) with:

```ts
  loadEnv();
  const listings = await collectListings(targetDate);
  const result: FetchResult = {
    targetDate,
    fetchedAt: new Date().toISOString(),
    count: listings.length,
    listings,
  };

  fs.mkdirSync('state', { recursive: true });
  const outPath = path.join('state', `listings-${targetDate}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.error(`Wrote ${listings.length} listings to ${outPath}`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
```

(`loadEnv()` may already appear earlier in `main()`; ensure it is called exactly once, before `collectListings`.)

- [ ] **Step 6: Verify fetch.ts type-checks against the new signature**

Run: `npx tsc --noEmit -p .` (if a `tsconfig.json` exists) **or** `npx tsx --eval "import('./scripts/fetch.ts')"` to confirm no import/type errors.
Expected: no errors about `createSession`, `SELECTORS_VERIFIED`, or `collectListings` arity.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/extract.ts scripts/lib/extract.test.ts scripts/fetch.ts
git commit -m "feat: browserless collectListings via JSON APIs"
```

---

## Task 6: Remove Playwright, dead modules, and DOM config

**Files:**
- Delete: `scripts/lib/session.ts`, `scripts/lib/url.ts`, `scripts/lib/url.test.ts`
- Modify: `scripts/lib/config.ts` (remove `SELECTORS`, `SELECTORS_VERIFIED`)
- Modify: `package.json` (remove `playwright`; update `test` list)
- Modify: `.gitignore` (add `.cookies.json`)

**Interfaces:** none produced.

- [ ] **Step 1: Confirm nothing still imports the modules to be deleted**

Run:
```bash
grep -rn "session.ts\|from './lib/url\|from './url\|SELECTORS\|createSession\|from 'playwright'" scripts
```
Expected: no matches in non-deleted files (only `config.ts`'s own `SELECTORS` definition, removed next). If any remain, fix the importer before deleting.

- [ ] **Step 2: Delete the dead modules**

```bash
git rm scripts/lib/session.ts scripts/lib/url.ts scripts/lib/url.test.ts
```

- [ ] **Step 3: Remove the DOM selectors from `config.ts`**

In `scripts/lib/config.ts`, delete the `SELECTORS_VERIFIED` export and the entire `SELECTORS` object (the `login` + `list`/`td` blocks). Keep `SIGNIN_PATH_FRAGMENT`, `BLOCKING_SIGNALS`, `MAX_PAGES`, and the `COOKIE_JAR_PATH` added in Task 4. Update the file's top doc comment to describe API config rather than DOM selectors.

- [ ] **Step 4: Remove Playwright and update the test list in `package.json`**

In `scripts/lib/...` test list (line 11), remove `scripts/lib/url.test.ts` and add the new tests. The `test` script becomes:

```json
"test": "node --import tsx --test scripts/lib/date.test.ts scripts/lib/coords.test.ts scripts/lib/floor.test.ts scripts/lib/parse.test.ts scripts/lib/geo.test.ts scripts/lib/finance.test.ts scripts/lib/exclude.test.ts scripts/lib/mrt.test.ts scripts/lib/districts.test.ts scripts/lib/enrich-offline.test.ts scripts/lib/walk.test.ts scripts/lib/history.test.ts scripts/lib/relogin.test.ts scripts/lib/tenure.test.ts scripts/lib/cookies.test.ts scripts/lib/api.test.ts scripts/lib/map.test.ts scripts/lib/http.test.ts scripts/lib/extract.test.ts"
```

Remove the `"playwright": "^1.48.0",` line from `devDependencies`.

- [ ] **Step 5: Add the cookie jar to `.gitignore`**

In `.gitignore`, under the session line, add:

```
.cookies.json
```

(Leave the existing `storageState.json` line; it is harmless.)

- [ ] **Step 6: Reinstall to drop Playwright and run the full suite**

```bash
npm install
npm test
```
Expected: install removes `playwright`; all tests pass (existing + `cookies`, `api`, `map`, `http`, `extract`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove Playwright, DOM selectors, and dead modules"
```

---

## Task 7: Live smoke test + docs

**Files:**
- Modify: `AGENTS.md`, `docs/fetching.md`, `docs/credentials.md`

**Interfaces:** none.

- [ ] **Step 1: Run the real fetch end-to-end (manual, opt-in)**

> This performs a real login and **logs out any other iBigFun session** for the shared account (expected).

```bash
npm run fetch -- --date 2026-06-26
```
Expected: writes `state/listings-2026-06-26.json` with a non-zero `count`; spot-check that a listing has `totalPrice`, `coordinate`, and (for a property with cross-source history) a populated `listingHistory`. Do **not** commit `state/`.

- [ ] **Step 2: Verify a listing that has 下架 history (fidelity caveat)**

Pick a listing whose iBigFun page shows a 下架 record. Confirm whether o2o-same omits it. Record the finding in `docs/fetching.md` (Step 4): either "o2o-same returns only active cross-source records; 下架 rows are not represented (all `active: true`)" or, if delisted rows do appear, adjust `o2oToRawHistory` to set `active` accordingly and update `map.test.ts`.

- [ ] **Step 3: Update `AGENTS.md`**

- In **First Run — Prerequisites**, remove `npx playwright install chromium` from the toolchain line and drop the "A browser tool is available for the fetch step" checkbox.
- In **Tooling**, change the fetch bullet from "Playwright scraper. Logs in from `.env`, paginates the filtered view…" to "Browserless fetch. Logs in from `.env` via a form POST, calls iBigFun's JSON APIs (`/api/search/list` + `on-market/o2o-same`), paginates by `total_records`, writes normalized listings to `state/listings-<target>.json`."

- [ ] **Step 4: Rewrite `docs/fetching.md`**

Replace the DOM-selector / browser content with the API flow: the two endpoints, the captured POST filter + `source[]`/`source_web[]` allow-list (with the 2026-06-27 capture date), the `total_records`/`per_page` pagination, the field mapping table (from the spec), and the history-fidelity note from Step 2. State that re-confirming means re-capturing the request via browser devtools, not re-checking selectors.

- [ ] **Step 5: Update `docs/credentials.md`**

Note that the session is now a cookie jar persisted to `.cookies.json` (git-ignored), replacing `storageState.json`; login is a form POST to `/user/login`; on CAPTCHA/2FA/risk the run raises `BlockedError` and stops.

- [ ] **Step 6: Run the suite once more and commit docs**

```bash
npm test
git add AGENTS.md docs/fetching.md docs/credentials.md
git commit -m "docs: browserless API fetch (AGENTS, fetching, credentials)"
```

---

## Self-Review notes

- **Spec coverage:** http/session layer (T4), api.ts + body/source allow-list (T2), map.ts + new fields (T3), o2o-same history + fidelity caveat (T3 + T7 S2), browserless collectListings + relogin reuse (T5 + T4), Playwright/session/selector removal (T6), pagination via total_records (T2 `pageCount`, T5), error handling/BlockedError (T4), testing with synthetic fixtures (T1–T5), docs (T7). All spec sections map to a task.
- **realPriceUrl:** spec left this derivable; plan makes the concrete decision to map it to `null` (the field is `string | null`; downstream tolerates null) — no placeholder.
- **Type consistency:** `CollectDeps` defined in `extract.ts`, imported as a type by `http.ts` (one-directional type import avoids a cycle). `SearchListResponse`/`O2oForId`/`ListItem` names are used identically across `api.ts`, `map.ts`, `http.ts`, `extract.ts`.
