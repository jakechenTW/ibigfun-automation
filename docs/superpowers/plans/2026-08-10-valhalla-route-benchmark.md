# Valhalla Route Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated command that compares cached ORS walking distances with rate-limited FOSSGIS Valhalla matrix results without changing production enrichment or notifications.

**Architecture:** A focused Valhalla HTTP client converts the public matrix response into the same aligned distance-array shape used by ORS. Pure benchmark functions reconstruct historical candidate exits and compare both providers through the existing `pickWalk` policy, while a thin runner owns artifact I/O, sequential fair-use requests, CLI parsing, and aggregate-only output.

**Tech Stack:** TypeScript 5.6, Node.js 22 built-in `fetch`, `node:test`, existing MRT/enrichment/walk helpers, JSON artifacts under git-ignored `state/`.

## Global Constraints

- Production `enrich`, `routeWalkDistances`, `withinWalk`, `regionGate`, hard exclusions, reports, notifications, schedules, profiles, and `state/route-cache.json` remain unchanged.
- The default endpoint is `https://valhalla1.openstreetmap.de`; `VALHALLA_URL` may override it.
- Requests contain coordinates only and set a stable non-personal `X-Client-Id`; no address, listing metadata, credential, API key, or source URL may leave the process.
- Requests are sequential with at least 1,000 ms between starts; transient `429`/`5xx` responses receive at most one retry, with retry waiting capped at 10,000 ms.
- Each request uses a 15,000 ms default timeout, `pedestrian` costing, 4.8 km/h walking speed, kilometer units, and compact matrix output.
- `--limit` defaults to 25, accepts integers from 1 through 200, and is applied after deterministic route-cache-key deduplication.
- Automated tests use injected `fetch`, clock, sleep, filesystem roots, and route functions; they never call a live service.
- Detailed output stays under `state/route-benchmarks/`; stdout and stderr are aggregate-only and never enter the daily pipeline or notifier.

---

## File Map

- Create `scripts/lib/valhalla-routing.ts`: isolated Valhalla matrix HTTP client and bounded transient retry.
- Create `scripts/lib/valhalla-routing.test.ts`: request/response, timeout, validation, and retry tests.
- Create `scripts/lib/route-benchmark.ts`: pure historical-case selection and ORS/Valhalla comparison metrics.
- Create `scripts/lib/route-benchmark.test.ts`: deterministic selection, skips, transitions, boundary, and delta tests.
- Create `scripts/lib/route-benchmark-run.ts`: historical artifact loading, sequential execution, safe persistence, and aggregate result assembly.
- Create `scripts/lib/route-benchmark-run.test.ts`: temporary-workspace integration tests proving privacy and non-mutation.
- Create `scripts/route-benchmark.ts`: CLI argument handling and aggregate-only console rendering.
- Modify `package.json`: expose `npm run route-benchmark`.
- Modify `AGENTS.md`: document the experimental command, public-demo boundary, and non-production status.

---

### Task 1: Valhalla Matrix Client

**Files:**
- Create: `scripts/lib/valhalla-routing.test.ts`
- Create: `scripts/lib/valhalla-routing.ts`

**Interfaces:**
- Consumes: `LatLng` from `scripts/lib/geo.ts`, Node's global `fetch`, and an injectable sleep function.
- Produces:

```ts
export const DEFAULT_VALHALLA_URL = 'https://valhalla1.openstreetmap.de';
export const DEFAULT_VALHALLA_TIMEOUT_MS = 15_000;
export const DEFAULT_VALHALLA_CLIENT_ID = 'ibigfun-automation-route-benchmark/0.4';

export interface ValhallaRouteOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetryDelayMs?: number;
}

export async function routeValhallaWalkDistances(
  origin: LatLng,
  dests: LatLng[],
  options?: ValhallaRouteOptions,
): Promise<(number | null)[]>;
```

- `routeValhallaWalkDistances` returns an empty array without calling `fetch` when `dests` is empty.
- Safe thrown messages identify timeout, HTTP status, or invalid matrix shape but never include response bodies or coordinates.

- [ ] **Step 1: Write failing request and conversion tests**

Create tests that inject `fetchFn`, capture the URL, headers, and JSON body, and return:

```ts
new Response(JSON.stringify({
  sources_to_targets: {
    durations: [[315, null, 754]],
    distances: [[0.42, null, 1.005]],
  },
  units: 'kilometers',
  algorithm: 'costmatrix',
}), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});
```

Assert:

```ts
assert.equal(url, 'https://example.test/sources_to_targets');
assert.equal(headers.get('X-Client-Id'), 'ibigfun-automation-route-benchmark/0.4');
assert.deepEqual(body, {
  sources: [{ lat: 25.033, lon: 121.565 }],
  targets: [
    { lat: 25.034, lon: 121.566 },
    { lat: 25.035, lon: 121.567 },
    { lat: 25.036, lon: 121.568 },
  ],
  costing: 'pedestrian',
  costing_options: { pedestrian: { walking_speed: 4.8 } },
  units: 'kilometers',
  verbose: false,
});
assert.deepEqual(result, [420, null, 1005]);
```

Also assert no fetch occurs for an empty destination array.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test scripts/lib/valhalla-routing.test.ts
```

Expected: FAIL because `./valhalla-routing.ts` and its exports do not exist.

- [ ] **Step 3: Implement the request and strict response conversion**

Implement a private `attempt()` that:

```ts
const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/sources_to_targets`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Client-Id': DEFAULT_VALHALLA_CLIENT_ID,
  },
  body: JSON.stringify(body),
  signal: controller.signal,
});
```

Validate `json.sources_to_targets.distances` as a single row whose length equals
`dests.length`. Do not fall back to a top-level `distances` property. Accept
only `null` or finite non-negative numbers, and convert kilometers with
`Math.round(km * 1000)`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same `node --import tsx --test` command.

Expected: all request and conversion tests PASS.

- [ ] **Step 5: Write failing timeout, malformed-response, and retry tests**

Add tests for:

- abort after a 5 ms injected timeout;
- wrong row count, wrong destination count, negative/NaN/string distance;
- safe `HTTP 400` rejection that does not contain the response body;
- one `429` followed by success, using `Retry-After: 2` and asserting injected sleep receives `2000`;
- one `503` followed by success, using the 1,000 ms fallback delay;
- repeated `503` rejects after exactly two fetch attempts;
- `Retry-After: 999` is capped at `10_000` ms.

- [ ] **Step 6: Run the focused test and verify RED**

Expected: retry and safe-validation tests FAIL because the first implementation performs only one attempt or lacks the required validation.

- [ ] **Step 7: Implement bounded retry and timeout classification**

Add a private result/error type carrying only HTTP status. Retry exactly once
when status is `429` or between `500` and `599`. Parse integer-second
`Retry-After`; use 1,000 ms when absent or invalid; clamp to
`options.maxRetryDelayMs ?? 10_000`. Create a fresh `AbortController` and timer
for each attempt. Translate an aborted request to:

```ts
throw new Error(`Valhalla matrix timeout after ${timeoutMs}ms`);
```

- [ ] **Step 8: Run focused tests and commit**

Run:

```bash
node --import tsx --test scripts/lib/valhalla-routing.test.ts
git add scripts/lib/valhalla-routing.ts scripts/lib/valhalla-routing.test.ts
git commit -m "feat: add Valhalla matrix client"
```

Expected: focused tests PASS and the commit succeeds.

---

### Task 2: Pure Historical Selection and Comparison

**Files:**
- Create: `scripts/lib/route-benchmark.test.ts`
- Create: `scripts/lib/route-benchmark.ts`

**Interfaces:**
- Consumes: `FetchResult`, `Listing`, `MrtExit`, `NearestExit`, `RouteCache`, `enrichOffline`, `cacheKey`, and `pickWalk`.
- Produces:

```ts
export type BenchmarkSkipReason =
  | 'no-coordinate'
  | 'coordinate-conflict'
  | 'no-candidates'
  | 'ors-cache-miss'
  | 'ors-cache-shape';

export interface DatedFetchResult {
  date: string;
  result: FetchResult;
}

export interface BenchmarkCase {
  date: string;
  listingId: number | null;
  routeKey: string;
  origin: LatLng;
  candidates: NearestExit[];
  orsDistances: (number | null)[];
}

export interface CaseSelection {
  scanned: number;
  eligibleBeforeLimit: number;
  duplicateRouteKeys: number;
  skipped: Record<BenchmarkSkipReason, number>;
  cases: BenchmarkCase[];
}

export function selectBenchmarkCases(
  runs: DatedFetchResult[],
  exits: MrtExit[],
  routeCache: RouteCache,
  limit: number,
): CaseSelection;

export type WalkTransition =
  | 'true->true' | 'true->false' | 'true->null'
  | 'false->true' | 'false->false' | 'false->null'
  | 'null->true' | 'null->false' | 'null->null';

export interface BenchmarkComparison {
  benchmarkCase: BenchmarkCase;
  valhallaDistances: (number | null)[] | null;
  error: string | null;
  ors: WalkPick;
  valhalla: WalkPick;
  transition: WalkTransition;
  nearestExitAgreement: boolean | null;
  boundaryCase: boolean;
  sameExitDeltaM: number | null;
  sameExitDeltaPercent: number | null;
}

export function compareBenchmarkCase(
  benchmarkCase: BenchmarkCase,
  valhallaDistances: (number | null)[],
): BenchmarkComparison;

export function failedBenchmarkCase(
  benchmarkCase: BenchmarkCase,
  error: string,
): BenchmarkComparison;

export interface BenchmarkSummary {
  scanned: number;
  selected: number;
  eligibleBeforeLimit: number;
  duplicateRouteKeys: number;
  skipped: Record<BenchmarkSkipReason, number>;
  completed: number;
  failed: number;
  orsUsable: number;
  valhallaUsable: number;
  orsPlausible: number;
  valhallaPlausible: number;
  nearestExitAgreement: number;
  nearestExitCompared: number;
  withinWalkAgreement: number;
  withinWalkCompared: number;
  transitions: Record<WalkTransition, number>;
  boundaryCases: number;
  sameExitDeltaCount: number;
  sameExitMeanAbsoluteDeltaM: number | null;
  sameExitMeanAbsoluteDeltaPercent: number | null;
}

export function summarizeBenchmark(
  selection: CaseSelection,
  comparisons: BenchmarkComparison[],
): BenchmarkSummary;
```

- [ ] **Step 1: Write failing deterministic-selection tests**

Create small `Listing` fixtures with coordinates, IDs, and district-bearing
addresses. Use three parsed MRT exits and precomputed `cacheKey` entries.
Assert the selector:

- sorts by date, numeric listing ID with null last, then route key;
- excludes no-coordinate and known district-conflict listings;
- reports missing and wrong-length ORS arrays separately;
- deduplicates equal route keys across dates before applying `limit`;
- does not mutate listings, exits, or route cache.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test scripts/lib/route-benchmark.test.ts
```

Expected: FAIL because selection interfaces do not exist.

- [ ] **Step 3: Implement minimal deterministic selection**

For each listing call `enrichOffline(listing, exits)`, classify skip reasons in
the exact order `no-coordinate`, `coordinate-conflict`, `no-candidates`,
`ors-cache-miss`, `ors-cache-shape`, then create a `BenchmarkCase`. Sort all
eligible cases, retain the first case per `routeKey`, and slice to `limit`.

- [ ] **Step 4: Run selection tests and verify GREEN**

Expected: selection tests PASS.

- [ ] **Step 5: Write failing comparison and summary tests**

Use a fixture with three candidates and explicit ORS/Valhalla arrays to assert:

```ts
assert.equal(comparison.transition, 'true->false');
assert.equal(comparison.nearestExitAgreement, true);
assert.equal(comparison.boundaryCase, true);
assert.equal(comparison.sameExitDeltaM, 120);
assert.equal(comparison.sameExitDeltaPercent, 17.65);
```

Add cases for nearest-exit disagreement, implausible ratio becoming null,
`700` and `900` meter inclusive boundaries, provider failure, zero ORS distance
yielding null percentage, and summary means rounded to two decimals. Assert
failed requests count as `failed` but preserve the cached ORS `WalkPick`.

- [ ] **Step 6: Run comparison tests and verify RED**

Expected: comparison exports or metrics FAIL.

- [ ] **Step 7: Implement comparison and aggregate metrics**

Call `pickWalk` independently for each provider. Define agreement only when
both compared values are non-null. A boundary case is true when either selected
distance is inclusively between 700 and 900 meters. Same-exit delta is
`valhalla.distanceM - ors.distanceM`; summary means use absolute deltas and
round to two decimals.

- [ ] **Step 8: Run focused tests and commit**

Run:

```bash
node --import tsx --test scripts/lib/route-benchmark.test.ts
git add scripts/lib/route-benchmark.ts scripts/lib/route-benchmark.test.ts
git commit -m "feat: compare historical walking routes"
```

Expected: focused tests PASS and the commit succeeds.

---

### Task 3: Runner, Artifact, and CLI

**Files:**
- Create: `scripts/lib/route-benchmark-run.test.ts`
- Create: `scripts/lib/route-benchmark-run.ts`
- Create: `scripts/route-benchmark.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 `routeValhallaWalkDistances`, Task 2 selection/comparison functions, `RunRange`, `resolveRange`, `resolveProfileFromArgs`, `loadExits`, and `CACHE_PATH`.
- Produces:

```ts
export interface RouteBenchmarkOptions {
  rootDir: string;
  profileId: string;
  range: RunRange;
  limit: number;
  valhallaBaseUrl: string;
  requestDelayMs: number;
}

export interface RouteBenchmarkDeps {
  route: typeof routeValhallaWalkDistances;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  progress: (message: string) => void;
}

export interface RouteBenchmarkArtifact {
  schemaVersion: 1;
  benchmarkedAt: string;
  profileId: string;
  range: RunRange;
  inputDates: string[];
  valhallaBaseUrl: string;
  summary: BenchmarkSummary;
  comparisons: BenchmarkComparison[];
}

export function parseBenchmarkLimit(argv: string[]): number;
export function inclusiveDates(from: string, to: string): string[];
export function benchmarkArtifactPath(
  rootDir: string,
  profileId: string,
  label: string,
  now: Date,
): string;
export async function runRouteBenchmark(
  options: RouteBenchmarkOptions,
  deps?: Partial<RouteBenchmarkDeps>,
): Promise<{ artifactPath: string; artifact: RouteBenchmarkArtifact }>;
```

- [ ] **Step 1: Write failing argument, date, and path tests**

Assert:

- omitted `--limit` returns 25;
- `--limit 1`, `--limit=25`, and `--limit 200` succeed;
- zero, 201, decimals, missing values, and repeated limits reject;
- `inclusiveDates('2026-07-30', '2026-08-02')` returns four ISO dates;
- a fixed `2026-08-10T12:34:56.789Z` clock yields
  `state/route-benchmarks/example-investment/2026-08-01/valhalla-20260810T123456789Z.json`
  below the injected root directory.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test scripts/lib/route-benchmark-run.test.ts
```

Expected: FAIL because runner helpers do not exist.

- [ ] **Step 3: Implement argument, date, and path helpers**

Parse one `--limit` occurrence, require a safe integer in `[1, 200]`, enumerate
dates with UTC arithmetic, and sanitize the UTC ISO timestamp by removing
`-`, `:`, and `.` while preserving trailing `Z`.

- [ ] **Step 4: Write failing temporary-workspace integration tests**

In `fs.mkdtempSync(path.join(os.tmpdir(), 'route-benchmark-'))`, create:

```text
state/runs/test-profile/2026-08-01/listings.json
state/route-cache.json
data/taipei_mrt_exits.csv
```

Inject a route function that captures only `origin`, `dests`, and
`options.baseUrl`, returns deterministic arrays, and inject sleep/progress
spies. Assert:

- historical daily artifacts load for every inclusive date;
- calls are sequential and sleep receives `1000` between calls but not after
  the final call;
- one rejected route call becomes a failed comparison and later cases run;
- the detailed artifact uses schema 1 and contains comparisons;
- the file is written via a temporary sibling then atomically renamed, leaving
  no `.tmp` sibling;
- route cache and input listing bytes are identical before and after;
- captured request inputs contain coordinates only;
- progress text contains counts but none of the fixture's ID, address, title,
  URL, or coordinates;
- missing dates, malformed cache JSON, and output write failure reject safely.

- [ ] **Step 5: Run integration tests and verify RED**

Expected: runner tests FAIL because orchestration and persistence are absent.

- [ ] **Step 6: Implement the runner**

Load daily `FetchResult` JSON with explicit existence and shape checks. Load
the MRT CSV and ORS cache from paths rooted at `rootDir`. Select cases, then use
a plain `for` loop:

```ts
for (let i = 0; i < selection.cases.length; i++) {
  const benchmarkCase = selection.cases[i];
  try {
    const distances = await route(
      benchmarkCase.origin,
      benchmarkCase.candidates.map(({ exit }) => ({ lat: exit.lat, lng: exit.lng })),
      { baseUrl: options.valhallaBaseUrl },
    );
    comparisons.push(compareBenchmarkCase(benchmarkCase, distances));
  } catch (error) {
    comparisons.push(failedBenchmarkCase(benchmarkCase, safeError(error)));
  }
  progress(`Valhalla benchmark ${i + 1}/${selection.cases.length}`);
  if (i + 1 < selection.cases.length) await sleep(options.requestDelayMs);
}
```

Persist pretty JSON with a newline to `artifactPath + '.tmp'`, then
`fs.renameSync`. On a write or rename error, remove only that exact temporary
file with `fs.rmSync(tmpPath, { force: true })` and rethrow.

- [ ] **Step 7: Run runner and all benchmark tests**

Run:

```bash
node --import tsx --test \
  scripts/lib/valhalla-routing.test.ts \
  scripts/lib/route-benchmark.test.ts \
  scripts/lib/route-benchmark-run.test.ts
```

Expected: all benchmark tests PASS.

- [ ] **Step 8: Write the CLI and package script**

Create `scripts/route-benchmark.ts` that:

1. resolves the explicit profile with `resolveProfileFromArgs(argv)`;
2. resolves date/range with `resolveRange(argv, new Date())`;
3. parses the limit;
4. calls `runRouteBenchmark` with `rootDir: process.cwd()`,
   `VALHALLA_URL ?? DEFAULT_VALHALLA_URL`, and `requestDelayMs: 1000`;
5. writes safe progress messages to stderr;
6. writes only this JSON shape to stdout:

```ts
{
  artifact: path.relative(process.cwd(), artifactPath),
  summary: artifact.summary,
}
```

Map invalid profile/range/limit and missing input messages to exit code 2;
unexpected persistence errors use exit code 1. Add:

```json
"route-benchmark": "tsx scripts/route-benchmark.ts"
```

to `package.json` scripts.

- [ ] **Step 9: Verify CLI input failures do not use the network**

Run:

```bash
npm run route-benchmark -- --profile does-not-exist --date 2026-08-01
npm run route-benchmark -- --profile example-investment --date bad
npm run route-benchmark -- --profile example-investment --date 2026-08-01 --limit 201
```

Expected: each exits 2 with a concise `BAD INPUT:` message before any
Valhalla request.

- [ ] **Step 10: Commit the runner and CLI**

Run:

```bash
git add package.json scripts/route-benchmark.ts \
  scripts/lib/route-benchmark-run.ts scripts/lib/route-benchmark-run.test.ts
git commit -m "feat: add Valhalla route benchmark command"
```

Expected: commit succeeds.

---

### Task 4: Operator Documentation and Verification

**Files:**
- Modify: `AGENTS.md`
- Verify only: all implementation and test files from Tasks 1-3
- Generate local-only: `state/route-benchmarks/<profile>/<label>/valhalla-<timestamp>.json`

**Interfaces:**
- Consumes: the complete `npm run route-benchmark` CLI.
- Produces: documented operator contract and local aggregate benchmark evidence; no production provider change.

- [ ] **Step 1: Add the experimental tooling documentation**

Add a Tooling bullet to `AGENTS.md` stating:

- exact single-date and range command shapes;
- reads existing bare daily `listings.json` files and `state/route-cache.json`;
- sends coordinate-only sequential requests to the FOSSGIS fair-use demo;
- defaults to 25 and caps at 200;
- writes under `state/route-benchmarks/` and never affects enrich/report/notify;
- is evaluation-only and cannot justify a provider switch without a separate
  design and walking-policy revalidation.

- [ ] **Step 2: Run static and complete automated verification**

Run:

```bash
npm test
npx tsc --noEmit
git diff --check
```

Expected: all tests PASS, TypeScript reports no errors, and diff check is clean.

- [ ] **Step 3: Commit documentation**

Run:

```bash
git add AGENTS.md
git commit -m "docs: document Valhalla route benchmark"
```

Expected: commit succeeds.

- [ ] **Step 4: Run a five-case live smoke test**

Use the verified most recent existing `investment-taipei.local` daily run,
`2026-08-09`, and run:

```bash
npm run route-benchmark -- \
  --profile investment-taipei.local \
  --date 2026-08-09 \
  --limit 5
```

Expected: exit 0, five or fewer comparable cases complete, one new local JSON
artifact is written, stdout contains aggregate data only, and production
artifacts remain unchanged. If the public service fails, preserve the local
failure evidence and report the external failure without modifying code merely
to force a live pass.

- [ ] **Step 5: Run the default 25-case benchmark**

Only when the five-case smoke test returns structurally valid Valhalla
distances, rerun the same profile/date without `--limit`.

Expected: at most 25 sequential cases, an aggregate-only stdout summary, and a
new timestamped local artifact.

- [ ] **Step 6: Inspect aggregate and boundary evidence**

Report:

- completed/failed and usable/plausible counts by provider;
- nearest-exit and `withinWalk` agreement rates using their explicit compared
  denominators;
- every non-zero transition count;
- boundary-case count;
- same-exit mean absolute distance and percentage differences;
- whether the sample is sufficient for a larger 100-200 case benchmark.

Do not claim Valhalla is better solely from aggregate agreement. Flag nearest
exit disagreements, boundary flips, and one-provider-only plausibility cases
for manual map review.

- [ ] **Step 7: Final repository check**

Run:

```bash
git status --short
git log -5 --oneline
```

Expected: committed source/docs are clean; only git-ignored benchmark evidence
exists under `state/`.
