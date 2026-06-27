# Owner-Occupied Fetch Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fetch step apply a profile's `fetchFilters` to the `/api/search/list` request when `fetchFilters.enabled === true`, so `owner-occupied` fetches its own universe while `investment` stays byte-for-byte unchanged.

**Architecture:** Generalize `buildSearchBody` with an optional `SearchFilters` argument (omitted → current captured investment body). Add `searchFiltersFromProfile` to convert a profile into `SearchFilters | undefined`. Thread the filters through `fetchStep → defaultDeps(filters) → fetchPage closure → buildSearchBody`. Derive the new params' body encoding by analogy with the captured params, then verify empirically against a live fetch before flipping `enabled`.

**Tech Stack:** Node.js, TypeScript ESM, `node:test`, `URLSearchParams`.

## Global Constraints

- `investment` request shape must stay byte-for-byte identical. The existing `scripts/lib/api.test.ts` cases must remain green.
- `buildSearchBody(from, to, page)` with no `filters` argument must emit the current captured investment body.
- Do not flip `profiles/owner-occupied.json` `fetchFilters.enabled` to `true` until the live verification in Task 4 confirms every filter actually constrained the result set.
- Fetch stays browserless (pure Node `fetch`); no Playwright/Chromium, no committed network tests.
- Generated `state/` data is git-ignored; never commit it.
- Live fetches log the user's shared iBigFun browser session out — this is the accepted existing behavior.

---

### Task 1: SearchFilters type and filter-aware buildSearchBody

**Files:**
- Modify: `scripts/lib/api.ts`
- Test: `scripts/lib/api.test.ts`

**Interfaces:**
- Produces: `export interface SearchFilters { city?: string; town?: string[]; houseType?: string[]; priceMaxWan?: number; floorMin?: number; mainPingMin?: number; ageMax?: number; parking?: string; }` and `buildSearchBody(from: string, to: string, page?: number, filters?: SearchFilters): string`.

- [ ] **Step 1: Add failing tests for the filtered body shape**

Append these cases to `scripts/lib/api.test.ts` (keep all existing cases unchanged), and add `type SearchFilters` to the import on line 4 (`import { buildSearchBody, pageCount, SEARCH_LIST_URL, historyUrl, OFF_MARKET_URL, buildOffMarketBody, type SearchFilters } from './api.ts';`):

```ts
const ownerFilters: SearchFilters = {
  city: '1',
  town: ['1', '4', '6', '8', '9'],
  houseType: ['17'],
  priceMaxWan: 7000,
  floorMin: 7,
  mainPingMin: 30,
  ageMax: 25,
  parking: '平面',
};

test('buildSearchBody with no filters is unchanged (captured investment shape)', () => {
  const b = buildSearchBody('2026-06-26', '2026-06-26', 1);
  assert.match(b, /price_segment%5Bmax_val%5D=2500/);
  assert.match(b, /floor_segment%5Bmin_val%5D=2/);
  assert.match(b, /floor_segment%5Bmax_val%5D=4/);
  assert.match(b, /total_floor%5Bmax_val%5D=5/);
  assert.doesNotMatch(b, /town%5B%5D=/);
  assert.doesNotMatch(b, /parking=/);
});

test('buildSearchBody with owner filters emits floor min only, no total_floor', () => {
  const b = buildSearchBody('2026-06-26', '2026-06-26', 1, ownerFilters);
  assert.match(b, /floor_segment%5Bmin_val%5D=7/);
  assert.doesNotMatch(b, /floor_segment%5Bmax_val%5D=\d/);
  assert.doesNotMatch(b, /total_floor/);
});

test('buildSearchBody with owner filters emits town[] and house_type[]', () => {
  const b = buildSearchBody('2026-06-26', '2026-06-26', 1, ownerFilters);
  assert.match(b, /town%5B%5D=1/);
  assert.match(b, /town%5B%5D=4/);
  assert.match(b, /town%5B%5D=9/);
  assert.match(b, /house_type%5B%5D=17/);
});

test('buildSearchBody with owner filters emits price/ping/age segments and parking', () => {
  const b = buildSearchBody('2026-06-26', '2026-06-26', 1, ownerFilters);
  assert.match(b, /price_segment%5Bmax_val%5D=7000/);
  assert.match(b, /main_ping_number%5Bmin_val%5D=30/);
  assert.match(b, /house_age_segment%5Bmax_val%5D=25/);
  assert.match(b, new RegExp('parking=' + encodeURIComponent('平面')));
});

test('buildSearchBody with owner filters keeps shared source allow-list + exclude_land + dates', () => {
  const b = buildSearchBody('2026-06-20', '2026-06-25', 2, ownerFilters);
  assert.match(b, /(^|&)page=2(&|$)/);
  assert.match(b, /method=all_case/);
  assert.match(b, /source_web%5B%5D=370/);
  assert.match(b, /source%5B%5D=372/);
  assert.match(b, /(^|&)exclude_land=1(&|$)/);
  assert.match(b, /(^|&)add_date=2026-06-20(&|$)/);
  assert.match(b, /(^|&)add_date_max=2026-06-25(&|$)/);
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `node --import tsx --test scripts/lib/api.test.ts`

Expected: FAIL — `SearchFilters` is not exported and `buildSearchBody` ignores the 4th argument (town/parking assertions fail).

- [ ] **Step 3: Implement `SearchFilters` and refactor `buildSearchBody`**

In `scripts/lib/api.ts`, add the interface immediately above the existing `buildSearchBody` (just after the `SOURCE` const, before line `/** Build the URL-encoded /api/search/list POST body ... */`):

```ts
/** Variable filter params for /api/search/list. Omit for the captured default. */
export interface SearchFilters {
  city?: string;
  town?: string[];
  houseType?: string[];
  priceMaxWan?: number;
  floorMin?: number;
  mainPingMin?: number;
  ageMax?: number;
  parking?: string;
}
```

Replace the whole `buildSearchBody` function with:

```ts
/** Build the URL-encoded /api/search/list POST body for a date range + page.
 *  With no `filters`, emits the captured investment shape verbatim. */
export function buildSearchBody(from: string, to: string, page = 1, filters?: SearchFilters): string {
  const p = new URLSearchParams();
  p.set('page', String(page));
  p.set('expand', '0');
  p.set('method', 'all_case');
  p.set('on_market', '1');
  if (!filters) {
    // Captured investment shape (default; locked by api.test.ts).
    p.set('city', '1');
    p.set('price_segment[min_val]', '');
    p.set('price_segment[max_val]', '2500');
    p.set('floor_segment[min_val]', '2');
    p.set('floor_segment[max_val]', '4');
    p.set('total_floor[min_val]', '');
    p.set('total_floor[max_val]', '5');
  } else {
    p.set('city', filters.city ?? '1');
    if (filters.town) for (const t of filters.town) p.append('town[]', t);
    if (filters.houseType) for (const h of filters.houseType) p.append('house_type[]', h);
    p.set('price_segment[min_val]', '');
    p.set('price_segment[max_val]', filters.priceMaxWan != null ? String(filters.priceMaxWan) : '');
    if (filters.floorMin != null) {
      p.set('floor_segment[min_val]', String(filters.floorMin));
      p.set('floor_segment[max_val]', '');
    }
    if (filters.mainPingMin != null) {
      p.set('main_ping_number[min_val]', String(filters.mainPingMin));
      p.set('main_ping_number[max_val]', '');
    }
    if (filters.ageMax != null) {
      p.set('house_age_segment[min_val]', '');
      p.set('house_age_segment[max_val]', String(filters.ageMax));
    }
    if (filters.parking) p.set('parking', filters.parking);
  }
  p.set('add_date', from);
  p.set('add_date_max', to);
  for (const s of SOURCE_WEB) p.append('source_web[]', s);
  for (const s of SOURCE) p.append('source[]', s);
  p.set('exclude_land', '1');
  return p.toString();
}
```

- [ ] **Step 4: Run the api tests (old + new) and confirm they pass**

Run: `node --import tsx --test scripts/lib/api.test.ts`

Expected: PASS (all original cases + the 5 new cases).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/api.ts scripts/lib/api.test.ts
git commit -m "feat: add optional SearchFilters to buildSearchBody"
```

---

### Task 2: searchFiltersFromProfile mapper

**Files:**
- Modify: `scripts/lib/profiles.ts`
- Test: `scripts/lib/profiles.test.ts`

**Interfaces:**
- Consumes: `SearchFilters` from `./api.ts`; `Profile` / `ProfileFetchFilters` from this file.
- Produces: `export function searchFiltersFromProfile(profile: Profile): SearchFilters | undefined`.

- [ ] **Step 1: Add failing tests**

Append to `scripts/lib/profiles.test.ts`, and add `searchFiltersFromProfile` to the existing import from `./profiles.ts`:

```ts
test('searchFiltersFromProfile returns undefined when fetchFilters disabled', () => {
  const p = loadProfile('investment');
  assert.equal(searchFiltersFromProfile(p), undefined);
});

test('searchFiltersFromProfile maps owner-occupied filters when enabled', () => {
  const base = loadProfile('owner-occupied');
  const p = { ...base, fetchFilters: { ...base.fetchFilters, enabled: true } } as typeof base;
  const f = searchFiltersFromProfile(p);
  assert.ok(f);
  assert.equal(f!.city, '1');
  assert.deepEqual(f!.town, ['1', '4', '6', '8', '9']);
  assert.deepEqual(f!.houseType, ['17']);
  assert.equal(f!.priceMaxWan, 7000);
  assert.equal(f!.floorMin, 7);
  assert.equal(f!.mainPingMin, 30);
  assert.equal(f!.ageMax, 25);
  assert.equal(f!.parking, '平面');
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `node --import tsx --test scripts/lib/profiles.test.ts`

Expected: FAIL — `searchFiltersFromProfile` is not exported.

- [ ] **Step 3: Implement the mapper**

In `scripts/lib/profiles.ts`, add to the imports at the top:

```ts
import type { SearchFilters } from './api.ts';
```

Add this exported function at the end of the file:

```ts
/** Convert a profile into /api/search/list filters, or undefined when its
 *  fetch filters are not enabled (caller then uses the captured default shape). */
export function searchFiltersFromProfile(profile: Profile): SearchFilters | undefined {
  const f = profile.fetchFilters;
  if (!f.enabled) return undefined;
  return {
    city: f.city?.id,
    town: f.towns?.map((t) => t.id),
    houseType: f.houseType ? [f.houseType.id] : undefined,
    priceMaxWan: f.priceMaxWan,
    floorMin: f.floorMin,
    mainPingMin: f.mainPingMin,
    ageMax: f.ageMax,
    parking: f.parking,
  };
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `node --import tsx --test scripts/lib/profiles.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/profiles.ts scripts/lib/profiles.test.ts
git commit -m "feat: map profile fetch filters to SearchFilters"
```

---

### Task 3: Thread filters through the fetch path

**Files:**
- Modify: `scripts/lib/http.ts`
- Modify: `scripts/lib/steps.ts`

**Interfaces:**
- Consumes: `SearchFilters` from `./api.ts`; `searchFiltersFromProfile` from `./profiles.ts`; `defaultDeps` from `./http.ts`.
- Produces: `defaultDeps(filters?: SearchFilters): CollectDeps` whose `fetchPage` closes over `filters`.

This is the IO boundary (`http.ts` has no unit tests in this repo; `extract.ts` is tested with injected fake deps). Correctness here is covered by `tsc` plus the live verification in Task 4 — no new unit test.

- [ ] **Step 1: Add the `SearchFilters` import to `http.ts`**

In `scripts/lib/http.ts`, extend the existing api import (line 7) to include the type:

```ts
import { SIGNIN_URL, LOGIN_URL, SEARCH_LIST_URL, buildSearchBody, historyUrl, OFF_MARKET_URL, buildOffMarketBody, type SearchFilters } from './api.ts';
```

- [ ] **Step 2: Make `fetchPage` accept filters**

In `scripts/lib/http.ts`, change the `fetchPage` signature and its `buildSearchBody` call:

```ts
async function fetchPage(from: string, to: string, page: number, filters?: SearchFilters): Promise<SearchListResponse> {
  return withRelogin(async () => {
    const r = await rawPostForm(SEARCH_LIST_URL, buildSearchBody(from, to, page, filters), 'https://www.ibigfun.com/lists/latest');
    applySetCookies(getJar(), r.setCookies);
    if (looksLikeSignin(r)) return { kicked: true };
    const parsed = JSON.parse(r.text) as SearchListResponse;
    assertApiOk('/api/search/list', r.status, parsed.status);
    return { kicked: false, value: parsed };
  });
}
```

- [ ] **Step 3: Make `defaultDeps` accept filters and close over them**

In `scripts/lib/http.ts`, replace `defaultDeps`:

```ts
/** Real dependencies for collectListings (network-backed).
 *  `filters` (when given) are applied to every /api/search/list page. */
export function defaultDeps(filters?: SearchFilters): CollectDeps {
  return {
    ensureSession,
    fetchPage: (from, to, page) => fetchPage(from, to, page, filters),
    fetchOnMarketHistory,
    fetchOffMarketHistory,
  };
}
```

- [ ] **Step 4: Build profile filters in `fetchStep` and pass deps**

In `scripts/lib/steps.ts`, update imports: change `import type { RunContext } from './profiles.ts';` to:

```ts
import { searchFiltersFromProfile, type RunContext } from './profiles.ts';
```

and add (next to the other `./lib` imports):

```ts
import { defaultDeps } from './http.ts';
```

In `fetchStep`, replace the `collectListings` call:

```ts
const filters = searchFiltersFromProfile(profile);
const { listings, dropped, duplicates } = await collectListings(range, defaultDeps(filters), logger);
```

- [ ] **Step 5: Type-check and run the full suite**

Run: `npx tsc --noEmit`

Expected: PASS.

Run: `npm test`

Expected: PASS (existing cases + Task 1/2 additions; no regressions).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/http.ts scripts/lib/steps.ts
git commit -m "feat: apply profile fetch filters in the fetch step"
```

---

### Task 4: Live verification, mapping resolution, and enable

**Files:**
- Modify: `profiles/owner-occupied.json`
- Modify (only if a param name proves wrong): `scripts/lib/api.ts`

This task uses the live network. It logs the user's iBigFun browser session out (accepted). `npm run fetch` writes `listings.json` directly and bypasses the pipeline manifest skip, so it is safe to re-run.

- [ ] **Step 1: Enable owner-occupied fetch filters**

In `profiles/owner-occupied.json`, set `"fetchFilters": { "enabled": true, ... }` (change the single `enabled` value from `false` to `true`; leave the rest as-is for now).

- [ ] **Step 2: Run a live owner-occupied fetch over a multi-day window**

Run: `npm run fetch -- --profile owner-occupied --from 2026-06-20 --to 2026-06-26`

Expected: exits `0` and writes `state/runs/owner-occupied/2026-06-20_2026-06-26/listings.json`. (If it exits `2` with `BLOCKED`, a human login gate was hit — stop and report; do not bypass.)

- [ ] **Step 3: Verify each filter actually constrained the result set**

Run:

```bash
node -e '
const d=require("./state/runs/owner-occupied/2026-06-20_2026-06-26/listings.json");
const a=d.listings||d;
const num=s=>{const m=String(s).match(/-?\d+(\.\d+)?/);return m?+m[0]:null;};
const floors=a.map(x=>num(x.floor)).filter(v=>v!=null);
const ages=a.map(x=>x.age).filter(v=>v!=null);
const districts=[...new Set(a.map(x=>x.district))];
const parkings=[...new Set(a.map(x=>x.parking))];
const patterns=[...new Set(a.map(x=>x.typeLayout))];
console.log("count",a.length);
console.log("floor<7 count",floors.filter(f=>f<7).length,"min",Math.min(...floors));
console.log("age>25 count",ages.filter(g=>g>25).length,"max",Math.max(...ages));
console.log("districts",JSON.stringify(districts));
console.log("parkings",JSON.stringify(parkings));
console.log("patterns(house_type)",JSON.stringify(patterns));
'
```

Expected if every param took effect: `floor<7 count 0`, `age>25 count 0`, `districts` is a subset of exactly five 台北市 行政區, every `parkings` entry contains 平面.

- [ ] **Step 4: Fix any param that was silently ignored, then re-run Step 2–3**

If a constraint did NOT take effect, the body param name is wrong. Apply the matching fix in `scripts/lib/api.ts` `buildSearchBody` (filtered branch) and repeat Steps 2–3:

- `floor<7` still present → try `floor[min_val]` instead of `floor_segment[min_val]`.
- `districts` not limited to five → try `town[]` → `district[]`, or scalar `town` (comma-joined).
- `parkings` includes non-平面 → try `parking[]=平面`, or `parking_type=平面`.
- `age>25` present → try `house_age[max_val]` instead of `house_age_segment[max_val]`.
- `house_type` not constrained (mixed unexpected `patterns`) → try scalar `house_type=17`.

(`main_ping_number` cannot be re-verified client-side — the API returns `total_ping`, not 主建物 ping. Trust the server filter.)

- [ ] **Step 5: Resolve the 待驗證 names from the verified results**

From the `districts` and `patterns` printed in Step 3, map each `town` id (`1/4/6/8/9`) to its confirmed 行政區 name and `house_type` `17` to its confirmed type name. In `profiles/owner-occupied.json`, replace each `"nameZh": "待驗證"` with the confirmed name. Only replace names you can confirm from the data; leave any you cannot as `待驗證` and note it.

- [ ] **Step 6: Run the full suite and type-check**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 7: Remove the throwaway verification run state**

Run: `rm -rf state/runs/owner-occupied/2026-06-20_2026-06-26`

Expected: throwaway output removed. Do not remove other `state/` contents.

- [ ] **Step 8: Commit**

```bash
git add profiles/owner-occupied.json scripts/lib/api.ts
git commit -m "feat: enable and verify owner-occupied fetch filters"
```

---

### Task 5: Documentation update

**Files:**
- Modify: `docs/fetching.md`
- Modify: `docs/profiles/owner-occupied.md`
- Modify: `prompts/daily-run.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Document profile-aware body in `docs/fetching.md`**

Replace the paragraph that begins "The first profile-aware implementation keeps this captured request shape for all profiles..." (the note under the request body) with:

```md
The fetch body is profile-aware. With no profile filters (or a profile whose
`fetchFilters.enabled` is `false`) the captured investment shape above is sent.
When a profile has `fetchFilters.enabled: true`, `buildSearchBody` emits that
profile's filters instead: `city`, `town[]`, `house_type[]`,
`price_segment[max_val]`, `floor_segment[min_val]` (no max), `main_ping_number[min_val]`,
`house_age_segment[max_val]`, and `parking` (the `total_floor` cap and the
investment `floor 2–4` window are omitted). The `method`, `on_market`, `expand`,
`exclude_land`, and `source_web[]`/`source[]` allow-list are shared by both shapes.
`owner-occupied` enabled and verified its filters on 2026-06-27.

`main_ping_number` is a server-side filter only: `/api/search/list` returns
`total_ping`, not 主建物 ping, so a `main_ping >= 30` constraint cannot be
re-verified from the response.
```

- [ ] **Step 2: Record verified mappings in `docs/profiles/owner-occupied.md`**

Under the `## Source Filter` section, replace the sentence "The numeric `town` and `house_type` mappings are not considered verified..." with a line stating the mappings were verified from a live fetch on 2026-06-27 and listing the confirmed `town` id→name and `house_type=17` name resolved in Task 4 Step 5. Add a note: "`main_ping >= 30` is applied server-side and is not re-verifiable from API results (API returns total ping)."

- [ ] **Step 3: Update the owner-occupied status rule in `prompts/daily-run.md`**

Replace the `owner-occupied` bullet under `## status 對應` (the line beginning "`owner-occupied`：在 `profiles/owner-occupied.json` 的 `fetchFilters.enabled` 仍為 `false` 時...") with:

```md
- `owner-occupied`：`fetchFilters.enabled=true` 後為完整自住 discovery；依一般 status 規則判斷（有符合/候選/manual 即 `warn`，乾淨無符合且資料新鮮可 `ok`）。若任何 town/house_type 對照仍標「待驗證」，仍以 `warn` 處理。
```

- [ ] **Step 4: Update `AGENTS.md` owner-occupied wording**

In `AGENTS.md` "What This Is & The Source Model", replace "owner-occupied is incomplete discovery until its fetch filters are verified and enabled." with "owner-occupied applies its own fetch filters (verified and enabled 2026-06-27)." Remove any remaining claim that owner-occupied only runs over the investment captured universe.

- [ ] **Step 5: Verify docs have no stale "enabled: false" / "incomplete discovery" claims**

Run:

```bash
rg -n "enabled.*false|incomplete discovery|captured fetch universe|待驗證" AGENTS.md docs prompts profiles
```

Expected: no remaining claim that owner-occupied is disabled/incomplete, except historical references inside `docs/superpowers/` specs/plans. Any `待驗證` left in `profiles/owner-occupied.json` must match what Task 4 Step 5 deliberately left unconfirmed.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md docs/fetching.md docs/profiles/owner-occupied.md prompts/daily-run.md
git commit -m "docs: document enabled owner-occupied fetch filters"
```

---

### Task 6: Final verification

**Files:**
- No planned edits unless verification exposes an issue.

- [ ] **Step 1: Clean working tree check**

Run: `git status --short`

Expected: no uncommitted changes (the throwaway `state/` run was removed in Task 4).

- [ ] **Step 2: Full tests + type-check**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 3: Confirm investment shape is still byte-for-byte unchanged**

Run: `node --import tsx --test scripts/lib/api.test.ts`

Expected: PASS, including the original captured-shape cases.

- [ ] **Step 4: Smoke-test the disabled-profile path is untouched**

Run: `node -e 'import("./scripts/lib/api.ts").then(m=>{const a=m.buildSearchBody("2026-06-26","2026-06-26",1);console.log(a.includes("price_segment%5Bmax_val%5D=2500")&&!a.includes("town%5B%5D")?"DEFAULT OK":"DEFAULT BROKEN");})'`

Expected: prints `DEFAULT OK`.

## Self-Review Notes

- **Spec coverage:** `SearchFilters` + filter-aware `buildSearchBody` (Task 1); `searchFiltersFromProfile` (Task 2); threading via `defaultDeps`/`fetchPage`/`fetchStep` (Task 3); analogy encoding + live empirical verification + name resolution + `enabled=true` (Task 4); docs/prompt/AGENTS updates incl. the forced-`warn` removal and the `main_ping` server-side limitation (Task 5); final verification + investment-unchanged check (Task 6).
- **Investment unchanged:** Guaranteed by the `!filters` branch emitting the verbatim captured body and by the unchanged `api.test.ts` cases (Task 1) plus the explicit Task 6 Step 3/4 checks.
- **Type consistency:** `SearchFilters` field names (`city, town, houseType, priceMaxWan, floorMin, mainPingMin, ageMax, parking`) are identical across Task 1 (definition), Task 2 (mapper), and Task 3 (threading). `defaultDeps(filters?)` and `fetchPage(..., filters?)` signatures match between Task 3 steps.
- **Scope:** Single subsystem (fetch request shaping). No enrich/report/notify code changes.
</content>
