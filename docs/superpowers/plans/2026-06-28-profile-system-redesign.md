# Profile System Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rigid profile system with flat, self-contained folder profiles whose filters are pure data, so changing conditions and adding searches needs no code.

**Architecture:** Each profile is a folder `profiles/<id>/` containing `profile.json` (`displayName` + a generic `fetch` map), `evaluation.md`, and `notify-template.md`. `buildSearchBody` becomes a generic walk over the `fetch` map (no per-field code). Profiles are auto-discovered from disk (no allowlist). Ad-hoc `--set fetch.*` overrides merge into an effective fetch written to the run dir. No inheritance (flat).

**Tech Stack:** TypeScript (ESM, `"type":"module"`), Node's built-in test runner via `tsx`, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-28-profile-system-redesign-design.md`

## Global Constraints

- **Zero runtime dependencies** — use only Node built-ins (`node:fs`, `node:path`, `URLSearchParams`). Do not add any package to `dependencies`.
- **Profile id = folder name** — never store an `id` field in `profile.json`.
- **Runnable ids are `investment-taipei` / `owner-occupied-taipei`** (folder names).
- **Never print or commit** `IBIGFUN_ACCOUNT` / `IBIGFUN_PASSWORD` or any `state/` run output (git-ignored). Do **not** run a live `npm run fetch`/pipeline network call — login is a single shared account and logs the user out (see AGENTS.md Safety Rules).
- **Tests:** `npm test` runs the Node test runner over `scripts/**/*.test.ts`. Every task ends green.
- **Captured investment body must be byte-equivalent** (param set) to today's: `price_segment[max_val]=2500`, `floor_segment[min_val]=2`, `floor_segment[max_val]=4`, `total_floor[max_val]=5`, `city=1`, plus the fixed source/exclude_land/date envelope.

---

### Task 1: Core — generic `fetch` body, flat folder profiles, consumer rewire

This is one atomic task because `api.ts` types, `profiles.ts` types, the folder migration, and the `http.ts`/`steps.ts`/`pipeline.ts` consumers reference each other; splitting would leave `npm test` red mid-way.

**Files:**
- Modify: `scripts/lib/api.ts` (generic `buildSearchBody` + `FetchMap` type; drop the two-branch default)
- Rewrite: `scripts/lib/api.test.ts`
- Rewrite: `scripts/lib/profiles.ts` (flat `Profile`, disk discovery, `loadProfile`; drop `ProfileFetchFilters` / `searchFiltersFromProfile` / `NamedFilterValue`)
- Rewrite: `scripts/lib/profiles.test.ts`
- Modify: `scripts/lib/http.ts` (import `FetchMap`, type `defaultDeps`/`fetchPage`)
- Modify: `scripts/lib/steps.ts` (`fetchStep` uses `profile.fetch`)
- Modify: `scripts/pipeline.ts` (report hint paths; notify uses `displayName`)
- Modify: `scripts/lib/region.ts` (comment path), `docs/reporting-rules.md` (reference path)
- Create: `profiles/investment-taipei/{profile.json,evaluation.md,notify-template.md}`
- Create: `profiles/owner-occupied-taipei/{profile.json,evaluation.md,notify-template.md}`
- Delete: `profiles/investment.json`, `profiles/owner-occupied.json`, `docs/profiles/investment.md`, `docs/profiles/owner-occupied.md`, `templates/investment-notify-template.md`, `templates/owner-occupied-notify-template.md`

**Interfaces:**
- Produces: `type FetchMap = Record<string, FetchValue>` where `FetchValue = string | number | string[] | { min?: string|number; max?: string|number }`; `buildSearchBody(from: string, to: string, page?: number, fetchMap?: FetchMap): string`.
- Produces: `interface Profile { id: string; displayName: string; fetch: FetchMap }`; `loadProfile(id: string): Profile`; `availableProfileIds(): string[]`; `resolveProfileFromArgs(argv: string[]): Profile`; `profileFlags(p: Pick<Profile,'id'>): string`; `interface RunContext { profile: Profile; range: RunRange }`.

- [ ] **Step 1: Rewrite `scripts/lib/api.ts` filter type + body builder.** Replace the `SearchFilters` interface (lines ~100–110) and the whole `buildSearchBody` function (lines ~112–155) with:

```ts
/** A profile's fetch map. Keys are /api/search/list param names. */
export type FetchValue =
  | string
  | number
  | string[]
  | { min?: string | number; max?: string | number };
export type FetchMap = Record<string, FetchValue>;

/** Build the URL-encoded /api/search/list POST body for a date range + page.
 *  Fixed envelope (method/on_market/expand/exclude_land/source allow-lists/
 *  dates) is the API contract; `fetchMap` supplies the variable filters:
 *   - scalar            → key=value
 *   - { min, max }      → key[min_val]=<min|""> & key[max_val]=<max|"">
 *   - array             → key[]=v (repeated)
 */
export function buildSearchBody(from: string, to: string, page = 1, fetchMap: FetchMap = {}): string {
  const p = new URLSearchParams();
  p.set('page', String(page));
  p.set('expand', '0');
  p.set('method', 'all_case');
  p.set('on_market', '1');
  for (const [key, val] of Object.entries(fetchMap)) {
    if (Array.isArray(val)) {
      for (const item of val) p.append(`${key}[]`, String(item));
    } else if (val !== null && typeof val === 'object') {
      p.set(`${key}[min_val]`, val.min == null ? '' : String(val.min));
      p.set(`${key}[max_val]`, val.max == null ? '' : String(val.max));
    } else {
      p.set(key, String(val));
    }
  }
  p.set('add_date', from);
  p.set('add_date_max', to);
  for (const s of SOURCE_WEB) p.append('source_web[]', s);
  for (const s of SOURCE) p.append('source[]', s);
  p.set('exclude_land', '1');
  return p.toString();
}
```

Keep `SOURCE_WEB`, `SOURCE`, `pageCount`, and all other exports unchanged.

- [ ] **Step 2: Rewrite `scripts/lib/api.test.ts`.** Replace the file with (covers the captured investment shape via an explicit map, owner shape, and envelope/date behavior):

```ts
// scripts/lib/api.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchBody, pageCount, SEARCH_LIST_URL, historyUrl, OFF_MARKET_URL, buildOffMarketBody, type FetchMap } from './api.ts';

const investmentFetch: FetchMap = {
  city: '1',
  price_segment: { max: 2500 },
  floor_segment: { min: 2, max: 4 },
  total_floor: { max: 5 },
};

const ownerFetch: FetchMap = {
  city: '1',
  town: ['1', '4', '6', '8', '9'],
  house_type: ['17'],
  price_segment: { max: 7000 },
  floor_segment: { min: 7 },
  main_ping_number: { min: 30 },
  house_age_segment: { max: 25 },
  parking: '平面',
};

test('buildSearchBody maps a single day to equal add_date / add_date_max', () => {
  const b = buildSearchBody('2026-06-26', '2026-06-26', 1);
  assert.match(b, /(^|&)add_date=2026-06-26(&|$)/);
  assert.match(b, /(^|&)add_date_max=2026-06-26(&|$)/);
});

test('buildSearchBody maps a range to add_date=from, add_date_max=to', () => {
  const b = buildSearchBody('2026-06-20', '2026-06-25', 1);
  assert.match(b, /(^|&)add_date=2026-06-20(&|$)/);
  assert.match(b, /(^|&)add_date_max=2026-06-25(&|$)/);
});

test('buildSearchBody emits the fixed envelope regardless of fetch map', () => {
  const b = buildSearchBody('2026-06-26', '2026-06-26', 2);
  assert.match(b, /(^|&)page=2(&|$)/);
  assert.match(b, /method=all_case/);
  assert.match(b, /on_market=1/);
  assert.match(b, /source_web%5B%5D=370/);
  assert.match(b, /source%5B%5D=372/);
  assert.match(b, /(^|&)exclude_land=1(&|$)/);
});

test('buildSearchBody defaults to page 1', () => {
  assert.match(buildSearchBody('2026-06-26', '2026-06-26'), /(^|&)page=1(&|$)/);
});

test('buildSearchBody reproduces the captured investment shape from its fetch map', () => {
  const b = buildSearchBody('2026-06-26', '2026-06-26', 1, investmentFetch);
  assert.match(b, /(^|&)city=1(&|$)/);
  assert.match(b, /price_segment%5Bmax_val%5D=2500/);
  assert.match(b, /price_segment%5Bmin_val%5D=(&|$)/);
  assert.match(b, /floor_segment%5Bmin_val%5D=2/);
  assert.match(b, /floor_segment%5Bmax_val%5D=4/);
  assert.match(b, /total_floor%5Bmax_val%5D=5/);
  assert.doesNotMatch(b, /town%5B%5D=/);
  assert.doesNotMatch(b, /parking=/);
});

test('buildSearchBody emits floor min only (empty max) for owner fetch', () => {
  const b = buildSearchBody('2026-06-26', '2026-06-26', 1, ownerFetch);
  assert.match(b, /floor_segment%5Bmin_val%5D=7/);
  assert.doesNotMatch(b, /floor_segment%5Bmax_val%5D=\d/);
});

test('buildSearchBody emits town[] and house_type[] arrays for owner fetch', () => {
  const b = buildSearchBody('2026-06-26', '2026-06-26', 1, ownerFetch);
  assert.match(b, /town%5B%5D=1/);
  assert.match(b, /town%5B%5D=4/);
  assert.match(b, /town%5B%5D=9/);
  assert.match(b, /house_type%5B%5D=17/);
});

test('buildSearchBody emits price/ping/age segments and parking for owner fetch', () => {
  const b = buildSearchBody('2026-06-26', '2026-06-26', 1, ownerFetch);
  assert.match(b, /price_segment%5Bmax_val%5D=7000/);
  assert.match(b, /main_ping_number%5Bmin_val%5D=30/);
  assert.match(b, /house_age_segment%5Bmax_val%5D=25/);
  assert.match(b, new RegExp('parking=' + encodeURIComponent('平面')));
});

test('pageCount = ceil(total / perPage), 0 when perPage invalid', () => {
  assert.equal(pageCount(78, 20), 4);
  assert.equal(pageCount(0, 20), 0);
  assert.equal(pageCount(78, 0), 0);
});

test('endpoint constants + off-market body unchanged', () => {
  assert.equal(SEARCH_LIST_URL, 'https://www.ibigfun.com/api/search/list');
  assert.equal(historyUrl(53200935), 'https://api.ibigfun.com/on-market/53200935/history');
  assert.equal(OFF_MARKET_URL, 'https://www.ibigfun.com/api/query_off_market_by_id');
  assert.equal(buildOffMarketBody('A_1FF424'), 'id_encode=A_1FF424');
});
```

- [ ] **Step 3: Create the migrated profile folders.** Create `profiles/investment-taipei/profile.json`:

```json
{
  "displayName": "iBigFun 台北投資房源監測",
  "fetch": {
    "city": "1",
    "price_segment": { "max": 2500 },
    "floor_segment": { "min": 2, "max": 4 },
    "total_floor": { "max": 5 }
  }
}
```

Create `profiles/owner-occupied-taipei/profile.json`:

```json
{
  "displayName": "iBigFun 台北自住房源監測",
  "fetch": {
    "city": "1",
    "town": ["1", "4", "6", "8", "9"],
    "house_type": ["17"],
    "price_segment": { "max": 7000 },
    "floor_segment": { "min": 7 },
    "main_ping_number": { "min": 30 },
    "house_age_segment": { "max": 25 },
    "parking": "平面"
  }
}
```

Then move the prose/template verbatim (content unchanged except the two path edits in the next step):

```bash
git mv docs/profiles/investment.md      profiles/investment-taipei/evaluation.md
git mv docs/profiles/owner-occupied.md  profiles/owner-occupied-taipei/evaluation.md
git mv templates/investment-notify-template.md     profiles/investment-taipei/notify-template.md
git mv templates/owner-occupied-notify-template.md profiles/owner-occupied-taipei/notify-template.md
git rm profiles/investment.json profiles/owner-occupied.json
```

- [ ] **Step 4: Fix the two in-content path references** introduced by the move (search-and-replace within the moved files only):
  - In `profiles/investment-taipei/evaluation.md`: replace `templates/investment-notify-template.md` → `notify-template.md` and any `docs/profiles/investment.md` → `evaluation.md`.
  - In `profiles/investment-taipei/notify-template.md`: replace `docs/profiles/investment.md` → `profiles/investment-taipei/evaluation.md`.
  - In `profiles/owner-occupied-taipei/evaluation.md` and `notify-template.md`: same kind of self-references → local filenames.
  - Verify none remain: `grep -rn "docs/profiles/\|templates/.*notify-template\|profiles/[a-z-]*\.json" profiles/` returns nothing.

- [ ] **Step 5: Rewrite `scripts/lib/profiles.ts`** to the flat model:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunRange } from './range.ts';
import type { FetchMap } from './api.ts';

export interface Profile {
  id: string;
  displayName: string;
  fetch: FetchMap;
}

export interface RunContext {
  profile: Profile;
  range: RunRange;
}

const PROFILE_DIR = 'profiles';

/** Folder names under profiles/ that contain a profile.json, sorted. */
export function availableProfileIds(): string[] {
  if (!fs.existsSync(PROFILE_DIR)) return [];
  return fs
    .readdirSync(PROFILE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PROFILE_DIR, d.name, 'profile.json')))
    .map((d) => d.name)
    .sort();
}

function availableList(): string {
  return availableProfileIds().join(', ');
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1];
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid profile: ${field} must be a non-empty string`);
  }
  return value;
}

function assertFetch(value: unknown): FetchMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid profile: fetch must be an object');
  }
  return value as FetchMap;
}

export function loadProfile(id: string): Profile {
  const dir = path.join(PROFILE_DIR, id);
  const file = path.join(dir, 'profile.json');
  if (!fs.existsSync(file)) {
    throw new Error(`unknown profile "${id}"; available profiles: ${availableList()}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`failed to read profile "${id}": ${(e as Error).message}`);
  }
  const o = parsed as Record<string, unknown>;
  const profile: Profile = {
    id,
    displayName: assertString(o.displayName, 'displayName'),
    fetch: assertFetch(o.fetch),
  };
  for (const f of ['evaluation.md', 'notify-template.md']) {
    if (!fs.existsSync(path.join(dir, f))) {
      throw new Error(`invalid profile "${id}": missing ${f}`);
    }
  }
  return profile;
}

export function resolveProfileFromArgs(argv: string[]): Profile {
  const id = flagValue(argv, '--profile');
  if (!id || id.startsWith('--')) {
    throw new Error(`--profile is required; available profiles: ${availableList()}`);
  }
  return loadProfile(id);
}

export function profileFlags(profile: Pick<Profile, 'id'>): string {
  return `--profile ${profile.id}`;
}
```

- [ ] **Step 6: Rewrite `scripts/lib/profiles.test.ts`** (tests the real migrated folders):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableProfileIds, loadProfile, resolveProfileFromArgs, profileFlags, type Profile } from './profiles.ts';

test('availableProfileIds discovers on-disk profile folders, sorted', () => {
  const ids = availableProfileIds();
  assert.ok(ids.includes('investment-taipei'));
  assert.ok(ids.includes('owner-occupied-taipei'));
  assert.deepEqual(ids, [...ids].sort());
});

test('loadProfile returns id (=folder), displayName, and fetch map', () => {
  const p = loadProfile('investment-taipei');
  assert.equal(p.id, 'investment-taipei');
  assert.equal(p.displayName, 'iBigFun 台北投資房源監測');
  assert.deepEqual(p.fetch.price_segment, { max: 2500 });
  assert.equal(p.fetch.city, '1');
});

test('loadProfile reads owner-occupied fetch arrays + ranges', () => {
  const p = loadProfile('owner-occupied-taipei');
  assert.deepEqual(p.fetch.town, ['1', '4', '6', '8', '9']);
  assert.deepEqual(p.fetch.house_type, ['17']);
  assert.deepEqual(p.fetch.house_age_segment, { max: 25 });
  assert.equal(p.fetch.parking, '平面');
});

test('loadProfile rejects an unknown id with available ids', () => {
  assert.throws(() => loadProfile('missing'), /unknown profile "missing"; available profiles: /);
});

test('resolveProfileFromArgs requires --profile and accepts both forms', () => {
  assert.throws(() => resolveProfileFromArgs(['--date', '2026-06-26']), /--profile is required/);
  assert.equal(resolveProfileFromArgs(['--profile', 'investment-taipei']).id, 'investment-taipei');
  assert.equal(resolveProfileFromArgs(['--profile=owner-occupied-taipei']).id, 'owner-occupied-taipei');
});

test('profileFlags reproduces the selected profile flag', () => {
  assert.equal(profileFlags({ id: 'investment-taipei' } as Profile), '--profile investment-taipei');
});
```

- [ ] **Step 7: Rewire `scripts/lib/steps.ts`.** Change the import on line 5 from `searchFiltersFromProfile, type RunContext` to `type RunContext`, and in `fetchStep` (line ~110) replace `const filters = searchFiltersFromProfile(profile);` with `const filters = profile.fetch;`.

- [ ] **Step 8: Update `scripts/lib/http.ts` types.** On line 7 change `type SearchFilters` → `type FetchMap`. Change `fetchPage(..., filters?: SearchFilters)` (line ~165) → `filters?: FetchMap`, and `defaultDeps(filters?: SearchFilters)` (line ~213) → `filters?: FetchMap`.

- [ ] **Step 9: Update `scripts/pipeline.ts`** profile-field usages (the old `notifyTask`/`ruleDocPath`/`templatePath` no longer exist):
  - In the report-hint block (lines ~94–97) replace `profiles/${profile.id}.json, ${profile.ruleDocPath}` with `profiles/${profile.id}/evaluation.md` and the `Template: ${profile.templatePath}` line with `Template: profiles/${profile.id}/notify-template.md`.
  - Replace both `profile.notifyTask` occurrences (lines ~107, ~111) with `profile.displayName`.

- [ ] **Step 10: Update stale doc-path references.** In `scripts/lib/region.ts` change the comment `docs/profiles/investment.md` → `profiles/investment-taipei/evaluation.md`. In `docs/reporting-rules.md` change any `docs/profiles/owner-occupied.md` / `docs/profiles/investment.md` reference to the new `profiles/<id>/evaluation.md` paths.

- [ ] **Step 11: Run the full suite.**

Run: `npm test`
Expected: PASS (all files compile; api + profiles suites green). If a `searchFiltersFromProfile` import error appears, find the missed consumer with `grep -rn "searchFiltersFromProfile\|ProfileFetchFilters\|notifyTask\|ruleDocPath\|templatePath\|type SearchFilters" scripts` and fix it.

- [ ] **Step 12: Commit.**

```bash
git add -A
git commit -m "feat(profiles): flat folder profiles + data-driven fetch map"
```

---

### Task 2: Ad-hoc `--set fetch.*` / `--unset fetch.*` overrides

**Files:**
- Modify: `scripts/lib/profiles.ts` (add override parsing/apply; wire into `resolveProfileFromArgs`)
- Create test: extend `scripts/lib/profiles.test.ts`
- Modify: `scripts/lib/runpaths.ts` (add `effectiveProfilePath`)
- Modify: `scripts/lib/steps.ts` (`fetchStep` writes effective profile)

**Interfaces:**
- Consumes: `Profile` / `FetchMap` from Task 1.
- Produces: `applyFetchOverrides(fetch: FetchMap, argv: string[]): FetchMap` (pure, exported); `effectiveProfilePath(profileId: string, label: string): string`.

- [ ] **Step 1: Write failing tests** — append to `scripts/lib/profiles.test.ts`:

```ts
import { applyFetchOverrides } from './profiles.ts';

test('applyFetchOverrides sets a scalar key', () => {
  const f = applyFetchOverrides({ city: '1' }, ['--set', 'fetch.city=2']);
  assert.equal(f.city, '2');
});

test('applyFetchOverrides sets a nested min/max key without dropping siblings', () => {
  const f = applyFetchOverrides({ price_segment: { max: 2500 } }, ['--set', 'fetch.price_segment.max=3000']);
  assert.deepEqual(f.price_segment, { max: '3000' });
});

test('applyFetchOverrides splits a comma value into an array', () => {
  const f = applyFetchOverrides({}, ['--set', 'fetch.town=16,17']);
  assert.deepEqual(f.town, ['16', '17']);
});

test('applyFetchOverrides removes a key with --unset', () => {
  const f = applyFetchOverrides({ total_floor: { max: 5 }, city: '1' }, ['--unset', 'fetch.total_floor']);
  assert.deepEqual(f, { city: '1' });
});

test('applyFetchOverrides does not mutate the input', () => {
  const orig: any = { city: '1' };
  applyFetchOverrides(orig, ['--set', 'fetch.city=2']);
  assert.equal(orig.city, '1');
});

test('applyFetchOverrides rejects a path that is not under fetch.', () => {
  assert.throws(() => applyFetchOverrides({}, ['--set', 'eval.x=1']), /--set\/--unset paths must start with "fetch\."/);
});
```

- [ ] **Step 2: Run to verify failure.** Run: `npm test` → FAIL with `applyFetchOverrides is not exported` / not a function.

- [ ] **Step 3: Implement `applyFetchOverrides` in `scripts/lib/profiles.ts`** (add after `flagValue`):

```ts
/** Collect repeated `--set k=v` / `--unset k` flags in argv order. */
function collectFlags(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] != null) out.push(argv[i + 1]);
    else if (argv[i].startsWith(`${name}=`)) out.push(argv[i].slice(name.length + 1));
  }
  return out;
}

function fetchPath(raw: string): string[] {
  if (!raw.startsWith('fetch.')) {
    throw new Error('--set/--unset paths must start with "fetch." (e.g. --set fetch.price_segment.max=3000)');
  }
  return raw.slice('fetch.'.length).split('.');
}

function parseValue(v: string): string | string[] {
  return v.includes(',') ? v.split(',') : v;
}

/** Apply ad-hoc --set fetch.* / --unset fetch.* overrides to a fetch map.
 *  Pure: returns a deep-cloned, modified copy. */
export function applyFetchOverrides(fetch: FetchMap, argv: string[]): FetchMap {
  const out: FetchMap = JSON.parse(JSON.stringify(fetch));
  for (const raw of collectFlags(argv, '--unset')) {
    const [head, sub] = fetchPath(raw);
    if (sub == null) delete out[head];
    else if (out[head] && typeof out[head] === 'object' && !Array.isArray(out[head])) {
      delete (out[head] as Record<string, unknown>)[sub];
    }
  }
  for (const raw of collectFlags(argv, '--set')) {
    const eq = raw.indexOf('=');
    if (eq === -1) throw new Error(`--set needs key=value, got "${raw}"`);
    const [head, sub] = fetchPath(raw.slice(0, eq));
    const value = parseValue(raw.slice(eq + 1));
    if (sub == null) {
      out[head] = value;
    } else {
      const cur = out[head];
      const base = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>) : {};
      out[head] = { ...base, [sub]: value } as FetchValue;
    }
  }
  return out;
}
```

Then wire it into `resolveProfileFromArgs` — before `return loadProfile(id)` becomes:

```ts
  const profile = loadProfile(id);
  return { ...profile, fetch: applyFetchOverrides(profile.fetch, argv) };
```

Add `FetchValue` to the `import type { FetchMap }` line: `import type { FetchMap, FetchValue } from './api.ts';`.

- [ ] **Step 4: Run to verify pass.** Run: `npm test` → PASS.

- [ ] **Step 5: Add `effectiveProfilePath` to `scripts/lib/runpaths.ts`:**

```ts
export function effectiveProfilePath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'effective-profile.json');
}
```

- [ ] **Step 6: Write the effective profile in `fetchStep`** (`scripts/lib/steps.ts`). Add `effectiveProfilePath` to the runpaths import, and after `fs.mkdirSync(runDir(...))` in `fetchStep` write:

```ts
  fs.writeFileSync(
    effectiveProfilePath(profile.id, range.label),
    JSON.stringify({ displayName: profile.displayName, fetch: profile.fetch }, null, 2),
  );
```

- [ ] **Step 7: Run tests + commit.**

Run: `npm test` → PASS

```bash
git add -A
git commit -m "feat(profiles): --set/--unset fetch overrides + effective-profile.json"
```

---

### Task 3: Docs, prompts, ids, and the authoring guide

**Files:**
- Create: `profiles/README.md` (agent authoring guide)
- Modify: `AGENTS.md` (folders, ids, paths, `--task`=displayName, `--set`, link README)
- Modify: `docs/fetching.md` (fetch from `profile.json` `fetch`; drop `fetchFilters.enabled`)
- Modify: `data/ibigfun-filter-mappings.md` (absorb the dropped investment `description` prose)
- Modify: `prompts/daily-run.md`, `prompts/schedule-triggers.md` (any `--profile investment`/`owner-occupied` → `-taipei`)

**Interfaces:** none (docs only).

- [ ] **Step 1: Find every stale id / path reference.**

Run: `grep -rn "profiles/investment\.json\|profiles/owner-occupied\.json\|docs/profiles/\|templates/.*notify-template\|--profile investment\b\|--profile owner-occupied\b\|notifyTask\|fetchFilters\|ruleDocPath\|templatePath\|requiresFilterVerification" AGENTS.md docs prompts data`
Expected: a list to work through; each must be updated to the folder model and `-taipei` ids.

- [ ] **Step 2: Update `AGENTS.md`.** In the Daily Run Sequence and Source-Of-Truth Map: profiles are folders `profiles/<id>/`; rule doc = `profiles/<id>/evaluation.md`; template = `profiles/<id>/notify-template.md`; the runnable ids are `investment-taipei` / `owner-occupied-taipei`; the notification `--task` is the profile's `displayName`; conditions live in `fetch` (profile.json) + `evaluation.md`; mention `--set fetch.*` for ad-hoc runs; add a Source-Of-Truth-Map line: `profiles/README.md: how to author a profile`. Remove references to `profiles/<profile>.json`, `docs/profiles/*.md`, `templates/*-notify-template.md`, `fetchFilters`, `notifyTask`.

- [ ] **Step 3: Update `docs/fetching.md`** — the fetch filters now come from `profile.json`'s `fetch` map walked by `buildSearchBody`; remove the `fetchFilters.enabled`/captured-default-branch framing; point at `profiles/<id>/profile.json` and `data/ibigfun-filter-mappings.md`.

- [ ] **Step 4: Update `data/ibigfun-filter-mappings.md`** — fold in the investment filter description that used to live in `profiles/investment.json`'s `fetchFilters.description` (city=1, price max 2500, floor 2–4, total_floor max 5, no town/house_type). Keep it the human key for the `fetch` map keys.

- [ ] **Step 5: Update `prompts/daily-run.md` and `prompts/schedule-triggers.md`** — replace `--profile investment` → `--profile investment-taipei` and `--profile owner-occupied` → `--profile owner-occupied-taipei` (and any prose naming the old ids).

- [ ] **Step 6: Write `profiles/README.md`** — the authoring guide. Sections (from spec §6): folder layout & the three files; `profile.json` schema (`displayName`, `fetch`, both required, id=folder name); the `fetch` encoding table (scalar / `{min,max}` / array → API body) + pointer to `data/ibigfun-filter-mappings.md`; recipe to add a search (`cp -r` a folder, rename, edit the three files); `--set fetch.*` / `--unset fetch.*` ad-hoc overrides and that NL maps to them; validation/common errors (missing folder/file, missing `displayName`/`fetch`); a one-line "no inheritance yet — copy a folder" note.

- [ ] **Step 7: Verify nothing stale remains + tests still green.**

Run: `grep -rn "fetchFilters\|notifyTask\|ruleDocPath\|templatePath\|docs/profiles/\|--profile investment\b\|--profile owner-occupied\b" AGENTS.md docs prompts data scripts` → no functional hits (only historical mentions inside the spec/plan are acceptable).
Run: `npm test` → PASS.

- [ ] **Step 8: Commit.**

```bash
git add -A
git commit -m "docs(profiles): folder model, -taipei ids, authoring guide (profiles/README.md)"
```

---

## Self-Review

**Spec coverage:** §1 folder layout → T1 S3. §2 profile.json shape → T1 S3,S5. §3 generic buildSearchBody → T1 S1–S2. §4 auto-discovery → T1 S5–S6. §5 CLI overrides → T2. §6 authoring guide → T3 S6. Affected code (api/profiles/http/steps/pipeline/region) → T1. Migration → T1 S3–S4, T3. Testing → T1 S2,S6 + T2 S1.

**Placeholder scan:** All code steps contain full code; file moves give exact source→dest; doc steps name the exact edits + a verifying grep. No TBD/TODO.

**Type consistency:** `FetchMap`/`FetchValue` defined in `api.ts` (T1 S1) and consumed by `profiles.ts` (T1 S5), `http.ts` (T1 S8), and `applyFetchOverrides` (T2 S3). `Profile = {id, displayName, fetch}` defined T1 S5 and used by `pipeline.ts` (T1 S9), `steps.ts` (T1 S7). `effectiveProfilePath` defined T2 S5, used T2 S6. Consistent.

## Out of Scope (verify manually, do not automate)

A live `npm run fetch -- --profile investment-taipei --date <recent>` would log in with the single shared account (logs the user out) and hit the network — left for the user to run interactively if they want a live confirmation. Automated verification is `npm test` + an offline smoke (loadProfile + buildSearchBody) in the e2e step.
