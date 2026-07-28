# Taipei Market-Data Quality and Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair Taipei doorplate matching, classify official transactions by production eligibility, require accurate reliable-cohort estimates with at least 70% eligible coverage, and publish only candidate builds whose matching acceptance passes.

**Architecture:** A shared base-doorplate key makes official doorplates and transaction addresses resolve identically. Transaction normalization assigns reliable, review-only, or excluded eligibility before selection. Candidate indexes are backtested in staging, and a passing build plus its checksum-bound acceptance are promoted together; failures retain the last-known-good active pair.

**Tech Stack:** TypeScript, Node.js 26, `node:test`, `tsx`, `csv-parse`, local JSON indexes, Ministry of the Interior real-price CSVs, Taipei doorplate CSV.

## Global Constraints

- Treat the existing uncommitted doorplate/source/update work as an in-scope
  prerequisite: review it, preserve it, and include each hunk only in the task
  that owns the affected file. Never reset or discard it.
- Do not lower reliable-cohort median APE 12% or P75 APE 20%.
- Eligible held-out estimate coverage must be at least 70%.
- `住家用` single-building general-market transactions may support reliable estimates.
- `住商用` and multi-building transactions are review-only and never satisfy reliable comparable counts.
- Commercial, industrial, office, blank-use, and government-sale transactions are excluded.
- District, normalized building type, ownership, and first-floor isolation remain hard gates.
- Stages 6 and 7 are diagnostic fallbacks and become active only after sequential backtest evidence.
- Every eligibility, selector, confidence, status, or backtest-semantic change bumps `ESTIMATOR_POLICY_VERSION`.
- Generated state, raw addresses, transaction rows, and backtest cases remain git-ignored.
- Use TDD for every production change: verify the focused test fails for the intended reason before implementation.
- Each task commit must stage only files intentionally changed for that task; inspect `git diff --cached` before committing.

---

## File Structure

- `scripts/lib/market-data/address.ts`
  - Parse supported Taiwan address forms and produce a shared base-doorplate key.
- `scripts/lib/market-data/doorplates.ts`
  - Build and query doorplate indexes through the shared key.
- `scripts/lib/market-data/types.ts`
  - Own transaction eligibility, candidate diagnostics, cohort metrics, and acceptance contracts.
- `scripts/lib/market-data/transactions.ts`
  - Validate official rows and classify them as reliable-eligible, review-only, or excluded.
- `scripts/lib/market-data/selector.ts`
  - Select only reliable-eligible comparables and retain review-only evidence separately.
- `scripts/lib/market-data/estimator.ts`
  - Produce review rather than unavailable when only review-only evidence exists.
- `scripts/lib/market-data/backtest.ts`
  - Report reliable/review cohorts and enforce reliable accuracy plus eligible coverage.
- `scripts/lib/market-data/config.ts`
  - Own the active policy version, coverage threshold, and baseline/experimental search policies.
- `scripts/lib/market-data/store.ts`
  - Validate new schemas and publish a build with its matching acceptance transactionally.
- `scripts/lib/market-data/update.ts`
  - Build candidate indexes, collect aggregate diagnostics, run candidate acceptance, and retain last-known-good on failure.
- `scripts/market-data.ts`
  - Expose aggregate cohort output and diagnostic policy selection.
- `docs/market-data.md`, `docs/reporting-rules.md`, `AGENTS.md`
  - Document eligibility, candidate publication, coverage, and acceptance semantics.

---

### Task 1: Shared Base-Doorplate Key

**Files:**
- Modify: `scripts/lib/market-data/address.ts`
- Modify: `scripts/lib/market-data/doorplates.ts`
- Modify: `scripts/lib/market-data/doorplates.test.ts`
- Test: `scripts/lib/market-data/doorplates.test.ts`

**Interfaces:**
- Produces: `baseDoorplateKey(address: NormalizedAddress): string | null`
- Consumes: `normalizeTaiwanAddress(input: string): NormalizedAddress`
- Later tasks rely on exact lookup ignoring validated floor/unit suffixes while preserving `NormalizedAddress.canonical` for evidence.

- [ ] **Step 1: Add failing address lookup tests**

Add fixtures that prove all three inputs resolve to the same indexed base point:

```ts
for (const input of [
  '臺北市文山區萬盛街８９號之６七樓',
  '臺北市文山區萬盛街８９之６號七樓',
  '台北市文山區萬盛街89號之6',
]) {
  const result = locateAddress(index, input);
  assert.equal(result.method, 'exact-doorplate');
  assert.equal(result.matchedAddress, '台北市文山區萬盛街89號之6');
}
```

Also assert that a missing district, ambiguous door number, or different lane
remains unresolved.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test scripts/lib/market-data/doorplates.test.ts
```

Expected: the floor-suffix and `89之6號` cases fail because lookup still uses
the full canonical input or cannot parse the sub-number order.

- [ ] **Step 3: Implement the shared key**

In `address.ts`, parse either sub-number ordering and export:

```ts
export function baseDoorplateKey(address: NormalizedAddress): string | null {
  if (!address.city || !address.district || !address.road || address.number === null) return null;
  return `${address.city}${address.district}${address.road}` +
    `${address.section === null ? '' : `${address.section}段`}` +
    `${address.lane === null ? '' : `${address.lane}巷`}` +
    `${address.alley === null ? '' : `${address.alley}弄`}` +
    `${address.number}號` +
    `${address.subNumber === null ? '' : `之${address.subNumber}`}`;
}
```

Use a number parser equivalent to:

```ts
const numberMatch = numberRange
  ? null
  : /^(\d+)(?:號(?:之(\d+))?|之(\d+)號)/.exec(remainder);
const subNumber = parsePositiveNumber(numberMatch?.[2] ?? numberMatch?.[3]);
```

Replace the duplicate base-key construction in `mapDoorplateRow`, and make
`locateAddress` use `baseDoorplateKey(address)` for exact lookup. Preserve
`address.canonical` as `normalizedAddress`.

- [ ] **Step 4: Run focused and address-adjacent tests**

Run:

```bash
node --import tsx --test \
  scripts/lib/market-data/doorplates.test.ts \
  scripts/lib/market-data/integration.test.ts
```

Expected: PASS with exact, masked-range, reverse-lookup, and conflict tests
unchanged.

- [ ] **Step 5: Commit the address fix**

```bash
git add scripts/lib/market-data/address.ts \
  scripts/lib/market-data/doorplates.ts \
  scripts/lib/market-data/doorplates.test.ts
git diff --cached
git commit -m "fix(market): share base doorplate lookup keys"
```

---

### Task 2: Transaction Eligibility Classification

**Files:**
- Modify: `scripts/lib/market-data/types.ts`
- Modify: `scripts/lib/market-data/transactions.ts`
- Modify: `scripts/lib/market-data/transactions.test.ts`
- Modify: `scripts/lib/market-data/fixtures/transactions.csv`
- Test: `scripts/lib/market-data/transactions.test.ts`

**Interfaces:**
- Produces:

```ts
export type TransactionEligibility = 'reliable-eligible' | 'review-only';

export interface TransactionEligibilityEvidence {
  eligibility: TransactionEligibility;
  reasons: string[];
  primaryUse: 'residential' | 'mixed-residential';
  transferredBuildingCount: number;
}

export function classifyTransactionEligibility(
  primaryUseRaw: string,
  transactionCountsRaw: string,
  notes: string,
): TransactionEligibilityEvidence | { excludedReasons: string[] };
```

- Extends `MarketTransaction` with `eligibility`, `eligibilityReasons`,
  `primaryUse`, and `transferredBuildingCount`.
- `normalizeSaleTransaction` continues returning `excluded` for excluded rows
  and returns `included` for reliable-eligible and review-only rows.

- [ ] **Step 1: Write failing classification tests**

Add literal official-row cases:

```ts
assert.equal(normalize(row({ 主要用途: '住家用', 交易筆棟數: '土地1建物1車位0' })).transaction.eligibility, 'reliable-eligible');
assert.equal(normalize(row({ 主要用途: '住商用', 交易筆棟數: '土地1建物1車位0' })).transaction.eligibility, 'review-only');
assert.equal(normalize(row({ 主要用途: '住家用', 交易筆棟數: '土地1建物2車位0' })).transaction.eligibility, 'review-only');
assert.deepEqual(normalizeSaleTransaction(row({ 主要用途: '商業用' }), context), {
  kind: 'excluded',
  id: 'fixture-id',
  reasons: ['non-residential-primary-use'],
});
```

Cover `工業用`, `辦公用`, blank use, and `政府機關標讓售`. Assert that
`主要用途` and `交易筆棟數` are required headers.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test scripts/lib/market-data/transactions.test.ts
```

Expected: FAIL because the new headers, types, and eligibility fields do not
exist.

- [ ] **Step 3: Implement parsing and classification**

Add header aliases:

```ts
primaryUse: ['主要用途'],
transactionCounts: ['交易筆棟數'],
elevator: ['電梯'],
```

Parse building count with a strict expression:

```ts
function transferredBuildingCount(raw: string): number | null {
  const match = /(?:^|土地\d+)建物(\d+)車位\d+$/.exec(raw.normalize('NFKC').replace(/\s+/g, ''));
  return match ? Number(match[1]) : null;
}
```

Classification rules:

```ts
if (/政府機關.*(?:標讓售|讓售)/u.test(notes)) return { excludedReasons: ['government-sale'] };
if (primaryUseRaw === '住家用' && count === 1) return reliableEligible;
if (primaryUseRaw === '住家用' && count > 1) return reviewOnly('multiple-buildings');
if (primaryUseRaw === '住商用') return reviewOnly(count > 1 ? ['mixed-residential-use', 'multiple-buildings'] : ['mixed-residential-use']);
if (!primaryUseRaw) return { excludedReasons: ['primary-use-unavailable'] };
return { excludedReasons: ['non-residential-primary-use'] };
```

Run this after existing explicit special-transaction checks and before price
normalization. Keep government sale explicit in `specialTransactionFlags` or
the eligibility classifier, but emit exactly `government-sale`.

- [ ] **Step 4: Update fixtures and run transaction tests**

Add complete `主要用途`, `交易筆棟數`, and `電梯` columns to fixture CSV rows.
Run:

```bash
node --import tsx --test \
  scripts/lib/market-data/transactions.test.ts \
  scripts/lib/market-data/integration.test.ts \
  scripts/lib/market-data/update.test.ts
```

Expected: PASS with existing parking, ownership, unit-price, and schema-drift
checks preserved.

- [ ] **Step 5: Commit eligibility classification**

```bash
git add scripts/lib/market-data/types.ts \
  scripts/lib/market-data/transactions.ts \
  scripts/lib/market-data/transactions.test.ts \
  scripts/lib/market-data/fixtures/transactions.csv
git diff --cached
git commit -m "feat(market): classify transaction eligibility"
```

---

### Task 3: Reliable Selection and Review-Only Evidence

**Files:**
- Modify: `scripts/lib/market-data/config.ts`
- Modify: `scripts/lib/market-data/types.ts`
- Modify: `scripts/lib/market-data/selector.ts`
- Modify: `scripts/lib/market-data/estimator.ts`
- Modify: `scripts/lib/market-data/selector.test.ts`
- Modify: `scripts/lib/market-data/estimator.test.ts`
- Modify: `scripts/lib/market-data/integration.test.ts`
- Test: focused selector, estimator, and integration tests

**Interfaces:**
- Extend `SelectionResult` with:

```ts
reviewOnly: ComparableEvidence[];
```

- Add a hard reason `review-only-evidence`.
- Parameterize selection without changing the active policy:

```ts
export interface SearchStage {
  radiusM: number;
  months: number;
  areaTolerance: number;
  allowAdjacentFloor: boolean;
}

export interface EstimatorPolicy {
  id: 'baseline' | '48-month' | '1000-meter';
  stages: readonly SearchStage[];
}

export const BASELINE_ESTIMATOR_POLICY: EstimatorPolicy;
export const EXPERIMENTAL_48_MONTH_POLICY: EstimatorPolicy;
export const EXPERIMENTAL_1000_METER_POLICY: EstimatorPolicy;
export const ACTIVE_ESTIMATOR_POLICY = BASELINE_ESTIMATOR_POLICY;
```

- `estimateMarket` receives `policy?: EstimatorPolicy` through
  `EstimateMarketOptions`.

- [ ] **Step 1: Write failing selector tests**

Create one reliable-eligible and one review-only transaction with otherwise
identical evidence:

```ts
const result = selectComparables(subject, [
  transaction('reliable', { eligibility: 'reliable-eligible' }),
  transaction('mixed', { eligibility: 'review-only' }),
], AS_OF);

assert.deepEqual(result.included.map((item) => item.transaction.id), ['reliable']);
assert.deepEqual(result.reviewOnly.map((item) => item.transaction.id), ['mixed']);
assert.ok(result.reviewOnly[0]?.reasons.includes('review-only-evidence'));
```

Add estimator tests asserting that three review-only transactions cannot
produce `reliable`, and review-only evidence with zero reliable comparables
produces `status: 'review'`, null price fields, and
`unavailableReasons: ['review-only-comparables']`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --import tsx --test \
  scripts/lib/market-data/selector.test.ts \
  scripts/lib/market-data/estimator.test.ts \
  scripts/lib/market-data/integration.test.ts
```

Expected: FAIL because eligibility is ignored and `reviewOnly` is absent.

- [ ] **Step 3: Implement policy objects and eligibility gating**

Move the five existing stage literals into `BASELINE_ESTIMATOR_POLICY`. Define
experimental policies by appending exactly:

```ts
{ radiusM: 800, months: 48, areaTolerance: 0.30, allowAdjacentFloor: true }
```

and then:

```ts
{ radiusM: 1_000, months: 48, areaTolerance: 0.30, allowAdjacentFloor: true }
```

In selector hard reasons:

```ts
if (transaction.eligibility !== 'reliable-eligible') reasons.push('review-only-evidence');
```

Classify a review-only candidate only when removing
`review-only-evidence` leaves no other final-stage reason. It remains in
`excludedCandidates` and is also returned in `SelectionResult.reviewOnly`.

In `estimateMarket`, before returning unavailable for zero comparables:

```ts
if (comparables.length === 0 && selection.reviewOnly.length > 0 && hardReasons.length === 0) {
  return reviewEstimate('review-only-comparables', selection);
}
```

Do not compute median/P25/P75 from review-only evidence.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --import tsx --test \
  scripts/lib/market-data/selector.test.ts \
  scripts/lib/market-data/estimator.test.ts \
  scripts/lib/market-data/integration.test.ts
```

Expected: PASS; first-floor, type, district, time, and range uncertainty tests
remain green.

- [ ] **Step 5: Commit reliable selection**

```bash
git add scripts/lib/market-data/config.ts \
  scripts/lib/market-data/types.ts \
  scripts/lib/market-data/selector.ts \
  scripts/lib/market-data/estimator.ts \
  scripts/lib/market-data/selector.test.ts \
  scripts/lib/market-data/estimator.test.ts \
  scripts/lib/market-data/integration.test.ts
git diff --cached
git commit -m "feat(market): isolate reliable comparable evidence"
```

---

### Task 4: Cohort-Aware Backtest and Acceptance

**Files:**
- Modify: `scripts/lib/market-data/config.ts`
- Modify: `scripts/lib/market-data/types.ts`
- Modify: `scripts/lib/market-data/backtest.ts`
- Modify: `scripts/lib/market-data/backtest.test.ts`
- Modify: `scripts/lib/market-data/store.ts`
- Modify: `scripts/lib/market-data/store.test.ts`
- Modify: `scripts/market-data.ts`
- Create: `scripts/lib/market-data/cli.test.ts`
- Test: backtest, store, and CLI tests

**Interfaces:**
- Set `MARKET_SCHEMA_VERSION = 2` because the transaction index and manifest
  contracts change.
- Set `ESTIMATOR_POLICY_VERSION = 2`.
- Add `minimumEstimateCoverage: 0.70` to acceptance thresholds.
- Extend `BacktestReport`:

```ts
byStatus: Record<'reliable' | 'review' | 'unavailable', BacktestMetrics>;
policyId: EstimatorPolicy['id'];
```

- Change acceptance to schema version 2:

```ts
export interface BacktestAcceptance {
  schemaVersion: 2;
  estimatorPolicyVersion: number;
  policyId: EstimatorPolicy['id'];
  transactionArtifactSha256: string;
  approvedAt: string;
  asOf: string;
  evaluatedThrough: string;
  latestEligibleTransactionDate: string;
  thresholds: {
    medianApeMax: number;
    p75ApeMax: number;
    minimumEstimateCoverage: number;
    minimumConfidenceSliceCases: number;
    minimumHighConfidenceImprovement: number;
  };
  metrics: {
    estimateCoverage: number;
    reliableEstimatedCount: number;
    reliableMedianApe: number;
    reliableP75Ape: number;
    highConfidenceEstimatedCount: number;
    highConfidenceMedianApe: number;
    mediumConfidenceEstimatedCount: number;
    mediumConfidenceMedianApe: number;
  };
}
```

- Extend CLI parsing with an explicit policy selector:

```ts
type PolicyId = EstimatorPolicy['id'];

export function estimatorPolicyById(id: PolicyId): EstimatorPolicy;
```

`backtest --policy <baseline|48-month|1000-meter>` evaluates the selected
policy without changing the active policy. Supplying `--policy` to `update` is
rejected; Task 5 adds it to the diagnostic-only `candidate` command.

- [ ] **Step 1: Write failing gate tests**

Add tests proving:

```ts
assert.ok(evaluateBacktestGate(report({ overallCoverage: 0.69 })).reasons.includes('estimate-coverage-target-missed'));
assert.ok(evaluateBacktestGate(report({ reliableMedianApe: 0.121 })).reasons.includes('median-ape-target-missed'));
assert.deepEqual(evaluateBacktestGate(report({
  overallCoverage: 0.70,
  reliableMedianApe: 0.12,
  reliableP75Ape: 0.20,
})), { passed: true, complete: true, reasons: [] });
```

Add a report where review P75 is 0.80 but reliable metrics pass; acceptance must
pass. Add serialization tests rejecting schema-1 or wrong-policy acceptance.
Add CLI parser tests accepting all three backtest policy IDs and rejecting an
unknown ID, a duplicate flag, or `update --policy`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --import tsx --test \
  scripts/lib/market-data/backtest.test.ts \
  scripts/lib/market-data/store.test.ts \
  scripts/lib/market-data/cli.test.ts
```

Expected: FAIL because the gate still uses `overall` accuracy and has no
coverage threshold or schema-2 fields.

- [ ] **Step 3: Implement cohort reporting**

`backtestTransactions` accepts:

```ts
export interface BacktestOptions {
  asOf: string;
  policy?: EstimatorPolicy;
}
```

Pass the policy to `estimateMarket`. Held-out eligibility requires
`transaction.eligibility === 'reliable-eligible'`. Compute `byStatus` from the
same cases, preserving `overall`, building-type, and confidence slices.

Gate accuracy against `report.byStatus.reliable`, coverage against
`report.overall.estimateCoverage`, and slice counts against high/medium.
Review metrics remain output only.

Update `parseMarketDataArgs` and `backtest` so the selected policy is resolved
through `estimatorPolicyById`, passed to `backtestTransactions`, printed as
`policyId`, and bound into any persisted acceptance. A non-active diagnostic
policy must never write the canonical active acceptance.

- [ ] **Step 4: Implement schema-2 acceptance validation**

Update `validBacktestAcceptance`, `backtestAcceptance`,
`marketDataBacktestAcceptanceDecision`, and CLI output to require:

- schema 2;
- matching active policy ID;
- matching estimator policy version;
- exact approved thresholds;
- reliable cohort metrics;
- coverage at least 0.70;
- existing checksum and latest-date bindings.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --import tsx --test \
  scripts/lib/market-data/backtest.test.ts \
  scripts/lib/market-data/store.test.ts \
  scripts/lib/market-data/cli.test.ts \
  scripts/lib/market-data/integration.test.ts
npm test
```

Expected: all tests pass with no schema-1 acceptance accepted.

- [ ] **Step 6: Commit cohort acceptance**

```bash
git add scripts/lib/market-data/config.ts \
  scripts/lib/market-data/types.ts \
  scripts/lib/market-data/backtest.ts \
  scripts/lib/market-data/backtest.test.ts \
  scripts/lib/market-data/store.ts \
  scripts/lib/market-data/store.test.ts \
  scripts/market-data.ts \
  scripts/lib/market-data/cli.test.ts \
  scripts/lib/market-data/config.test.ts
git diff --cached
git commit -m "feat(market): gate reliable cohort and coverage"
```

---

### Task 5: Candidate Diagnostics and Pre-Publication Evaluation

**Files:**
- Modify: `scripts/lib/market-data/types.ts`
- Modify: `scripts/lib/market-data/update.ts`
- Modify: `scripts/lib/market-data/update.test.ts`
- Modify: `scripts/lib/market-data/store.ts`
- Modify: `scripts/market-data.ts`
- Modify: `scripts/lib/market-data/cli.test.ts`
- Test: updater and store tests

**Interfaces:**
- Add aggregate build diagnostics:

```ts
export interface TransactionBuildDiagnostics {
  rawRows: number;
  reliableEligible: number;
  reviewOnly: number;
  excluded: number;
  excludedByReason: Record<string, number>;
}
```

- Add `normalization: TransactionBuildDiagnostics` to
  `MarketDataManifest.transactions`.
- Add a reusable diagnostic candidate evaluator and a narrow injectable gate
  for deterministic unit tests:

```ts
export interface CandidateEvaluation {
  report: BacktestReport;
  gate: BacktestGateResult;
  acceptance: BacktestAcceptance | null;
  diagnostics: TransactionBuildDiagnostics;
}

export async function evaluateTaipeiMarketDataCandidate(options: {
  asOf: string;
  policy: EstimatorPolicy;
  publish: boolean;
  gateEvaluator?: (report: BacktestReport) => BacktestGateResult;
}): Promise<CandidateEvaluation>;
```

The function builds and validates an isolated stage, runs a complete gated
backtest against that stage, and always removes an unpublished stage. With
`publish: true`, it delegates a passing candidate and acceptance to Task 6.
`EnsureTaipeiMarketDataOptions.gateEvaluator` defaults to
`evaluateBacktestGate`.

Add CLI command
`candidate --city taipei --policy <baseline|48-month|1000-meter>`. It calls the
same evaluator with `publish: false`, prints aggregate diagnostics/report/gate,
does not modify active build or acceptance, and exits nonzero when the gate
fails.

- [ ] **Step 1: Write failing diagnostic tests**

Extend the update fixture with one reliable, one review-only, and one excluded
row. Assert:

```ts
assert.deepEqual(bundle?.manifest.transactions.normalization, {
  rawRows: 3,
  reliableEligible: 1,
  reviewOnly: 1,
  excluded: 1,
  excludedByReason: { 'non-residential-primary-use': 1 },
});
```

Add a gate evaluator that throws `candidate backtest failed`; with a
seeded active build, updater must return `last-known-good` and leave the active
manifest unchanged. Without an active build it must return null.
Add a CLI test proving `candidate --policy 48-month` is accepted while a
candidate run never calls the active publisher.

- [ ] **Step 2: Run updater tests and verify RED**

Run:

```bash
node --import tsx --test scripts/lib/market-data/update.test.ts
```

Expected: FAIL because row diagnostics and candidate evaluation do not exist.

- [ ] **Step 3: Collect deterministic diagnostics**

Change `addTransactionCsv` to mutate the shared, cross-season cell accumulator
and return only aggregate-safe diagnostics:

```ts
async function addTransactionCsv(
  input: NodeJS.ReadableStream,
  doorplates: DoorplateIndex,
  cells: TransactionIndex['cells'],
): Promise<TransactionBuildDiagnostics>;
```

Merge diagnostics across every season before writing the manifest. The
published `TransactionIndex.cells` contains both eligibility classes so review
evidence remains locally auditable, while selector eligibility prevents review
rows from becoming reliable. Aggregate counts and sorted reason keys go into
the manifest; no addresses or row payloads enter diagnostics.

- [ ] **Step 4: Evaluate the staged candidate**

Implement `evaluateTaipeiMarketDataCandidate`. After writing indexes and the
provisional manifest:

1. compute the staged `transactions-index.json` SHA-256;
2. run `backtestTransactions` with the requested policy, then the injected or
   default gate evaluator;
3. reject the candidate on any gate failure;
4. when `publish: false`, return aggregate results and remove the stage;
5. when `publish: true`, pass the candidate acceptance to Task 6's
   transactional publisher.

The production update path always uses `ACTIVE_ESTIMATOR_POLICY` with
`publish: true`. The CLI `candidate` path may use an experimental policy but is
always `publish: false`. Neither path uses `--no-gate`.

- [ ] **Step 5: Run updater and full tests**

Run:

```bash
node --import tsx --test \
  scripts/lib/market-data/update.test.ts \
  scripts/lib/market-data/store.test.ts \
  scripts/lib/market-data/cli.test.ts
npm test
```

Expected: PASS; refresh failure retains last-known-good and aggregate reason
keys are stable.

- [ ] **Step 6: Commit candidate evaluation**

```bash
git add scripts/lib/market-data/types.ts \
  scripts/lib/market-data/update.ts \
  scripts/lib/market-data/update.test.ts \
  scripts/lib/market-data/store.ts \
  scripts/market-data.ts \
  scripts/lib/market-data/cli.test.ts
git diff --cached
git commit -m "feat(market): backtest candidate builds before publish"
```

---

### Task 6: Transactional Build and Acceptance Publication

**Files:**
- Modify: `scripts/lib/market-data/store.ts`
- Modify: `scripts/lib/market-data/store.test.ts`
- Modify: `scripts/lib/market-data/update.ts`
- Modify: `scripts/lib/market-data/update.test.ts`
- Test: store and updater failure tests

**Interfaces:**
- Produces:

```ts
export async function publishStagedBuildWithAcceptance(
  root: string,
  stage: string,
  acceptance: BacktestAcceptance,
  options?: PublishOptions,
): Promise<MarketDataBundle>;
```

- Guarantees final state is either the old validated build/acceptance pair or
  the new validated build/acceptance pair.
- A module-private helper accepts:

```ts
interface PublicationFileOps {
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}
```

Production uses `node:fs/promises`; tests inject only the failing operation.

- [ ] **Step 1: Write failing transactional publication tests**

Cover:

1. successful publication loads a bundle with matching acceptance;
2. acceptance write failure restores the old directory and old acceptance;
3. new index checksum mismatch rejects before renaming;
4. a reader observing the rename window can only see review-only mismatch, not
   a false accepted pair;
5. temporary candidate and backup paths are removed after success.

Inject a failing rename operation through a narrow test-only dependency object
rather than adding production cleanup methods.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --import tsx --test \
  scripts/lib/market-data/store.test.ts \
  scripts/lib/market-data/update.test.ts
```

Expected: FAIL because build and acceptance currently publish independently.

- [ ] **Step 3: Implement publication protocol**

Under the existing market-data refresh lock:

1. validate the staged build;
2. validate acceptance against the staged transaction checksum and active
   policy;
3. write acceptance to a sibling temporary path;
4. preserve the old acceptance bytes and move the old active directory to a
   unique backup;
5. rename stage to active root;
6. rename candidate acceptance to the canonical sibling acceptance path;
7. load and validate the new pair;
8. delete backup only after validation.

On any failure after step 4, move the failed new root aside, restore the backup,
restore the old acceptance bytes or absence, and rethrow. Readers continue to
fail closed when acceptance is temporarily absent or mismatched.

- [ ] **Step 4: Route updater publication through the new function**

Replace the updater's direct `publishStagedBuild` call with
`publishStagedBuildWithAcceptance`. Preserve current unpublished-season,
conditional download, lock lease, and last-known-good behavior.

- [ ] **Step 5: Run failure, concurrency, and full tests**

Run:

```bash
node --import tsx --test \
  scripts/lib/market-data/store.test.ts \
  scripts/lib/market-data/update.test.ts
npm test
```

Expected: all publication, rollback, checksum, and concurrent-refresh tests
pass.

- [ ] **Step 6: Commit transactional publication**

```bash
git add scripts/lib/market-data/store.ts \
  scripts/lib/market-data/store.test.ts \
  scripts/lib/market-data/update.ts \
  scripts/lib/market-data/update.test.ts
git diff --cached
git commit -m "feat(market): publish accepted builds transactionally"
```

---

### Task 7: Documentation, Real Candidate Calibration, and Smoke Verification

**Files:**
- Modify: `docs/market-data.md`
- Modify: `docs/reporting-rules.md`
- Modify: `AGENTS.md`
- Modify only if evidence selects a fallback: `scripts/lib/market-data/config.ts`
- Modify only if evidence selects a fallback: affected selector/backtest tests
- Create diagnostic artifact locally: `state/market-data/backtests/taipei/2026-07-28-<policy>.json` (git-ignored)

**Interfaces:**
- Documents the schema-2 acceptance, 70% coverage denominator, eligibility
  classes, candidate publication, and fallback policy decision.
- Produces one active policy selected only by the approved metrics.

- [ ] **Step 1: Update documentation**

Document:

- base-doorplate matching and retained full evidence;
- reliable-eligible, review-only, and excluded transaction classes;
- reliable-cohort 12%/20% gate and 70% eligible coverage;
- candidate build plus acceptance publication;
- staged fallback order and policy-version bump;
- last-known-good behavior.

- [ ] **Step 2: Run the full test suite before using real data**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Build and evaluate the baseline candidate**

Run with network access:

```bash
npm run market-data -- candidate --city taipei --policy baseline \
  > state/market-data/backtests/taipei/2026-07-28-baseline.json
```

Read only aggregate metrics. Required:

- eligible coverage ≥70%;
- reliable median APE ≤12%;
- reliable P75 APE ≤20%;
- high and medium counts ≥20;
- confidence ordering passes.

- [ ] **Step 4: Apply the evidence-based fallback gate**

If baseline passes, keep `ACTIVE_ESTIMATOR_POLICY =
BASELINE_ESTIMATOR_POLICY` and do not activate either fallback.

If only coverage is below 70%, run:

```bash
npm run market-data -- candidate --city taipei --policy 48-month \
  > state/market-data/backtests/taipei/2026-07-28-48-month.json
```

Activate the 48-month policy only when all acceptance metrics pass; bump
`ESTIMATOR_POLICY_VERSION` to 3, rerun tests, and then run
`npm run market-data -- update --city taipei` to publish the gated candidate.

If the accepted 48-month policy remains below 70%, run:

```bash
npm run market-data -- candidate --city taipei --policy 1000-meter \
  > state/market-data/backtests/taipei/2026-07-28-1000-meter.json
```

Activate the 1,000-meter policy only when all acceptance metrics pass; bump
`ESTIMATOR_POLICY_VERSION` once more, rerun tests, and publish with the normal
`update` command. If neither fallback passes, retain the last-known-good active
policy and report the coverage gap without lowering thresholds.

- [ ] **Step 5: Run a same-day no-notification smoke check**

Run:

```bash
npm run fetch -- --profile investment-taipei.local --date 2026-07-28
npm run enrich -- --profile investment-taipei.local --date 2026-07-28
```

Do not generate a report or notification. Verify:

- no `listing-building-type-unavailable` regression;
- market summary counts equal listing count;
- eligible listing market availability is at least 70%;
- reliable estimates carry matching schema-2 acceptance;
- review-only evidence never produces reliable status;
- official sources are fresh or explicitly marked stale.

- [ ] **Step 6: Commit documentation and any evidence-selected active policy**

```bash
git add AGENTS.md docs/market-data.md docs/reporting-rules.md
git add scripts/lib/market-data/config.ts \
  scripts/lib/market-data/selector.test.ts \
  scripts/lib/market-data/backtest.test.ts
git diff --cached
git commit -m "docs(market): document accepted valuation policy"
```

If no fallback policy changed code, stage only the three documentation files.
Never stage `state/`.

- [ ] **Step 7: Final verification**

Run:

```bash
npm test
node --import tsx --input-type=module -e "
  import { loadMarketData, marketDataBacktestAccepted } from './scripts/lib/market-data/store.ts';
  const bundle = await loadMarketData('state/market-data/taipei');
  if (!bundle || !marketDataBacktestAccepted(bundle)) process.exit(1);
  console.log(JSON.stringify({
    buildId: bundle.manifest.buildId,
    transactions: bundle.manifest.transactions.recordCount,
    normalization: bundle.manifest.transactions.normalization,
    acceptance: bundle.backtestAcceptance?.metrics,
  }, null, 2));
"
git status --short
```

Expected: tests pass, active build has matching acceptance, aggregate
normalization and acceptance metrics print, and only intentionally preserved
unrelated user changes remain.
