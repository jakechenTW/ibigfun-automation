# 刊登紀錄 via real `history` + `query_off_market_by_id` — Design

**Date:** 2026-06-27
**Status:** Approved (design), pending implementation plan
**Branch:** `feat/listing-history-real-apis`

## Problem

The scraper's 刊登紀錄 (cross-source listing history) is coming back empty
("都抓不到"). Today history is fetched from a single batched endpoint:

- `GET https://api.ibigfun.com/on-market/o2o-same?ids=<id,id,…>`

mapped by `o2oToRawHistory` into `listingHistory`, which feeds `computeTenure`
(`firstListedDate` / days-on-market).

The live site no longer drives 刊登紀錄 from `o2o-same`. Clicking 刊登紀錄 on a
listing fires **two** calls instead:

1. `history` — the on-market cross-source posting list.
2. `query_off_market_by_id` — the 下架 (delisted / off-market) posting records.

`o2o-same` still returns data in-browser (same source counts as `history` for
the listings checked), so the breakage is most likely in our **Node code
path**, not the endpoint. The chosen direction is to stop depending on
`o2o-same` and use the two endpoints the real page uses — which are also
strictly richer (older relistings; a real active/inactive flag).

## Captured endpoint contracts (verified 2026-06-27, live)

### A) On-market history
```
GET https://api.ibigfun.com/on-market/{id}/history
```
- `{id}` = the numeric listing id from `search/list` (path segment, not a query).
- Response:
```json
{ "status": "ok", "data": [
  { "source": "樂屋網", "source_id": "…", "total": 1688,
    "subject": "…", "add_time": "2026-06-27", "link": "https://…" },
  { "source": "信義房屋", "total": 1688, "add_time": "2026-06-26", … },
  { "source": "永慶房屋", "total": 4680, "add_time": "2026-03-17", … }
] }
```
- `total` is a **number**. `data` is a flat array of currently-listed
  cross-source postings; each `add_time` is that source's listing date.
- A currently-listed property always has ≥1 on-market source (its own), so an
  **empty** array for a live listing is suspicious (treated as a soft failure
  — see §5).

### B) Off-market history
```
POST https://www.ibigfun.com/api/query_off_market_by_id
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
body: id_encode=<uuid>
```
- `<uuid>` = the `uuid` field from `search/list` (the page uses `row.uuid`),
  **not** the numeric id. Passing the numeric `id` returns an empty result.
- Response:
```json
{ "status": "ok", "msg": "", "total_records": N, "data": [
  { "source": "住商", "source_id": "…", "total": "1,234",
    "subject": "…", "add_time": "YYYY-MM-DD", "link": "…",
    "search_args": {…}, "o2o_same": {…}, "history": [], "id_encode": "…",
    "address_k": null, "has_buy_life_func": 0, "has_precise_addr": 0 }
] }
```
- These are **下架 (delisted)** postings; the UI shows the latest 10. `total`
  is a **string with commas** here (vs. a number in `history`).
- An **empty** array is normal — a listing may have no off-market records.

Both endpoints require the logged-in session cookies. `history` is on
`api.ibigfun.com` (like the old `o2o-same`); `query_off_market_by_id` is on
`www.ibigfun.com`. The existing flat cookie jar already sends all cookies to
both hosts.

## Decisions (from brainstorming)

- **Scope:** adopt **both** endpoints (full posting record incl. 下架), giving a
  true active/inactive flag and the earliest possible `firstListedDate`.
- **Per-listing failure policy:** after retries/backoff are exhausted for a
  listing, **skip that listing, warn loudly (with its id), and continue**; emit
  a summary count so dropped history is never silent.
- **Concurrency / retries (chosen defaults):** pool of **4** in-flight listings,
  **3** retries, **500 ms** base exponential backoff. The site actively
  throttles (a "資料庫忙碌中" DB-busy modal was observed during discovery).
- **Dedupe key:** `source + date + active`.

## Architecture & data flow

`search/list` already returns both `id` and `uuid` per listing. For each
listing:

```
            ┌─ GET  api.ibigfun.com/on-market/{id}/history      → active:true rows
listing ───┤
            └─ POST www.ibigfun.com/api/query_off_market_by_id  → active:false rows
                     body: id_encode={uuid}
                              │
                merge + dedupe → ListingHistoryEntry[] → computeTenure (unchanged)
```

`computeTenure`, `ListingHistoryEntry` (which already has an `active` flag),
`normalizeHistory`, `firstNumber` (already strips commas), and the enrich layer
are **untouched**. The change is contained to the fetch/map/orchestration layer.

## Components

### `scripts/lib/api.ts` — contract (replaces o2o-same)
- Remove `O2O_SAME_URL` and `O2oEntry` / `O2oForId` / `O2oResponse`.
- Add:
  - `historyUrl(id: number): string` → `https://api.ibigfun.com/on-market/${id}/history`
  - `OFF_MARKET_URL = 'https://www.ibigfun.com/api/query_off_market_by_id'`
  - `buildOffMarketBody(uuid: string): string` → `id_encode=<encoded>`
  - `interface HistoryEntry { source: string; source_id: string; total: number;
    subject: string; add_time: string; link: string }`
  - `interface HistoryResponse { status: string; data: HistoryEntry[] }`
  - `interface OffMarketEntry { source: string; source_id: string;
    total: string | number; subject: string; add_time: string; link: string }`
    (only the fields we consume)
  - `interface OffMarketResponse { status: string; msg: string;
    total_records: number; data: OffMarketEntry[] }`

### `scripts/lib/http.ts` — per-listing fetch
- Replace batched `fetchHistory(ids)` with:
  - `fetchOnMarketHistory(id: number): Promise<HistoryEntry[]>` — GET,
    `withRelogin`, `assertApiOk`, returns `parsed.data ?? []`.
  - `fetchOffMarketHistory(uuid: string): Promise<OffMarketEntry[]>` — POST form
    (`buildOffMarketBody`), `x-requested-with`, `withRelogin`, `assertApiOk`,
    returns `parsed.data ?? []`.
- Add `withRetry(fn, { retries, baseMs })`: retries on **thrown** errors
  (non-200 / `status !== "ok"` / HTML-bounce surfaced by `assertApiOk` /
  network) with exponential backoff (`baseMs * 2^attempt`). An empty `data: []`
  is a valid result and is **not** retried. Session kicks remain handled by the
  existing `withRelogin` inside each call.

### `scripts/lib/map.ts` — mappers + merge
- Drop `o2oToRawHistory`. Add:
  - `onMarketToRows(entries: HistoryEntry[]): RawHistoryRow[]` — `active: true`,
    `price = String(total)`.
  - `offMarketToRows(entries: OffMarketEntry[]): RawHistoryRow[]` —
    `active: false`, `price = String(total)` (commas preserved; `firstNumber`
    parses them later).
  - `mergeHistory(onRows, offRows): ListingHistoryEntry[]` — concat, dedupe by
    `source|date|active`, then `normalizeHistory`.
- Change `apiItemToListing(it, history: ListingHistoryEntry[])` to take the
  pre-merged history instead of an o2o map.

### `scripts/lib/extract.ts` — orchestration (skip / warn / summary)
- `CollectDeps`: replace `fetchHistory` with `fetchOnMarketHistory` and
  `fetchOffMarketHistory`.
- Run a concurrency pool (`HISTORY_CONCURRENCY`) over the page's listings. Each
  task fetches both endpoints (each wrapped in `withRetry`), merges via
  `mergeHistory`, and attaches the result to the listing.
- A task that still fails after retries → `console.error` **WARN** with the
  listing id, keep the listing with empty `listingHistory`, increment a dropped
  counter. An **empty on-market history for a live listing** is treated the same
  way (suspicious; likely throttle).
- Emit a summary line at the end:
  `history: <ok> listings ok, <dropped> dropped (see WARN above)`.

### `scripts/lib/config.ts` — knobs
- `HISTORY_CONCURRENCY = 4`
- `HISTORY_RETRIES = 3`
- `HISTORY_RETRY_BASE_MS = 500`

## Error handling

- Transient API failures (non-200, `status !== "ok"`, HTML bounce that is not a
  signin kick) → retried with backoff by `withRetry`, then surfaced as a
  per-listing failure (skip + WARN + counter).
- Signin kicks (shared-login eviction) → existing `withRelogin` re-logs-in and
  retries the single call.
- Empty off-market `data` → normal, no warning.
- Empty on-market `data` for a live listing → soft failure (WARN + counter).

## Testing

- `api.test.ts`: `historyUrl(id)`, `buildOffMarketBody(uuid)`, response type
  round-trips.
- `map.test.ts`: `onMarketToRows` (numeric `total`), `offMarketToRows`
  (comma-string `total`), `mergeHistory` dedupe + active flags, empty inputs.
- `http.test.ts`: `withRetry` backoff + give-up, `assertApiOk` paths, off-market
  form body shape. (No network — pure/injected.)
- `extract.test.ts`: pool orchestration with an injected failing listing and an
  injected empty-on-market listing → asserts skip, WARN, and the summary count.

## Accepted limitation

Under heavy throttle the API can return `200 ok` with an empty `data` array,
which is indistinguishable from a genuinely-empty result for **off-market**
records (empty is normal there). This is mitigated only for **on-market**
history (empty-when-live → WARN). To be documented in `docs/fetching.md`.

## Out of scope

- No change to `computeTenure`, `types.ts`, `enrich`, `route`, or notification
  templates.
- No cookie-jar domain-awareness rework (the flat jar already reaches both
  hosts).
- Root-causing exactly why `o2o-same` failed in Node is not required; the first
  implementation step should reproduce/verify the new endpoints succeed from the
  Node path.
