# Daily Dual-Route Trial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in report substep that calculates and displays comparable ORS and Valhalla walking times only for properties rendered individually in daily notifications.

**Architecture:** Keep ORS enrichment and all production decisions unchanged. The report agent hands selected enriched indexes to a deterministic `route-trial` CLI, which recomputes candidate exits, reuses an isolated Valhalla cache, persists local comparison evidence, and supplies a dual-source `walk_line`; report validation and worker documentation make the trial line mandatory while allowing Valhalla to degrade visibly without changing notification status.

**Tech Stack:** TypeScript, Node.js built-in `fs`/`crypto`, `node:test`, existing MRT/enrichment/walk/Valhalla modules, Markdown operator instructions.

## Global Constraints

- ORS remains authoritative for `walk`, `withinWalk`, `regionGate`, hard exclusions, bucket selection, sorting, and notification status.
- Valhalla evidence is display-only and never fills or overrides an ORS decision.
- Only positive, candidate, and risk listings rendered individually are selected; count-only excluded listings generate no Valhalla work.
- Both displayed times equal `Math.round(distanceM / 80)`, matching 4.8 km/h and the existing 800 m = 10 minute rule.
- Valhalla provider failures are per-listing unavailable evidence and do not fail the command or change notification status.
- Invalid local inputs or persistence failures make the CLI fail, but the report agent still renders `Valhalla 暫無（試行）` and completes the original notification status.
- Requests are sequential with at least 1,000 ms between top-level cache-miss calls, use the existing bounded client retry, and select at most 25 listings.
- `state/route-cache.json`, enriched artifacts, listings, pipeline manifests/journals, reports, and notifications are never mutated by the trial command.
- Detailed trial request/result/cache files remain git-ignored local state and never appear in notifications or commits.
- Console output is aggregate-only and errors never expose coordinates, listing IDs, endpoint paths, raw responses, or stack traces.
- Every behavior change is implemented test-first with observed RED and GREEN evidence.

---

### Task 1: Pure request binding, comparison records, and notification formatting

**Files:**
- Create: `scripts/lib/route-trial.ts`
- Create: `scripts/lib/route-trial.test.ts`
- Modify: `scripts/lib/runpaths.ts`
- Modify: `scripts/lib/runpaths.test.ts`

**Interfaces:**
- Consumes: `FetchResult`, `EnrichResult`, `EnrichedListing`, `OfflineEnriched`, `enrichOffline`, `pickWalk`, `cacheKey`, `MrtExit`, and `RunRange`.
- Produces:

```ts
export interface RouteTrialRequest {
  schemaVersion: 1;
  profileId: string;
  rangeLabel: string;
  listingIndexes: number[];
}

export interface RouteTrialWalk {
  status: 'reliable' | 'unavailable';
  stationZh: string | null;
  exitId: string | null;
  distanceM: number | null;
  minutes: number | null;
}

export interface RouteTrialSelection {
  listingIndex: number;
  listingId: number | null;
  original: Listing;
  enriched: EnrichedListing;
  offline: OfflineEnriched;
  routeKey: string | null;
}

export interface RouteTrialComparison {
  listingIndex: number;
  listingId: number | null;
  ors: RouteTrialWalk;
  valhalla: RouteTrialWalk;
  error: string | null;
}

export function selectRouteTrialListings(
  request: unknown,
  profileId: string,
  range: RunRange,
  fetched: unknown,
  enriched: unknown,
  exits: MrtExit[],
): RouteTrialSelection[];

export function reliableOrsTrialWalk(listing: EnrichedListing): RouteTrialWalk;
export function valhallaTrialWalk(
  selection: RouteTrialSelection,
  distances: (number | null)[] | null,
): RouteTrialWalk;
export function unavailableTrialWalk(): RouteTrialWalk;
export function formatDualRouteWalkLine(
  comparison: RouteTrialComparison,
  coordinate: Coordinate | null,
): string;
```

Add paths:

```ts
routeTrialRequestPath(profileId, label) // route-trial-request.json
routeTrialResultPath(profileId, label)  // route-trial.json
```

- [ ] **Step 1: Write failing request-binding tests**

Create fixtures with aligned `FetchResult`/`EnrichResult` arrays and assert:

```ts
const selected = selectRouteTrialListings(
  { schemaVersion: 1, profileId: 'p', rangeLabel: range.label, listingIndexes: [2, 0] },
  'p', range, fetched, enriched, exits,
);
assert.deepEqual(selected.map((x) => x.listingIndex), [2, 0]);
assert.equal(selected[0].listingId, null); // null source IDs remain addressable by index
```

Table-drive rejection of wrong schema/profile/range, missing/non-array indexes,
duplicates, negative/fractional/out-of-range indexes, 26 indexes, mismatched
fetch/enrich metadata, count/array mismatch, and indexed listing identity drift.
Identity binding must compare ID, title, URL, and exact coordinate; it must not
use title or ID alone.

- [ ] **Step 2: Run request tests and verify RED**

Run: `node --import tsx --test scripts/lib/route-trial.test.ts`

Expected: FAIL because the module and interfaces do not exist.

- [ ] **Step 3: Implement strict selection and path helpers**

Validate the complete consumed shapes before indexing. Preserve request order.
For every selected original listing call `enrichOffline(original, exits)` and
set `routeKey = cacheKey(original.coordinate, offline.candidates)` only when a
coordinate exists, candidates exist, and `coordConsistent !== false`; otherwise
use `null`. Do not mutate any input object.

- [ ] **Step 4: Run request/path tests and verify GREEN**

Run:

```bash
node --import tsx --test scripts/lib/route-trial.test.ts scripts/lib/runpaths.test.ts
```

Expected: all request binding and run-path tests pass.

- [ ] **Step 5: Write failing provider/format tests**

Cover these exact cases:

```ts
assert.deepEqual(reliableOrsTrialWalk(enrichedListingWith720mWalk), {
  status: 'reliable', stationZh: '松江南京', exitId: '4',
  distanceM: 720, minutes: 9,
});

assert.equal(
  formatDualRouteWalkLine(comparison, { lat: 25.1, lng: 121.5 }),
  '🚶 ORS 松江南京 4號出口・9分｜Valhalla 松江南京 3號出口・10分（試行）・[地圖](https://www.google.com/maps?q=25.1,121.5)',
);
```

Also assert:

- ORS `walk: null` or unreliable evidence becomes `ORS 待確認`;
- Valhalla uses `pickWalk` over recomputed candidates and uses its selected exit;
- implausible/null Valhalla routes become `Valhalla 暫無（試行）`;
- blank exit IDs omit `號出口`;
- both minutes use `Math.round(distanceM / 80)`;
- coordinate null returns exactly `🚶 無位置資訊`; and
- formatting does not print distance, IDs, raw errors, or internal status names.

- [ ] **Step 6: Run provider/format tests and verify RED**

Run: `node --import tsx --test scripts/lib/route-trial.test.ts`

Expected: FAIL because provider conversion and dual-line formatting are absent.

- [ ] **Step 7: Implement provider conversion and formatter**

`reliableOrsTrialWalk` trusts only `enriched.walk` with
`reliability.routeOk === true` and `reliability.coordConsistent !== false`.
`valhallaTrialWalk` returns unavailable without calling `pickWalk` when
`routeKey === null`; otherwise it maps only a `pickWalk(...).routeOk === true`
result. Build provider labels with one helper:

```ts
function providerLabel(name: 'ORS' | 'Valhalla', walk: RouteTrialWalk): string {
  if (walk.status === 'unavailable') return name === 'ORS' ? 'ORS 待確認' : 'Valhalla 暫無（試行）';
  const exit = walk.exitId ? ` ${walk.exitId}號出口` : '';
  const trial = name === 'Valhalla' ? '（試行）' : '';
  return `${name} ${walk.stationZh}${exit}・${walk.minutes}分${trial}`;
}
```

- [ ] **Step 8: Run Task 1 tests and verify GREEN**

Run:

```bash
node --import tsx --test scripts/lib/route-trial.test.ts scripts/lib/runpaths.test.ts
npx tsc --noEmit
git diff --check
```

- [ ] **Step 9: Commit Task 1**

```bash
git add scripts/lib/route-trial.ts scripts/lib/route-trial.test.ts scripts/lib/runpaths.ts scripts/lib/runpaths.test.ts
git commit -m "feat: define daily route trial evidence"
```

---

### Task 2: Dedicated Valhalla trial cache

**Files:**
- Create: `scripts/lib/valhalla-trial-cache.ts`
- Create: `scripts/lib/valhalla-trial-cache.test.ts`

**Interfaces:**
- Consumes: normalized Valhalla base URL, canonical route keys, aligned Valhalla distance arrays.
- Produces:

```ts
export const VALHALLA_TRIAL_CACHE_PATH = 'state/valhalla-trial-cache.json';

export interface ValhallaTrialCacheEntry {
  distances: (number | null)[];
  cachedAt: string;
}

export interface ValhallaTrialCache {
  schemaVersion: 1;
  endpoints: Record<string, { routes: Record<string, ValhallaTrialCacheEntry> }>;
}

export function trialEndpointKey(normalizedBaseUrl: string): string;
export function loadValhallaTrialCache(rootDir: string): ValhallaTrialCache;
export function getValhallaTrialCacheEntry(
  cache: ValhallaTrialCache,
  endpointKey: string,
  routeKey: string,
  expectedLength: number,
): (number | null)[] | null;
export function putValhallaTrialCacheEntry(
  cache: ValhallaTrialCache,
  endpointKey: string,
  routeKey: string,
  distances: (number | null)[],
  cachedAt: string,
): void;
export function saveValhallaTrialCacheAtomic(rootDir: string, cache: ValhallaTrialCache): void;
```

- [ ] **Step 1: Write failing cache validation and isolation tests**

Assert a missing file returns `{ schemaVersion: 1, endpoints: {} }`. Reject
wrong schema, extra top-level keys, non-hex endpoint keys, malformed route
maps, invalid dates, and distances that are not finite non-negative numbers or
null. Assert:

```ts
assert.match(trialEndpointKey('https://example.test/path'), /^[a-f0-9]{64}$/);
assert.notEqual(
  trialEndpointKey('https://example.test/path-a'),
  trialEndpointKey('https://example.test/path-b'),
);
assert.equal(JSON.stringify(cache).includes('/path-a'), false);
```

Verify cache lookup rejects an otherwise valid entry whose distance count does
not equal `expectedLength`, and returned/inserted arrays cannot mutate stored
state by aliasing.

- [ ] **Step 2: Run cache tests and verify RED**

Run: `node --import tsx --test scripts/lib/valhalla-trial-cache.test.ts`

Expected: FAIL because the cache module does not exist.

- [ ] **Step 3: Implement schema, endpoint hashing, and immutable access**

Use `createHash('sha256').update(normalizedBaseUrl).digest('hex')`. Validate
every nested key/value before casting. Clone distance arrays on get and put.
Do not import or call production ORS cache functions.

- [ ] **Step 4: Run cache logic tests and verify GREEN**

Run: `node --import tsx --test scripts/lib/valhalla-trial-cache.test.ts`

- [ ] **Step 5: Write failing atomic persistence tests**

In a disposable root, assert save creates only
`state/valhalla-trial-cache.json`, replaces a prior valid cache, leaves no
`.tmp-*` sibling, and preserves the prior final bytes when an injected rename
fails. Inject filesystem operations through an optional final argument rather
than patching Node globals:

```ts
interface TrialCacheFileOps {
  writeExclusive(file: string, contents: string): void;
  rename(source: string, destination: string): void;
  remove(file: string): void;
}
```

- [ ] **Step 6: Run persistence tests and verify RED**

Run: `node --import tsx --test scripts/lib/valhalla-trial-cache.test.ts`

Expected: FAIL because atomic persistence is absent.

- [ ] **Step 7: Implement unique-temp atomic replacement**

Create `state/`, write a mode-`0600` unique sibling with `wx`, rename on the
same filesystem, and always attempt temp cleanup. On failure throw a fixed
`Valhalla trial cache persistence failed` error without paths or contents.

- [ ] **Step 8: Run Task 2 tests and verify GREEN**

Run:

```bash
node --import tsx --test scripts/lib/valhalla-trial-cache.test.ts
npx tsc --noEmit
git diff --check
```

- [ ] **Step 9: Commit Task 2**

```bash
git add scripts/lib/valhalla-trial-cache.ts scripts/lib/valhalla-trial-cache.test.ts
git commit -m "feat: add isolated Valhalla trial cache"
```

---

### Task 3: Trial runner, artifact, and CLI

**Files:**
- Create: `scripts/lib/route-trial-run.ts`
- Create: `scripts/lib/route-trial-run.test.ts`
- Create: `scripts/route-trial.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 selection/comparison functions and Task 2 cache functions, `routeValhallaWalkDistances`, `safeValhallaErrorMessage`, `normalizeValhallaBaseUrl`, `valhallaEndpointIdentifier`, profile/range resolvers, MRT CSV.
- Produces:

```ts
export interface RouteTrialOptions {
  rootDir: string;
  profileId: string;
  range: RunRange;
  valhallaBaseUrl: string;
  requestDelayMs: number;
}

export interface RouteTrialSummary {
  requested: number;
  completed: number;
  cacheHits: number;
  apiCalls: number;
  unavailable: number;
}

export interface RouteTrialArtifact {
  schemaVersion: 1;
  profileId: string;
  rangeLabel: string;
  generatedAt: string;
  valhallaEndpoint: string;
  comparisons: RouteTrialComparison[];
  summary: RouteTrialSummary;
}

export async function runRouteTrial(
  options: RouteTrialOptions,
  deps?: Partial<RouteTrialDeps>,
): Promise<{ artifactPath: string; artifact: RouteTrialArtifact }>;
```

`npm run route-trial -- --profile <profile> [--date <d> | --from <a> --to <b>]`
accepts only those documented arguments. It reads the request from the path
added in Task 1 and writes the result path added in Task 1.

- [ ] **Step 1: Write failing runner input and no-route tests**

Build disposable run directories and assert all local validation occurs before
the route dependency:

- missing/malformed request, listings, enriched data, or MRT input;
- request/profile/range/index errors delegated to Task 1;
- malformed trial cache delegated to Task 2;
- a selected null-coordinate listing produces one unavailable comparison,
  zero route calls, and zero cache writes; and
- the ORS cache file is byte-identical before/after every successful run.

All command-level errors must be fixed safe messages without fixture paths,
coordinates, listing IDs, endpoint paths, or raw JSON.

- [ ] **Step 2: Run runner tests and verify RED**

Run: `node --import tsx --test scripts/lib/route-trial-run.test.ts`

Expected: FAIL because the runner is absent.

- [ ] **Step 3: Implement strict input loading and zero-route artifact**

Read JSON as `unknown`, pass request/fetch/enrich to
`selectRouteTrialListings`, and translate file/JSON/schema failures to these
fixed categories:

```text
Valhalla trial request is missing or invalid
Valhalla trial listings input is missing or invalid
Valhalla trial enriched input is missing or invalid
Valhalla trial MRT input is missing or invalid
Valhalla trial cache is invalid
Valhalla trial result persistence failed
```

Write `route-trial.json` through a unique temp sibling and atomic replacement.
Artifact persistence must not call the hard-link benchmark publisher because
this fixed per-run result is intentionally replaceable on resume.

- [ ] **Step 4: Run zero-route tests and verify GREEN**

Run: `node --import tsx --test scripts/lib/route-trial-run.test.ts`

- [ ] **Step 5: Write failing cache/dedup/rate/failure tests**

Use two selected listings sharing a route key plus distinct misses and assert:

- a valid cache hit calls no provider and is counted once per unique key;
- duplicate route keys call Valhalla once and fan out to both comparisons;
- only cache-miss calls appear in `apiCalls`;
- miss calls are sequential and `sleep(1000)` occurs between top-level calls,
  never after the final miss or around cache hits;
- successful aligned responses enter the dedicated cache with injected time;
- provider throw/HTTP/timeout/invalid response becomes safe unavailable evidence,
  continues the next key, is not cached, and the CLI-level run succeeds;
- ORS records always come from enriched `walk`, never Valhalla; and
- summary counts requested comparisons, reliable Valhalla completions,
  unique cached route keys, top-level calls, and unavailable comparisons exactly.

- [ ] **Step 6: Run routing tests and verify RED**

Run: `node --import tsx --test scripts/lib/route-trial-run.test.ts`

Expected: FAIL because routing orchestration is absent.

- [ ] **Step 7: Implement deterministic routing orchestration**

Precompute unique route keys in first-request order. For each key use a valid
cache entry or call:

```ts
routeValhallaWalkDistances(
  selection.original.coordinate!,
  selection.offline.candidates.map(({ exit }) => ({ lat: exit.lat, lng: exit.lng })),
  { baseUrl: normalizedBaseUrl },
);
```

Save each successful response atomically before continuing. Store a fixed safe
message from `safeValhallaErrorMessage` only in local comparison evidence.
Compose comparisons in original request order.

- [ ] **Step 8: Write failing CLI integration tests**

Spawn the real CLI with an offline fetch preload. Assert:

- unknown/repeated/positional flags exit 2 before routing;
- missing/invalid local input exits 2 with aggregate fixed stderr;
- unexpected persistence failure exits 1;
- provider-level failures still exit 0 and write a result;
- success prints only `{ artifact, summary }` JSON to stdout;
- stderr contains aggregate progress only; and
- a `VALHALLA_URL` path override affects routing/cache isolation but neither
  its path nor synthetic secrets enter stdout, stderr, or the artifact.

- [ ] **Step 9: Run CLI tests and verify RED**

Run: `node --import tsx --test scripts/lib/route-trial-run.test.ts`

- [ ] **Step 10: Implement CLI and package script**

Add:

```json
"route-trial": "tsx scripts/route-trial.ts"
```

Validate the complete grammar before resolving profile/range. Map documented
local input categories to exit 2 and unexpected persistence/runtime errors to
exit 1. Never print a caught object or stack.

- [ ] **Step 11: Run Task 3 verification and commit**

Run:

```bash
node --import tsx --test scripts/lib/route-trial.test.ts scripts/lib/valhalla-trial-cache.test.ts scripts/lib/route-trial-run.test.ts
npx tsc --noEmit
git diff --check
```

Then:

```bash
git add package.json scripts/route-trial.ts scripts/lib/route-trial-run.ts scripts/lib/route-trial-run.test.ts
git commit -m "feat: run selected daily Valhalla trials"
```

---

### Task 4: Daily notification enforcement, operator docs, and live smoke

**Files:**
- Modify: `scripts/lib/report-format.ts`
- Modify: `scripts/lib/report-format.test.ts`
- Modify: `AGENTS.md`
- Modify: `docs/reporting-rules.md`
- Modify: `prompts/daily-run.md`
- Verify: `package.json`, all Task 1–3 files

**Interfaces:**
- Consumes: `route-trial-request.json`, `route-trial.json`, and Task 1 dual-line format.
- Produces: a report contract requiring dual-source trial labels for every coordinate-backed walking line; no-coordinate lines remain unchanged.

- [ ] **Step 1: Write failing report-format enforcement tests**

Update valid examples to dual lines and add rejections for an old ORS-only line,
a line missing `Valhalla`, and a line missing `（試行）`. Keep the coordinate-map
link tests. Exact accepted examples:

```text
🚶 ORS 北門 3號出口・5分｜Valhalla 北門 2號出口・6分（試行）・[地圖](https://www.google.com/maps?q=25.0508876,121.5126656)
🚶 ORS 待確認｜Valhalla 暫無（試行）・[地圖](https://www.google.com/maps?q=25.1,121.5)
🚶 無位置資訊
```

- [ ] **Step 2: Run report-format tests and verify RED**

Run: `node --import tsx --test scripts/lib/report-format.test.ts`

Expected: old single-provider lines currently pass and new enforcement tests fail.

- [ ] **Step 3: Implement dual-source report validation**

For every coordinate-backed `🚶` line, require all three tokens: `ORS`,
`Valhalla`, and `（試行）`, plus the existing exact coordinate map link. Reject
with `walking line <n> must include ORS and Valhalla trial labels`. Continue to
accept exactly `🚶 無位置資訊` without a map or provider tokens.

- [ ] **Step 4: Run report-format tests and verify GREEN**

Run: `node --import tsx --test scripts/lib/report-format.test.ts`

- [ ] **Step 5: Update daily instructions and notification contract**

In `AGENTS.md` insert the report-owned trial substep after evaluation and before
writing `report.md`, document the CLI/cache/result artifacts, and state that
trial failure renders `Valhalla 暫無（試行）` without changing status.

In `docs/reporting-rules.md` replace the reliable/unreliable `walk_line` examples
with the exact dual-source forms from the design; retain `🚶 無位置資訊`.

In `prompts/daily-run.md` require the worker to:

1. finish bucketing first;
2. write request indexes for every positive/candidate/risk listing only;
3. invoke `npm run route-trial` once with the same profile/range flags;
4. bind results by index and ID;
5. render explicit unavailable fallback on any command/provider failure; and
6. preserve the original `--status-notify` decision.

State that excluded/count-only listings never enter the request and no failure
path invokes `pipeline fail` solely because of Valhalla trial evidence.

- [ ] **Step 6: Run documentation contract tests**

Run:

```bash
node --import tsx --test scripts/lib/report-format.test.ts scripts/lib/notification-policy.test.ts
```

Update only existing documentation assertions that intentionally encode the old
walk-line contract. Do not weaken unrelated notification policy tests.

- [ ] **Step 7: Run full static verification**

Run:

```bash
npm test
npx tsc --noEmit
git diff --check
```

Expected: all tests pass, TypeScript exits 0, and diff check exits 0.

- [ ] **Step 8: Run a five-listing live wire smoke without notification**

Because local profiles/state live only in the main checkout, run the worktree
CLI executable while the working directory is
`/Users/jakechen/Documents/ibigfun-automation`. Use profile
`investment-taipei.local`, date `2026-08-09`, and a request selecting indexes
`[0,1,2,3,4]`. Before the run capture SHA-256 for:

```text
state/runs/investment-taipei.local/2026-08-09/listings.json
state/runs/investment-taipei.local/2026-08-09/enriched.json
state/route-cache.json
```

Invoke the worktree `node_modules/.bin/tsx` and worktree
`scripts/route-trial.ts`; if restricted network access blocks it, rerun the
same command with required escalation. Do not run notify or pipeline mark.

Verify five comparisons exist, provider failures degrade per listing, stdout
and stderr are aggregate-only, the dedicated cache/result are the only intended
mutations, and all three protected hashes remain byte-identical. Do not paste
coordinates, listing IDs, titles, or detailed artifact contents into the report.

- [ ] **Step 9: Commit Task 4**

```bash
git add AGENTS.md docs/reporting-rules.md prompts/daily-run.md scripts/lib/report-format.ts scripts/lib/report-format.test.ts
git commit -m "docs: enable daily dual-route trial"
```
