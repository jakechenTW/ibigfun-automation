# Read-Only Market Data Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make daily property enrichment consume the active validated Taipei market-data build without refreshing or backtesting it, while moving refresh operations into one explicit daily job.

**Architecture:** Keep `ensureTaipeiMarketData` as the explicit writer used only by `market-data update`. Change `enrichStep` to call the existing read-only `loadMarketData(MARKET_DATA_ROOT)`. Test the real production path from an isolated temporary working directory so any attempted source request is observed without mocking the code under test. Preserve all existing checksum, acceptance, freshness, and fail-closed valuation logic, then document the writer-before-readers schedule and component-aware failure classification.

**Tech Stack:** TypeScript, Node.js test runner, tsx, filesystem-backed pipeline state, Markdown operator documentation.

## Global Constraints

- Do not weaken Policy-7 gates, freshness thresholds, acceptance binding, checksum closure, or atomic publication recovery.
- Property `enrich` must perform no official-source fetch, staging build, complete backtest, refresh-lock acquisition, or publication.
- Explicit `npm run market-data -- update --city taipei` remains the sole scheduled market-data writer.
- Missing, invalid, stale, or unaccepted evidence must never create an automatic recommendation.
- ORS failures remain partial failures routed to manual review; a pre-`market-data.ready` stall must not be labeled as ORS.
- Add no runtime dependency and change no persisted state schema.

---

## File Structure

- Create `scripts/lib/steps.test.ts`: focused integration test for the real `enrichStep` market-data boundary and zero-listing behavior.
- Modify `scripts/lib/steps.ts`: replace the market-data writer with the existing read-only loader.
- Modify `AGENTS.md`: separate the daily market-data writer lifecycle from property runs and correct the enrich tooling description.
- Modify `docs/market-data.md`: document read-only enrichment and the once-daily writer schedule.
- Modify `prompts/daily-run.md`: prohibit refresh recovery inside a property worker and define journal-based stall classification.
- Modify `prompts/schedule-triggers.md`: provide the writer-before-readers schedule and command.

### Task 1: Make enrichment a read-only market-data consumer

**Files:**
- Create: `scripts/lib/steps.test.ts`
- Modify: `scripts/lib/steps.ts:1-40,406-430`

**Interfaces:**
- Preserves: `enrichStep(ctx, logger)` and all existing callers.
- Consumes: existing `loadMarketData(root)` and `MARKET_DATA_ROOT`.

- [ ] **Step 1: Write the failing empty-run boundary test**

Create `scripts/lib/steps.test.ts` with a real `listings.json` inside an isolated temporary working directory. Replace the process-level fetch function with a counter so the test observes any official-source request made by the real production path:

```ts
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Logger } from './journal.ts';
import { enrichStep } from './steps.ts';
import { enrichedPath, listingsPath, runDir } from './runpaths.ts';

test('enrich performs no market refresh or ORS work for an empty listing run', async (t) => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const isolatedCwd = fs.mkdtempSync(path.join(tmpdir(), 'enrich-read-only-'));
  fs.mkdirSync(path.join(isolatedCwd, 'data'), { recursive: true });
  fs.copyFileSync(
    path.join(originalCwd, 'data/taipei_mrt_exits.csv'),
    path.join(isolatedCwd, 'data/taipei_mrt_exits.csv'),
  );
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('market refresh must not fetch');
  }) as typeof fetch;
  process.chdir(isolatedCwd);
  t.after(() => {
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    fs.rmSync(isolatedCwd, { recursive: true, force: true });
  });

  const profile = { id: 'test-read-only-enrich', displayName: 'test', fetch: {} };
  const range = { from: '0003-03-05', to: '0003-03-05', label: '0003-03-05' };
  const dir = runDir(profile.id, range.label);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(listingsPath(profile.id, range.label), JSON.stringify({
    from: range.from,
    to: range.to,
    fetchedAt: '0003-03-06T00:00:00.000Z',
    count: 0,
    listings: [],
  }));
  const events: string[] = [];
  const logger: Logger = { event: (_level, event) => events.push(event) };

  const output = await enrichStep({ profile, range }, logger);

  assert.equal(fetchCalls, 0);
  assert.ok(events.includes('market-data.unavailable'));
  assert.deepEqual(output.summary, {
    withinWalk: 0,
    manualReview: 0,
    hardExcluded: 0,
    marketReliable: 0,
    marketReview: 0,
    marketUnavailable: 0,
    marketDataStale: 0,
    orsCalls: 0,
    cacheHits: 0,
    routeErrors: 0,
  });
  const result = JSON.parse(fs.readFileSync(enrichedPath(profile.id, range.label), 'utf8'));
  assert.equal(result.count, 0);
  assert.deepEqual(result.listings, []);
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
node --import tsx --test scripts/lib/steps.test.ts
```

Expected: FAIL because `fetchCalls` is greater than zero; the current `ensureTaipeiMarketData` path attempts an official-source refresh even though the listing input is empty.

- [ ] **Step 3: Replace the writer with the read-only production loader**

In `scripts/lib/steps.ts`, replace the update import and add the production root:

```ts
import {
  loadMarketData,
  marketDataBacktestAcceptanceDecision,
  marketDataFreshness,
  type MarketAcceptanceDecision,
  type MarketAcceptanceDiagnostics,
} from './market-data/store.ts';
import { MARKET_DATA_ROOT } from './market-data/config.ts';
```

Remove:

```ts
import { ensureTaipeiMarketData } from './market-data/update.ts';
```

Replace the write-path call:

```ts
const marketBundle = await loadMarketData(MARKET_DATA_ROOT);
```

Do not alter the `enrichStep` signature, cache behavior, ORS calls, delay behavior, freshness logging, valuation attachment, or output fields.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
node --import tsx --test scripts/lib/steps.test.ts
```

Expected: one passing test, with zero network fetches, an empty `enriched.json`, and `orsCalls: 0`.

- [ ] **Step 5: Run focused regression tests and type checking**

Run:

```bash
node --import tsx --test scripts/lib/steps.test.ts scripts/lib/market-data/store.test.ts scripts/lib/market-data/update.test.ts
npx tsc --noEmit
```

Expected: all focused tests pass and TypeScript reports no errors. Existing store tests continue proving that malformed builds return `null`, mismatched acceptance is not attached, and explicit updates preserve last-known-good state.

- [ ] **Step 6: Commit the read-only enrichment change**

```bash
git add scripts/lib/steps.ts scripts/lib/steps.test.ts
git commit -m "fix: make daily enrichment read market data only"
```

### Task 2: Separate the scheduled writer lifecycle and correct failure classification

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/market-data.md`
- Modify: `prompts/daily-run.md`
- Modify: `prompts/schedule-triggers.md`

**Interfaces:**
- Consumes: `npm run market-data -- update --city taipei` as the sole scheduled writer.
- Produces: an operational sequence of one writer followed by the two existing sequential property readers.

- [ ] **Step 1: Update the repository run contract**

In `AGENTS.md`:

- Add a market-data prerequisite immediately before the property Daily Run Sequence: run `npm run market-data -- update --city taipei` once per Taipei day in its own job, before profile monitoring.
- State that a failed refresh retains last-known-good and must not cause either profile worker to invoke an inline refresh.
- Change the enrich tooling description from refreshing official data to loading the active validated build read-only.
- Keep the current stale-data warning and automatic-recommendation prohibitions unchanged.

Use this normative wording:

```markdown
The scheduled market-data writer is independent from profile runs. Run
`npm run market-data -- update --city taipei` once per Taipei calendar day and
wait for it to finish before starting profile pipelines. Profile `enrich` is a
read-only consumer: it never refreshes, rebuilds, backtests, or publishes market
data. A failed writer retains last-known-good; profile runs may use only the
validated active pair and remain subject to freshness warnings and fail-closed
recommendation rules.
```

- [ ] **Step 2: Update the market-data operator guide**

In `docs/market-data.md`, add a “Scheduled writer and read-only consumers” section next to the update workflow. Document:

```markdown
1. Run `npm run market-data -- update --city taipei` once.
2. Wait for the command to publish or retain last-known-good.
3. Run the investment and owner-occupied pipelines sequentially.
```

Explicitly state that `npm run enrich` calls `loadMarketData` only and does not acquire the refresh lock or recover/publish staging state.

- [ ] **Step 3: Make the headless property prompt component-aware**

In `prompts/daily-run.md`, add these rules under the failure policy:

```markdown
- Property workers never run `market-data update` as recovery; that belongs to
  the independent writer job.
- Classify a stall from the last completed journal boundary. Before
  `market-data.ready`, call it market-data loading/validation. ORS begins only
  after readiness; label a stall ORS only when `market-data.ready` has been
  logged and routing activity is the current boundary.
```

Do not change the existing rule that ORS-wide failure is partial and becomes manual review rather than `fail`.

- [ ] **Step 4: Add the writer-before-readers schedule template**

In `prompts/schedule-triggers.md`, add a separate market-data job before the existing profile schedule:

```bash
npm run market-data -- update --city taipei
```

State that the first property trigger starts only after this command finishes. Preserve the existing requirement that the two property profiles remain sequential or at least 30 minutes apart because they share one iBigFun login.

- [ ] **Step 5: Verify documentation consistency**

Run:

```bash
rg -n "ensureTaipeiMarketData|market-data update|read-only|market-data.ready|ORS" AGENTS.md docs/market-data.md prompts/daily-run.md prompts/schedule-triggers.md scripts/lib/steps.ts
git diff --check
```

Expected: documentation names one explicit writer, property enrichment is consistently read-only, the readiness boundary is explicit, and whitespace validation passes.

- [ ] **Step 6: Commit the operational documentation**

```bash
git add AGENTS.md docs/market-data.md prompts/daily-run.md prompts/schedule-triggers.md
git commit -m "docs: schedule market refresh before property runs"
```

### Task 3: Verify the complete behavior

**Files:**
- Verify only; modify Task 1 or Task 2 files only if their tests expose a defect.

**Interfaces:**
- Consumes: the read-only `enrichStep` implementation and updated operational contract.
- Produces: evidence that the full repository remains correct.

- [ ] **Step 1: Prove the enrich production path has no writer dependency**

Run:

```bash
rg -n "ensureTaipeiMarketData|evaluateTaipeiMarketDataCandidate|publishStagedBuild|withMarketDataLock" scripts/lib/steps.ts scripts/enrich.ts
```

Expected: no matches.

- [ ] **Step 2: Run the complete automated test suite**

Run:

```bash
npm test
```

Expected: every Node test passes with no failures.

- [ ] **Step 3: Run final type and diff validation**

Run:

```bash
npx tsc --noEmit
git diff --check
git status --short
```

Expected: TypeScript and whitespace checks pass. Git status contains no unintended or untracked implementation artifacts.

- [ ] **Step 4: Record the verified result**

If verification required no fix, do not create an empty commit. Record the focused test count, full test count, and type-check result in the task handoff. If a defect was found, return to the failing-test-first cycle in the task that owns it, make the minimal fix, rerun Task 3, and commit only that scoped correction.
