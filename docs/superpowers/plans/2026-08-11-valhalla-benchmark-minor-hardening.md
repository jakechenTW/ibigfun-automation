# Valhalla Benchmark Minor Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four deferred route-benchmark edge cases with strict retry parsing, deterministic null-ID ordering, early filesystem capability validation, and fail-closed sensitive-temp cleanup.

**Architecture:** Keep routing and comparison interfaces unchanged. Add narrow pure validation/comparison fixes, then isolate artifact filesystem guarantees behind small helpers and injected runner dependencies so unsupported filesystems and cleanup failures are testable before any network work.

**Tech Stack:** TypeScript, Node.js built-in `fs`, `node:test`, `assert`, npm scripts.

## Global Constraints

- The production ORS provider, walking threshold, enrich pipeline, route cache, profiles, reports, notifications, and schedules must not change.
- Valhalla request body, compact response parsing, default endpoint, and benchmark selection policy must not change.
- Errors must not expose paths, listing IDs, coordinates, endpoint paths, or artifact contents.
- Unsupported hard-link filesystems must fail before reading sensitive listings or invoking routing.
- A cleanup-only failure after publication must exit non-zero while preserving the authoritative final artifact.
- Every production behavior change requires a test observed failing first.

---

### Task 1: Strict retry grammar and deterministic null-ID ordering

**Files:**
- Modify: `scripts/lib/valhalla-routing.test.ts`
- Modify: `scripts/lib/valhalla-routing.ts`
- Modify: `scripts/lib/route-benchmark.test.ts`
- Modify: `scripts/lib/route-benchmark.ts`

**Interfaces:**
- Consumes: existing `routeValhallaWalkDistances(...)` and `selectBenchmarkCases(...)` APIs.
- Produces: unchanged public APIs with stricter `Retry-After` parsing and a symmetric comparator.

- [ ] **Step 1: Write the failing strict-header regression**

Extend the existing invalid-header test to table-drive values that JavaScript's
`Number()` accepts but the benchmark contract rejects:

```ts
for (const retryAfter of ['0x2', '+2', '1e1', '2.0', ' 2 ', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
  const sleeps: number[] = [];
  let attempts = 0;
  await routeValhallaWalkDistances(origin, dests, {
    sleep: async (ms) => { sleeps.push(ms); },
    fetchFn: async () => ++attempts === 1
      ? new Response('', { status: 503, headers: { 'Retry-After': retryAfter } })
      : compactMatrixResponse([[0.42]]),
  });
  assert.deepEqual(sleeps, [1000], retryAfter);
}
```

- [ ] **Step 2: Run the focused client test and verify RED**

Run: `node --import tsx --test scripts/lib/valhalla-routing.test.ts`

Expected: FAIL because values such as `0x2`, `+2`, `1e1`, and `2.0` currently produce non-fallback waits.

- [ ] **Step 3: Implement strict decimal delay-seconds parsing**

Change `retryDelayMs` to validate syntax before conversion:

```ts
const validDelaySeconds = retryAfter !== null && /^(0|[1-9][0-9]*)$/.test(retryAfter);
const seconds = validDelaySeconds ? Number(retryAfter) : Number.NaN;
const requestedMs = Number.isSafeInteger(seconds)
  ? seconds * 1000
  : MIN_VALHALLA_RETRY_DELAY_MS;
return Math.min(Math.max(requestedMs, MIN_VALHALLA_RETRY_DELAY_MS), maxDelayMs);
```

Keep the existing 1,000–10,000 ms cap logic unchanged.

- [ ] **Step 4: Run the focused client test and verify GREEN**

Run: `node --import tsx --test scripts/lib/valhalla-routing.test.ts`

Expected: all Valhalla client tests pass.

- [ ] **Step 5: Write the failing equal-null-ID ordering regression**

Add a case parallel to the numeric-ID route-key test, but give both listings
`id: null`, reverse their input order, and assert lexical route-key order:

```ts
test('selectBenchmarkCases uses route key when equal-date listing IDs are both null', () => {
  const lower = listing({ id: null, coordinate: { lat: 25.0321, lng: 121.5181 } });
  const upper = listing({ id: null, coordinate: { lat: 25.0339, lng: 121.5199 } });
  const lowerKey = routeKeyFor(lower);
  const upperKey = routeKeyFor(upper);
  const routeCache = { [lowerKey]: [600, 700, 800], [upperKey]: [610, 710, 810] };
  const selection = selectBenchmarkCases([
    { date: '2026-08-01', result: fetchResult([upper, lower]) },
  ], exits, routeCache, 25);
  assert.deepEqual(selection.cases.map(({ routeKey }) => routeKey), [lowerKey, upperKey].sort());
});
```

- [ ] **Step 6: Run the comparator test and verify RED**

Run: `node --import tsx --test scripts/lib/route-benchmark.test.ts`

Expected: FAIL because the comparator returns `1` when both IDs are null and never reaches `routeKey`.

- [ ] **Step 7: Implement a symmetric listing-ID comparator**

Add a small internal helper and use it in `eligible.sort`:

```ts
function compareListingIds(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

eligible.sort((a, b) =>
  a.date.localeCompare(b.date)
  || compareListingIds(a.listingId, b.listingId)
  || a.routeKey.localeCompare(b.routeKey));
```

- [ ] **Step 8: Run both focused suites and verify GREEN**

Run: `node --import tsx --test scripts/lib/valhalla-routing.test.ts scripts/lib/route-benchmark.test.ts`

Expected: all focused tests pass.

- [ ] **Step 9: Commit Task 1**

```bash
git add scripts/lib/valhalla-routing.ts scripts/lib/valhalla-routing.test.ts scripts/lib/route-benchmark.ts scripts/lib/route-benchmark.test.ts
git commit -m "fix: tighten Valhalla retry and ordering edges"
```

---

### Task 2: Preflight atomic publication and fail-closed cleanup

**Files:**
- Modify: `scripts/lib/route-benchmark-run.test.ts`
- Modify: `scripts/lib/route-benchmark-run.ts`

**Interfaces:**
- Consumes: existing `runRouteBenchmark(options, deps)` and hard-link `publishNoClobber` behavior.
- Produces: internal/exported `preflightHardLinkPublication(directory)` plus injectable `preflight` and `removeTemporary` dependencies used only to verify failure ordering and cleanup behavior.

- [ ] **Step 1: Write the failing preflight regressions**

Add three focused tests:

1. `preflightHardLinkPublication` succeeds in a real temporary directory and leaves no probe files.
2. A simulated hard-link rejection produces the fixed message
   `route benchmark artifact filesystem does not support atomic no-clobber publication` and removes its probe source/target.
3. Injected runner preflight failure happens before the route dependency is called and before listings/cache are read.

Use an injectable operation object only on the helper boundary:

```ts
interface ArtifactPreflightFs {
  writeExclusive(file: string): void;
  link(source: string, target: string): void;
  remove(file: string): void;
}
```

The production default delegates to `fs.writeFileSync(..., { flag: 'wx', mode:
0o600 })`, `fs.linkSync`, and `fs.rmSync`. The helper accepts it as an optional
second argument so failure tests do not patch Node globals.

```ts
await assert.rejects(
  runRouteBenchmark(options(workspace.rootDir), {
    preflight: () => { throw new Error(ARTIFACT_PREFLIGHT_ERROR); },
    route: async () => { routeCalls += 1; return []; },
  }),
  new RegExp(ARTIFACT_PREFLIGHT_ERROR),
);
assert.equal(routeCalls, 0);
```

Delete or rename the listing input before the call so the assertion also proves
preflight precedes sensitive-input reads.

- [ ] **Step 2: Run the runner suite and verify RED**

Run: `node --import tsx --test scripts/lib/route-benchmark-run.test.ts`

Expected: FAIL because no preflight helper/dependency exists and routing input validation currently happens first.

- [ ] **Step 3: Implement capability preflight**

Add fixed safe constants and a helper that uses unique exclusive probe names in
the final artifact directory:

```ts
export const ARTIFACT_PREFLIGHT_ERROR =
  'route benchmark artifact filesystem does not support atomic no-clobber publication';
export const ARTIFACT_CLEANUP_ERROR =
  'route benchmark published artifact but could not remove sensitive temporary data';

export function preflightHardLinkPublication(
  directory: string,
  operations: ArtifactPreflightFs = defaultArtifactPreflightFs,
): void {
  fs.mkdirSync(directory, { recursive: true });
  const probeSource = uniqueProbePath(directory, 'source');
  const probeTarget = uniqueProbePath(directory, 'target');
  let failure: unknown = null;
  try {
    operations.writeExclusive(probeSource);
    operations.link(probeSource, probeTarget);
  } catch {
    failure = new Error(ARTIFACT_PREFLIGHT_ERROR);
  } finally {
    try { operations.remove(probeTarget); } catch { failure = new Error(ARTIFACT_PREFLIGHT_ERROR); }
    try { operations.remove(probeSource); } catch { failure = new Error(ARTIFACT_PREFLIGHT_ERROR); }
  }
  if (failure) throw failure;
}
```

Generate probe paths with the existing process-local sequence; never include
profile IDs or timestamps. Extend `RouteBenchmarkDeps` with:

```ts
preflight: (directory: string) => void;
removeTemporary: (tmpPath: string) => void;
```

In `runRouteBenchmark`, compute the artifact directory from root/profile/range,
create it, and call `preflight` immediately after safe option validation and
before `readFetchResult`, `loadExits`, `readRouteCache`, or `route`.

- [ ] **Step 4: Run the runner suite and verify the preflight tests GREEN**

Run: `node --import tsx --test scripts/lib/route-benchmark-run.test.ts`

Expected: preflight tests pass; existing runner tests remain green.

- [ ] **Step 5: Write failing cleanup regressions**

Add one cleanup-only test and strengthen the publication-failure test:

```ts
await assert.rejects(
  runRouteBenchmark(options(workspace.rootDir), {
    route: async () => [650, 750, 850],
    sleep: async () => {},
    removeTemporary: () => { throw new Error('synthetic cleanup secret'); },
  }),
  (error: Error) => error.message === ARTIFACT_CLEANUP_ERROR,
);
assert.equal(fs.existsSync(expectedFinalArtifact), true);
```

Capture stdout-equivalent progress/error text and assert it contains neither
the injected secret nor paths. For publication failure, inject both a throwing
`publish` and throwing `removeTemporary`; assert the publication error remains
the thrown error and cleanup was attempted exactly once.

- [ ] **Step 6: Run the runner suite and verify RED**

Run: `node --import tsx --test scripts/lib/route-benchmark-run.test.ts`

Expected: cleanup-only test FAILS because the current `finally` suppresses the deletion error; the dual-failure test lacks an injectable cleanup dependency.

- [ ] **Step 7: Implement success-sensitive cleanup semantics**

Track publication and cleanup errors separately:

```ts
let publishedPath: string | undefined;
let publicationError: unknown;
try {
  publishedPath = publish(tmpPath, desiredArtifactPath);
} catch (error) {
  publicationError = error;
}

let cleanupError: unknown;
try {
  removeTemporary(tmpPath);
} catch (error) {
  cleanupError = error;
}

if (publicationError !== undefined) throw publicationError;
if (cleanupError !== undefined) throw new Error(ARTIFACT_CLEANUP_ERROR);
return { artifactPath: publishedPath!, artifact };
```

The default remover calls `fs.rmSync(tmpPath)` without `force`; disappearance or
permission failure is therefore observable. Do not delete the already published
artifact when cleanup fails.

- [ ] **Step 8: Run the runner suite and verify GREEN**

Run: `node --import tsx --test scripts/lib/route-benchmark-run.test.ts`

Expected: all runner tests pass, including preflight ordering, cleanup-only failure, and publication-error precedence.

- [ ] **Step 9: Commit Task 2**

```bash
git add scripts/lib/route-benchmark-run.ts scripts/lib/route-benchmark-run.test.ts
git commit -m "fix: harden benchmark artifact publication"
```

---

### Task 3: Operator documentation and final verification

**Files:**
- Modify: `AGENTS.md`
- Verify: all files changed by Tasks 1–2

**Interfaces:**
- Consumes: final retry, ordering, preflight, publication, and cleanup behavior.
- Produces: operator-visible documentation and a fully verified branch.

- [ ] **Step 1: Update operator documentation**

In the `route-benchmark` tooling bullet, add two exact operational guarantees:

- the artifact directory is preflighted for atomic hard-link publication before
  sensitive input reads or routing; unsupported filesystems fail early; and
- failure to remove a detailed temporary artifact after publication makes the
  command fail and requires local cleanup.

Keep the existing warning that detailed artifacts are local, privacy-sensitive,
git-ignored state.

- [ ] **Step 2: Run focused benchmark tests**

Run:

```bash
node --import tsx --test \
  scripts/lib/valhalla-routing.test.ts \
  scripts/lib/route-benchmark.test.ts \
  scripts/lib/route-benchmark-run.test.ts
```

Expected: all focused tests pass with zero failures.

- [ ] **Step 3: Run complete verification**

Run:

```bash
npm test
npx tsc --noEmit
git diff --check
```

Expected: 604 or more tests pass, TypeScript exits 0, and `git diff --check` exits 0.

- [ ] **Step 4: Inspect scope and privacy**

Run:

```bash
git status --short
git diff --stat HEAD~2..HEAD
git diff HEAD~2..HEAD -- scripts/lib/valhalla-routing.ts scripts/lib/route-benchmark.ts scripts/lib/route-benchmark-run.ts AGENTS.md
```

Confirm there are no changes to enrich, ORS routing, route cache, profiles,
pipeline, notifications, or local `state/` artifacts.

- [ ] **Step 5: Commit documentation**

```bash
git add AGENTS.md
git commit -m "docs: document benchmark publication preflight"
```
