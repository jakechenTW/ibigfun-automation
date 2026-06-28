# Complete iBigFun Fetch-Filter Reference

Date: 2026-06-29
Status: Design (approved in brainstorming; pending spec review)

## Problem

`data/ibigfun-filter-mappings.md` is the human key for a profile's `fetch` map,
but it is **partial and profile-driven**: it enumerates only the dimensions the
two committed profiles happen to use plus full tables for `city` / `town` /
`house_type`. It does **not** comprehensively document every
`/api/search/list` body param a `fetch` map can set, nor every allowed value for
the bucketed/range filters. Concretely, today the doc:

- lists `parking` as a literal value with **"re-confirm 機械/塔式/其他 from the
  UI if needed"** — i.e. the value set is not authoritatively recorded;
- names the range filters (`price_segment`, `floor_segment`, `total_floor`,
  `house_age_segment`, `main_ping_number`) only in the encoding section, without
  saying whether each is a **free numeric range or a fixed set of buckets**, its
  unit, or its bounds;
- omits any body-param filter the search UI exposes that neither committed
  profile uses.

So an agent or user composing a *new* `fetch` map (e.g. a 台中 variant, or one
that filters by 坪數 / 屋齡 / 車位類型) must guess or re-crawl. The goal is to
make this file a **complete catalog** that removes that guesswork.

## Goal

Make `data/ibigfun-filter-mappings.md` the complete, authoritative reference for
**every `/api/search/list` body param a profile's `fetch` map can set**, with
full allowed-value enumerations, captured from a real (live) crawl of the
authenticated filter UI.

## Scope

**In scope:** every body param the `fetch` map can emit through `buildSearchBody`
(scalar / `{min,max}` / array / literal), and its complete allowed-value set.

**Out of scope:**
- Non-`fetch` UI controls (sort order, result display, map toggles) — they never
  enter the `fetch` map.
- The **fixed envelope** (`page`, `method=all_case`, `on_market=1`, `expand=0`,
  `exclude_land=1`, `add_date`/`add_date_max`, and the `source[]` /
  `source_web[]` allow-lists). These are the API contract hard-coded in
  `buildSearchBody`, **not** `fetch`-tunable. The doc keeps its existing
  cross-reference to them but marks them clearly as envelope, not catalog.
- Any code change (`scripts/`) or profile change (`profiles/`). Docs + data only.

## Crawl method (safety-critical)

iBigFun allows one active login per account and the automation shares the user's
account; a competing **headless** login kicks the other session. Therefore:

- The crawl runs **live via Claude-in-Chrome against the user's already-
  authenticated Chrome session** — the user's own session, so no second login and
  no kick.
- **Never** run `npm run fetch`, `npm run pipeline`, or any headless network
  command during this work.
- One controlled read pass on `https://www.ibigfun.com/lists/latest`:
  - read each filter control's option values (the `<span id="<filter>_caption_<id>">`
    caption spans and the inline `var city = {…}` object);
  - open each range/bucket dropdown (price / floor / total_floor / house_age /
    坪數 / etc.) and record whether it is a **free numeric range or fixed
    buckets**, plus unit and bounds;
  - record the full **`parking`** value list;
  - note any other body-param filter the UI exposes that the doc has not recorded.
- Capture **one** `/api/search/list` XHR (via the page's own search, in the
  user's session) to confirm exact param names and value formats against
  `scripts/lib/api.ts` (`buildSearchBody`).
- **Never** write credentials, cookies, or session tokens into the doc or any
  committed file.

## Execution model

Because the crawl needs the user's live browser and is interactive/observational,
this work is executed **inline in the main session**, not dispatched to headless
subagents (subagents cannot reliably drive the user's interactive Chrome session).

## Design — expanded `data/ibigfun-filter-mappings.md`

The file keeps its current sections and adds/upgrades the following. Existing
complete tables (`city`, `town`, `house_type`) are **verified against the crawl**
and only corrected if the live UI has changed.

### 1. Header

Keep the intro and source note. Bump the captured date to **2026-06-29** and keep
the re-confirm instructions (same method: authenticated listing view, read
caption spans / the `var city` object, or DevTools-capture the XHR).

### 2. New "Filter catalog" overview table

A single table near the top listing **every fetch-usable body param**, so a
reader sees the whole tunable surface at a glance:

| `fetch` key | Value shape | Allowed values | Section |
|---|---|---|---|

- **Value shape** is one of: scalar, `{min,max}` range, array (`key[]`), literal
  string.
- **Allowed values** is a short hint (e.g. "22 city ids", "free 萬 range",
  "4 literal strings") with the per-filter section holding the full set.

### 3. Per-filter value sections (each complete)

For every key in the catalog, a section with the **complete** allowed-value set:

- **`city`** — verify the existing 22-entry table.
- **`town`** — verify the existing 366-district table.
- **`house_type`** — verify the existing 12-entry table.
- **`parking`** — record the **complete** literal value list (replacing the
  current "re-confirm" note).
- **Range filters** (`price_segment`, `floor_segment`, `total_floor`,
  `house_age_segment`, `main_ping_number`, and any 坪數/屋齡 range found): for
  each, state whether it is a **free numeric range or fixed buckets**; if buckets,
  list every bucket value; give the **unit** (萬 / 樓 / 坪 / 年) and the
  `key[min_val]`/`key[max_val]` encoding (omitted bound → empty string =
  unbounded).
- **Any newly-found body-param filter** the crawl surfaces (id→name table or
  value list, matching the style above).

### 4. Existing sections retained

- **`/api/search/list` request-body encoding** — kept; add an explicit note that
  the **fixed envelope and `source[]`/`source_web[]` allow-lists are API contract,
  not `fetch`-tunable** (so they are intentionally absent from the catalog table).
  The server-side-only caveat (`main_ping_number` returns `total_ping`,
  `house_type` returns `typeLayout`) stays.
- **Related references** — kept (links to `docs/fetching.md`, `scripts/lib/api.ts`,
  `profiles/README.md`).

## Verification

Docs + data only; no automated tests. After the crawl and edits:

- The captured `/api/search/list` XHR's body param **names** match the keys
  `buildSearchBody` emits (`scripts/lib/api.ts`): scalars, `key[min_val]`/
  `key[max_val]`, repeated `key[]`. Any mismatch is reconciled (doc follows the
  live capture).
- Every key in the new catalog table has a corresponding per-filter section with
  a complete value set (no "re-confirm" / TBD placeholders left for in-scope
  filters).
- `city` / `town` / `house_type` tables still match the live UI (or are corrected).
- `parking` lists concrete literal values, not a "re-confirm" note.
- No credentials, cookies, or session tokens appear anywhere in the file:
  `grep -niE "password|mobile=|ibigfun_session|cookie" data/ibigfun-filter-mappings.md`
  → no hits.
- `data/README.md`'s `ibigfun-filter-mappings.md` section still accurately
  describes the (now broader) file; update its one-line summary if needed.

## Out of Scope

- Non-`fetch` UI controls (sort/display/map) — not documented.
- Any `scripts/` or `profiles/` change.
- The fixed envelope and source allow-lists remain envelope (cross-referenced,
  not catalogued as tunable).
- Re-running the full daily pipeline or any headless fetch.
