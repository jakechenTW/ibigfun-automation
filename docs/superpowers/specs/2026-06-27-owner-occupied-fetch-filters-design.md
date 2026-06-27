# Owner-Occupied Fetch Filters — Design

**Date:** 2026-06-27
**Status:** Approved (pending spec review)

## Problem

`owner-occupied` runs currently fetch the **investment-shaped captured request**
(low-rise: `floor_segment 2–4`, `total_floor ≤5`, `price ≤2500萬`), because
`scripts/lib/api.ts:buildSearchBody` hardcodes that shape and the fetch path
never consumes `profile.fetchFilters`. The flag `fetchFilters.enabled` is read
only for boolean validation in `profiles.ts`; nothing in the fetch path uses it.

Result: an owner-occupied run over 2026-06-26 returned 78 listings of which
**0** met the owner-occupied hard criteria — every listing is ≤4 樓, while the
profile requires 7 樓以上. The run cannot represent real owner-occupied
discovery. This is documented honestly today (`enabled: false` → forced `warn`),
but the feature is not implemented.

## Goal

Make the fetch step apply a profile's `fetchFilters` to the
`/api/search/list` request when `fetchFilters.enabled === true`, so
`owner-occupied` fetches its own universe (台北市・指定行政區・7 樓以上・
主建物 ≥30 坪・屋齡 ≤25・≤7000 萬・平面車位). Keep `investment` byte-for-byte
unchanged.

## Non-Goals

- No change to enrich, report, or notify logic beyond what new fields require.
- No browser/Playwright capture in the committed code (fetch stays browserless).
- No new profiles; no investment filter changes.

## Key Constraint Discovered

Web URL param names ≠ API body param names. The owner-occupied saved URL uses
`price_segment=,7000`, but the API body encodes it as
`price_segment[min_val]=&price_segment[max_val]=7000` (proven by the existing
captured investment body). So the body encoding for the **new** params (`town`,
`house_type`, `main_ping_number`, `house_age_segment`, `parking`) is **not known
from the URL alone** and must be derived and verified.

### Approach: analogy-derivation + empirical live verification

1. Derive body encoding by analogy with the known captured params:
   - Range params use `name[min_val]` / `name[max_val]` (like `price_segment`,
     `floor_segment`): so `floor_segment[min_val]=7`,
     `house_age_segment[max_val]=25`, `main_ping_number[min_val]=30`.
   - Multi-value params use `name[]` (like `source[]`): so `town[]=1`, …,
     `house_type[]=17`.
   - Scalar param `parking=平面` (URL-encoded).
2. Run one live owner-occupied fetch and verify each filter actually constrained
   the result set:
   - all returned listings have `floor >= 7`,
   - all districts ∈ the 5 configured 行政區,
   - `parking_type` contains 平面,
   - `house_age_x <= 25`.
3. If any constraint did not take effect (param silently ignored), iterate the
   param name; fall back to browser devtools capture only if analogy fails.
4. **Bonus:** resolve the `待驗證` town id→name and `house_type=17` name from the
   returned `address` / `pattern` fields and update
   `profiles/owner-occupied.json` + `docs/profiles/owner-occupied.md`.

## Architecture

### `scripts/lib/api.ts`
- Add `SearchFilters` interface describing the variable body params:
  `city`, `town` (string[]), `houseType` (string[]), `priceMaxWan`,
  `floorMin`, `mainPingMin`, `ageMax`, `parking` (all optional).
- `buildSearchBody(from, to, page = 1, filters?: SearchFilters)`:
  - `filters` omitted → emit the **current captured investment body verbatim**
    (default path; `api.test.ts` stays green).
  - `filters` present → emit `method/on_market/expand/exclude_land` +
    `source_web[]`/`source[]` (shared allow-list) + the filter-derived params.
    Owner-occupied omits `total_floor` and the investment `floor 2–4` cap.

### `scripts/lib/profiles.ts`
- Add `searchFiltersFromProfile(profile): SearchFilters | undefined` — returns
  a `SearchFilters` when `profile.fetchFilters.enabled === true`, else
  `undefined`. Maps `ProfileFetchFilters` → `SearchFilters`.

### Threading (fetch path)
- `scripts/lib/steps.ts:fetchStep` computes
  `const filters = searchFiltersFromProfile(profile)` and passes it down.
- `collectListings(range, deps, logger)` keeps its signature; `defaultDeps`
  gains an optional `filters` so the `fetchPage` closure
  (`scripts/lib/http.ts`) calls `buildSearchBody(from, to, page, filters)`.
  `fetchStep` constructs deps with the profile filters; investment passes
  `undefined` and the default deps behavior is unchanged.

## Data Flow

```
fetchStep(ctx)
  → filters = searchFiltersFromProfile(ctx.profile)   // undefined for investment
  → collectListings(range, defaultDeps(filters), logger)
     → fetchPage(from, to, page)                       // closure holds filters
        → buildSearchBody(from, to, page, filters)     // undefined → captured shape
```

## Profile / Docs Changes (after verification passes)

- `profiles/owner-occupied.json`: `fetchFilters.enabled = true`; replace
  `待驗證` town/house_type names with verified names.
- `docs/profiles/owner-occupied.md`: record verified district + house_type
  mapping; note `main_ping` is a server-side filter not re-verifiable client-side.
- `docs/fetching.md`: document profile-aware body + the new param encodings and
  re-capture/verify date.
- `prompts/daily-run.md`: remove the "owner-occupied while `enabled=false` must
  be `warn`" special case (still `warn` on any match/candidate/manual item per
  the general rules; a clean verified no-match run may be `ok`).
- `AGENTS.md`: owner-occupied is now real discovery once enabled.

## Known Limitation

`/api/search/list` returns `total_ping`, not 主建物 (main building) ping. The
`main_ping_number >= 30` filter is therefore **server-side only**; the client
cannot re-verify it from results. Documented; trusted.

## Testing

- `api.test.ts`: unchanged (locks the default captured shape).
- New `api.test.ts` cases for the filtered shape: with owner filters,
  `buildSearchBody` output contains `floor_segment[min_val]=7`, no
  `floor_segment[max_val]`, `town[]=1`…`town[]=9`, `house_type[]=17`,
  `price_segment[max_val]=7000`, `main_ping_number[min_val]=30`,
  `house_age_segment[max_val]=25`, `parking=平面` (encoded), no `total_floor`,
  and still includes the shared `source[]`/`exclude_land`.
- New `profiles.test.ts` cases: `searchFiltersFromProfile` returns `undefined`
  when `enabled=false` and a populated `SearchFilters` when `enabled=true`.
- Live verification is a manual implementation step (network), not a committed
  test.

## Risks

- Param-name guess wrong → silently ignored. Mitigated by empirical
  verification on a live fetch before flipping `enabled`.
- Live fetch logs the user's browser iBigFun session out (shared single login) —
  accepted, same as every fetch.
</content>
