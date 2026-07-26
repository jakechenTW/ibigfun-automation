# Market Backtest Acceptance Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind backtest acceptance to the exact estimator policy and complete eligible transaction history it evaluated.

**Architecture:** A deliberate policy-version constant identifies valuation semantics. Backtest reports derive the latest eligible transaction date from the complete deduplicated index; persistence and runtime loading validate that policy and temporal identity in addition to the existing transaction checksum and quality thresholds.

**Tech Stack:** TypeScript, Node.js test runner, filesystem-backed JSON artifacts.

## Global Constraints

- `ESTIMATOR_POLICY_VERSION` starts at `1` and must be bumped for selector, weighting, outlier, confidence, status, or backtest semantic changes.
- Gated historical runs cannot approve an active index newer than `--as-of`.
- `--no-gate` stays diagnostic-only.
- Active-build artifact validation remains checksum-closed.

---

### Task 1: Policy Identity Contract

**Files:**
- Modify: `scripts/lib/market-data/config.ts`
- Modify: `scripts/lib/market-data/config.test.ts`
- Modify: `scripts/lib/market-data/types.ts`
- Modify: `scripts/lib/market-data/store.ts`
- Test: `scripts/lib/market-data/store.test.ts`

**Interfaces:**
- Produces: `ESTIMATOR_POLICY_VERSION: 1`
- Produces: required `BacktestAcceptance.estimatorPolicyVersion`
- Consumes: existing acceptance read/write and `marketDataBacktestAccepted`

- [ ] **Step 1: Write failing tests**

Add acceptance fixtures with `estimatorPolicyVersion: 1`, then mutate it to
`2` and assert `writeBacktestAcceptance` rejects it and
`marketDataBacktestAccepted` returns false.

- [ ] **Step 2: Run tests to verify RED**

Run:
`node --import tsx --test scripts/lib/market-data/config.test.ts scripts/lib/market-data/store.test.ts scripts/lib/market-data/integration.test.ts`

Expected: TypeScript/module assertions fail because the policy contract is not
implemented.

- [ ] **Step 3: Implement the minimal policy binding**

Export the version constant, require it in `BacktestAcceptance`, and validate:

```ts
acceptance.estimatorPolicyVersion === ESTIMATOR_POLICY_VERSION
```

Apply that check both before persistence and before production authorization.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run the Step 2 command. Expected: PASS.

### Task 2: Complete-Index Temporal Coverage

**Files:**
- Modify: `scripts/lib/market-data/backtest.ts`
- Modify: `scripts/lib/market-data/backtest.test.ts`
- Modify: `scripts/lib/market-data/types.ts`
- Modify: `scripts/market-data.ts`

**Interfaces:**
- Produces: `BacktestReport.latestEligibleTransactionDate: string | null`
- Produces: required acceptance fields `evaluatedThrough` and
  `latestEligibleTransactionDate`
- Produces: gate reason `incomplete-active-transaction-coverage`

- [ ] **Step 1: Write failing backtest tests**

For an index whose latest eligible sale is `2025-12-01`, assert a report with
`asOf: '2025-04-01'` still reports
`latestEligibleTransactionDate: '2025-12-01'`, fails the gate with
`incomplete-active-transaction-coverage`, exits nonzero when gated, and is
never persisted. Assert a report through `2025-12-01` can form acceptance with
`evaluatedThrough: '2025-12-01'`.

- [ ] **Step 2: Run the test to verify RED**

Run: `node --import tsx --test scripts/lib/market-data/backtest.test.ts`

Expected: FAIL because reports and acceptance lack temporal coverage.

- [ ] **Step 3: Implement complete-index coverage**

Deduplicate all indexed transactions first, compute the maximum date satisfying
the held-out eligibility predicate at its own transaction date, then filter
evaluation entries by `asOf`. Add the gate reason whenever:

```ts
report.latestEligibleTransactionDate === null
  || report.asOf < report.latestEligibleTransactionDate
```

Persist `evaluatedThrough = report.asOf` and the latest eligible date only from
a passing gate.

- [ ] **Step 4: Run the test to verify GREEN**

Run the Step 2 command. Expected: PASS.

### Task 3: Runtime Temporal Validation

**Files:**
- Modify: `scripts/lib/market-data/store.ts`
- Modify: `scripts/lib/market-data/store.test.ts`
- Modify: `scripts/lib/market-data/integration.test.ts`

**Interfaces:**
- Consumes: `latestEligibleTransactionDate(index)`
- Produces: fail-closed acceptance attachment and production authorization

- [ ] **Step 1: Write failing store and integration tests**

Create valid acceptance, then assert it is ignored when
`evaluatedThrough < latestEligibleTransactionDate`, when the persisted latest
date differs from the active index, and when an eligible newer transaction is
added without changing schema. Assert policy mismatch downgrades an otherwise
reliable integration estimate to `review` with
`market-backtest-not-approved`.

- [ ] **Step 2: Run tests to verify RED**

Run:
`node --import tsx --test scripts/lib/market-data/store.test.ts scripts/lib/market-data/integration.test.ts`

Expected: FAIL because runtime authorization does not inspect policy or temporal
coverage.

- [ ] **Step 3: Implement runtime validation**

Validate ISO dates, exact policy identity, exact latest eligible date against
the loaded transaction index, and `evaluatedThrough >=
latestEligibleTransactionDate`. Keep checksum and threshold checks unchanged.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run the Step 2 command. Expected: PASS.

### Task 4: Operator Documentation and Verification

**Files:**
- Modify: `docs/market-data.md`
- Modify: `AGENTS.md`
- Modify: `.superpowers/sdd/2026-07-26-gps-market-estimation/task-9-report.md`

- [ ] **Step 1: Document the contract**

Explain full-index `--as-of` coverage, the persisted coverage fields, exact
runtime matching, and the mandatory policy-version bump categories.

- [ ] **Step 2: Run completion verification**

Run focused backtest/config/store/integration tests, `npx tsc --noEmit`,
`npm test`, and `git diff --check`. Record exact results in the task report.

- [ ] **Step 3: Commit**

Stage only this plan and the acceptance-binding implementation/docs/tests, then
commit with:

```bash
git commit -m "fix(market): bind backtest acceptance to policy and coverage"
```
