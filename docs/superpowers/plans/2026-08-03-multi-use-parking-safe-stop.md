# Multi-use Parking Valuation Safe-stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the corrected schema-5 / policy-6 parking challenger without activating it, while restoring the exact schema-3 / policy-4 / acceptance-schema-2 legacy production authority and daily operation.

**Architecture:** Production and challenger use separate constants, acceptance builders, validators, and entry points. Production loading and reporting remain frozen on the checksum-closed legacy pair; candidate evaluation builds schema 5 in an isolated staging directory, never publishes, and returns aggregate gate evidence only.

**Tech Stack:** TypeScript, Node.js test runner, `tsx`, checksum-closed JSON artifacts, Markdown operating procedures.

## Global Constraints

- Production contract is build schema 3, estimator policy 4, acceptance schema 2, exactly as merge base `ab54d11`.
- Challenger contract is build schema 5, estimator policy 6, strict aggregate candidate acceptance schema 3.
- The frozen gates remain: absolute use-cohort bias 0.05, use interval coverage 0.30, parking family cases 20, estimate coverage 0.50, price median/P75 APE 0.25/0.45, area median/P75 APE 0.15/0.30, and price/area interval coverage 0.30/0.30.
- Measured direct-to-imputed coverage remains full-precision `0.7768882226688925` to `0.7868701665928525`; tests and reports must not substitute a different measurement.
- No threshold tuning, production update, production backtest, state publication, raw candidate stdout, held-out cases, rows, IDs, or addresses.
- Candidate failure or a publish request must leave production manifest bytes, transaction checksum, acceptance bytes, and build ID unchanged.
- `marketEstimate` remains production report authority; `marketScenarios` is diagnostic only.

---

### Task 1: Split Production and Challenger Provenance

**Files:**
- Modify: `scripts/lib/market-data/config.ts`
- Modify: `scripts/lib/market-data/config.test.ts`
- Modify: `scripts/lib/market-data/types.ts`
- Modify: `scripts/lib/market-data/backtest.ts`
- Modify: `scripts/lib/market-data/backtest.test.ts`
- Modify: `scripts/lib/market-data/store.ts`
- Modify: `scripts/lib/market-data/store.test.ts`

**Interfaces:**
- Consumes: existing `BacktestReport`, legacy build fixtures from merge base `ab54d11`, and current strict challenger metrics.
- Produces: `MARKET_SCHEMA_VERSION = 3`, `ESTIMATOR_POLICY_VERSION = 4`, `CANDIDATE_MARKET_SCHEMA_VERSION = 5`, `CANDIDATE_ESTIMATOR_POLICY_VERSION = 6`, `backtestAcceptance(...)` for production schema 2, `candidateBacktestAcceptance(...)` for challenger schema 3, `validCandidateBacktestAcceptance(...)`, and `validateCandidateStagedBuild(...)`.

- [ ] **Step 1: Write failing constant and acceptance tests**

```ts
assert.equal(MARKET_SCHEMA_VERSION, 3);
assert.equal(ESTIMATOR_POLICY_VERSION, 4);
assert.equal(CANDIDATE_MARKET_SCHEMA_VERSION, 5);
assert.equal(CANDIDATE_ESTIMATOR_POLICY_VERSION, 6);

const production = backtestAcceptance(passingLegacyReport, checksum, approvedAt);
assert.equal(production.schemaVersion, 2);
assert.equal(production.estimatorPolicyVersion, 4);

const candidate = candidateBacktestAcceptance(passingCandidateReport, checksum, approvedAt);
assert.equal(candidate.schemaVersion, 3);
assert.equal(candidate.estimatorPolicyVersion, 6);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --import tsx --test scripts/lib/market-data/config.test.ts scripts/lib/market-data/backtest.test.ts`

Expected: FAIL because active constants are 5/6 and there is no separate candidate acceptance builder.

- [ ] **Step 3: Implement separate constants, types, and builders**

```ts
export const MARKET_SCHEMA_VERSION = 3;
export const ESTIMATOR_POLICY_VERSION = 4;
export const CANDIDATE_MARKET_SCHEMA_VERSION = 5;
export const CANDIDATE_ESTIMATOR_POLICY_VERSION = 6;

export interface BacktestAcceptance extends BacktestAcceptanceIdentity {
  schemaVersion: 2;
  thresholds: BacktestAcceptanceThresholds;
  metrics: BacktestAcceptanceMetrics;
}

export type CandidateBacktestAcceptanceThresholds = BacktestAcceptanceThresholds & {
  minimumUseCohortCases: number;
  maximumAbsoluteBiasRegression: number;
  maximumIntervalCoverageRegression: number;
  maximumAbsoluteBias: number;
  minimumIntervalCoverage: number;
  minimumParkingFamilyCases: number;
  minimumParkingEstimateCoverage: number;
  parkingPriceMedianApeMax: number;
  parkingPriceP75ApeMax: number;
  parkingAreaMedianApeMax: number;
  parkingAreaP75ApeMax: number;
  minimumParkingPriceIntervalCoverage: number;
  minimumParkingAreaIntervalCoverage: number;
};

export interface ParkingComparisonAcceptance {
  directCoverage: number;
  imputedCoverage: number;
  directMedianApe: number | null;
  imputedMedianApe: number | null;
  directP75Ape: number | null;
  imputedP75Ape: number | null;
  biasRegression: number | null;
  intervalCoverageRegression: number | null;
}

export interface CandidateBacktestAcceptance extends BacktestAcceptanceIdentity {
  schemaVersion: 3;
  thresholds: CandidateBacktestAcceptanceThresholds;
  metrics: BacktestAcceptanceMetrics;
  useCohorts: Record<Exclude<NormalizedPrimaryUse, 'unknown'>, ScenarioCohortAcceptance>;
  parkingImputationAccepted: boolean;
  parkingFamilies: Record<'flat' | 'mechanical', ParkingFamilyAcceptance>;
  parkingComparison: ParkingComparisonAcceptance;
}
```

Restore `backtestAcceptance` and the production gate to the merge-base global
contract. Rename the current strict builder and gate to
`candidateBacktestAcceptance` and `evaluateCandidateBacktestGate`.

- [ ] **Step 4: Write failing dual-validator tests**

```ts
const active = await loadMarketData(schema3Policy4Root, fixtureOptions);
assert.equal(active?.backtestAcceptance?.schemaVersion, 2);
assert.equal(marketDataBacktestAccepted(active!), true);

await assert.rejects(
  () => validateCandidateStagedBuild(schema3Policy4Root, fixtureOptions),
  /candidate.*schema|policy/i,
);
assert.equal(await loadMarketData(schema5Policy6Root, fixtureOptions), null);
assert.ok(await validateCandidateStagedBuild(schema5Policy6Root, fixtureOptions));
assert.equal(validCandidateBacktestAcceptance(candidateAcceptance), true);
assert.equal(validBacktestAcceptance(candidateAcceptance), false);
```

- [ ] **Step 5: Run store tests and verify RED**

Run: `node --import tsx --test scripts/lib/market-data/store.test.ts`

Expected: FAIL because current loading accepts only schema 5 / policy 6 and uses one acceptance validator.

- [ ] **Step 6: Implement dual validation without cross-authorization**

Production `loadMarketData`, publication recovery, acceptance reads, writes, and
attachment validate only schema 3 / policy 4 plus schema-2 acceptance. Candidate
staging validates exact schema 5 / policy 6 normalization, component counts,
indexes, checksums, and strict candidate acceptance through separate exported
functions. Schema 4 / policy 5 is neither production proof nor candidate proof.

- [ ] **Step 7: Run Task 1 tests and verify GREEN**

Run: `node --import tsx --test scripts/lib/market-data/config.test.ts scripts/lib/market-data/backtest.test.ts scripts/lib/market-data/store.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add scripts/lib/market-data/config.ts scripts/lib/market-data/config.test.ts scripts/lib/market-data/types.ts scripts/lib/market-data/backtest.ts scripts/lib/market-data/backtest.test.ts scripts/lib/market-data/store.ts scripts/lib/market-data/store.test.ts
git commit -m "fix: separate production and parking challenger provenance"
```

### Task 2: Freeze Production Refresh and Make Candidate Evaluation-only

**Files:**
- Modify: `scripts/lib/market-data/doorplates.ts`
- Modify: `scripts/lib/market-data/update.ts`
- Modify: `scripts/lib/market-data/update.test.ts`
- Modify: `scripts/market-data.ts`
- Modify: `scripts/lib/market-data/cli.test.ts`

**Interfaces:**
- Consumes: production `loadMarketData`, candidate constants and validator from Task 1, current causal normalization and backtest pipeline.
- Produces: load-only `ensureTaipeiMarketData(...)`, evaluation-only `evaluateTaipeiMarketDataCandidate(...)`, candidate-version index creation, and explicit `challenger-activation-withheld` update status.

- [ ] **Step 1: Write failing non-mutation tests**

```ts
const beforeManifest = await readFile(join(root, 'manifest.json'));
const beforeAcceptance = await readFile(backtestAcceptancePath(root));
const bundle = await ensureTaipeiMarketData({ asOf, rootPath: root, ...fixtureOptions });
assert.equal(bundle?.manifest.buildId, legacyBuildId);
assert.equal(bundle?.refresh?.status, 'last-known-good');
assert.match(bundle?.refresh?.failure ?? '', /challenger-activation-withheld/);
assert.deepEqual(await readFile(join(root, 'manifest.json')), beforeManifest);
assert.deepEqual(await readFile(backtestAcceptancePath(root)), beforeAcceptance);

await assert.rejects(
  () => evaluateTaipeiMarketDataCandidate({ asOf, policy, publish: true }),
  /challenger activation is withheld/i,
);
```

Also exercise a failed injected candidate gate and assert zero publisher calls,
unchanged transaction checksum, and unchanged build ID.

- [ ] **Step 2: Run focused update tests and verify RED**

Run: `node --import tsx --test scripts/lib/market-data/update.test.ts scripts/lib/market-data/cli.test.ts`

Expected: FAIL because `ensureTaipeiMarketData` still builds/publishes current semantics and candidate publish is permitted for the active policy ID.

- [ ] **Step 3: Implement load-only production ensure**

Under the existing refresh lock, recover interrupted legacy publication, load
the production pair, and return it with:

```ts
bundle.refresh = {
  status: 'last-known-good',
  failure: 'challenger-activation-withheld',
};
```

Do not fetch sources, alter checked-at timestamps, build a candidate, or write
files. Return `null` if no valid production pair exists.

- [ ] **Step 4: Implement isolated candidate staging**

Candidate builds pass `CANDIDATE_MARKET_SCHEMA_VERSION` into doorplate and
transaction index creation, write policy 6 in the staging manifest, validate
through `validateCandidateStagedBuild`, evaluate through
`evaluateCandidateBacktestGate`, and produce
`candidateBacktestAcceptance` only when the candidate gate passes. Always
remove the stage and never call a production publisher.

- [ ] **Step 5: Restore legacy CLI backtest and explicit update warning**

`backtestExitCode`, acceptance persistence, and CLI gate output use the legacy
`evaluateBacktestGate` and schema-2 `backtestAcceptance`. `candidate` alone uses
the strict candidate gate. `update` reports the retained build and exits with
the existing non-success last-known-good code while naming the activation
freeze.

- [ ] **Step 6: Run Task 2 tests and verify GREEN**

Run: `node --import tsx --test scripts/lib/market-data/update.test.ts scripts/lib/market-data/cli.test.ts`

Expected: PASS, including unchanged-byte assertions.

- [ ] **Step 7: Commit Task 2**

```bash
git add scripts/lib/market-data/doorplates.ts scripts/lib/market-data/update.ts scripts/lib/market-data/update.test.ts scripts/market-data.ts scripts/lib/market-data/cli.test.ts
git commit -m "fix: freeze failed parking challenger activation"
```

### Task 3: Restore Legacy Report Authority

**Files:**
- Modify: `scripts/lib/steps.ts`
- Modify: `scripts/lib/market-data/integration.test.ts`
- Modify: `AGENTS.md`
- Modify: `docs/fetching.md`
- Modify: `docs/market-data.md`
- Modify: `docs/reporting-rules.md`
- Modify: `prompts/daily-run.md`
- Modify: `profiles/example-investment/evaluation.md`
- Modify: `profiles/example-investment/notify-template.md`
- Modify: `profiles/example-owner-occupied/evaluation.md`
- Modify: `profiles/example-owner-occupied/notify-template.md`

**Interfaces:**
- Consumes: a valid production bundle and optional diagnostic challenger scenarios.
- Produces: authoritative legacy `marketEstimate`, diagnostic-only `marketScenarios`, and consistent worker/report instructions.

- [ ] **Step 1: Write failing authority tests**

```ts
const [listing] = attachMarketEstimates([subject], acceptedLegacyBundle, asOf);
assert.equal(listing.marketEstimate.status, 'reliable');
assert.equal(
  listing.marketEstimate.unavailableReasons.includes('legacy-residential-baseline-not-authoritative'),
  false,
);
assert.ok(listing.marketScenarios); // diagnostics remain available
```

Add a parking listing assertion that the production estimate remains review-only
with `listing-parking-not-separable`, regardless of diagnostic scenario output.

- [ ] **Step 2: Run integration tests and verify RED**

Run: `node --import tsx --test scripts/lib/market-data/integration.test.ts`

Expected: FAIL because the activation layer currently downgrades the legacy
estimate and treats scenarios as authoritative.

- [ ] **Step 3: Restore production attachment semantics**

Remove `labelLegacyCompatibilityEstimate` and the final remapping pass. Keep the
new location evidence propagation and challenger diagnostics, but do not let a
challenger acceptance or scenario status alter `marketEstimate`.

- [ ] **Step 4: Restore and amend operating documents**

Restore authority, profile gates, templates, and the headless prompt to their
merge-base legacy wording. Add one explicit challenger section stating:

```md
Policy-6 `marketScenarios` is diagnostic-only after the 2026-08-03 candidate
failed its frozen flat-parking gate. It must not control report buckets, and
automatic official-data refresh is withheld; stale legacy evidence is `warn`.
```

Keep the aggregate failure metrics in the safe-stop spec and link to it. Do not
add raw evidence or addresses.

- [ ] **Step 5: Run Task 3 tests and documentation checks**

Run: `node --import tsx --test scripts/lib/market-data/integration.test.ts scripts/lib/report-notify.test.ts scripts/lib/valuation-review.test.ts`

Run: `rg -n "authoritative.*marketScenarios|marketScenarios.*權威|legacy-residential-baseline-not-authoritative" AGENTS.md docs prompts profiles scripts/lib/steps.ts`

Expected: tests PASS; search finds no production-authority or downgrade claim.

- [ ] **Step 6: Commit Task 3**

```bash
git add AGENTS.md docs/fetching.md docs/market-data.md docs/reporting-rules.md prompts/daily-run.md profiles scripts/lib/steps.ts scripts/lib/market-data/integration.test.ts
git commit -m "docs: restore legacy valuation report authority"
```

### Task 4: Verify and Record the Safe-stop

**Files:**
- Create: `.superpowers/sdd/final-fix-wave-report.md`
- Modify only if verification exposes a defect: files already listed above.

**Interfaces:**
- Consumes: all Task 1–3 changes and aggregate candidate evidence.
- Produces: aggregate-only handoff report and a verified branch.

- [ ] **Step 1: Run focused candidate safety suites**

Run: `node --import tsx --test scripts/lib/market-data/config.test.ts scripts/lib/market-data/transactions.test.ts scripts/lib/market-data/parking.test.ts scripts/lib/market-data/selector.test.ts scripts/lib/market-data/scenario-estimator.test.ts scripts/lib/market-data/acceptance-policy.test.ts scripts/lib/market-data/backtest.test.ts scripts/lib/market-data/store.test.ts scripts/lib/market-data/update.test.ts scripts/lib/market-data/cli.test.ts scripts/lib/market-data/integration.test.ts scripts/lib/market-data/evidence.test.ts`

Expected: PASS.

- [ ] **Step 2: Run static checks**

Run: `npx tsc --noEmit`

Run: `git diff --check`

Expected: both exit 0.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`

Expected: every test passes. Do not run a production update or production
backtest, and do not rerun the real candidate unless a code defect invalidates
the already measured aggregate result.

- [ ] **Step 4: Write the aggregate-only handoff report**

Record frozen thresholds, exact aggregate gate reasons and metrics, version
boundaries, refresh freeze tradeoff, test counts, and changed-file summary.
Exclude cases, rows, IDs, and addresses.

- [ ] **Step 5: Review repository state**

Run: `git status --short`

Run: `git diff --stat ab54d11...HEAD`

Run: `git diff --check`

Expected: no `state/` files, candidate stdout, or unrelated user files are
staged or modified.

- [ ] **Step 6: Commit the final report and any verification-only corrections**

```bash
git add .superpowers/sdd/final-fix-wave-report.md
git commit -m "docs: record parking challenger verification"
```
