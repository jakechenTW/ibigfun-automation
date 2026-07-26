# Market Acceptance Batch Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan acceptance coverage once per listing batch while enforcing strict artifact dates and one subject-date held-out eligibility definition.

**Architecture:** A store-level decision API owns acceptance validation and one complete-index coverage scan, with explicit diagnostics passed from the batch boundary. Backtest coverage and case population share one intrinsic transaction-date eligibility predicate; `--as-of` filtering stays separate.

**Tech Stack:** TypeScript, Node.js test runner, filesystem-backed JSON artifacts.

## Global Constraints

- N listings with one bundle perform exactly one eligible transaction scan.
- Acceptance calendar fields reject impossible real dates.
- Held-out eligibility is evaluated at the subject transaction date.
- `--no-gate`, checksums, policy binding, and fail-closed review behavior remain unchanged.

---

### Task 1: Batch-Scoped Acceptance Decision

**Files:**
- Modify: `scripts/lib/market-data/store.ts`
- Modify: `scripts/lib/steps.ts`
- Test: `scripts/lib/market-data/integration.test.ts`

**Interfaces:**
- Produces: `MarketAcceptanceDecision = { accepted: boolean; reason: 'market-backtest-not-approved' | null }`
- Produces: `MarketAcceptanceDiagnostics = { eligibleTransactionScans: number }`
- Produces: `marketDataBacktestAcceptanceDecision(bundle, diagnostics?)`

- [ ] **Step 1: Write the failing integration test**

Pass five valid listings and `{ eligibleTransactionScans: 0 }` to
`attachMarketEstimates`. Assert all five remain reliable and the real
diagnostics value is exactly `1`.

- [ ] **Step 2: Run the test to verify RED**

Run:
`node --import tsx --test scripts/lib/market-data/integration.test.ts`

Expected: FAIL because the batch API does not accept diagnostics and scans from
inside each listing enforcement call.

- [ ] **Step 3: Implement the minimal batch decision**

Make the decision function increment diagnostics immediately before its single
call to `latestEligibleTransactionDate`. In `attachMarketEstimates`, compute:

```ts
const acceptance = bundle
  ? marketDataBacktestAcceptanceDecision(bundle, diagnostics)
  : null;
```

before `listings.map`, and pass the decision to enforcement. Keep
`marketDataBacktestAccepted` as a delegating boolean wrapper.

- [ ] **Step 4: Run the integration test to verify GREEN**

Run the Step 2 command. Expected: PASS with one scan for five listings.

### Task 2: Strict Acceptance Calendar Dates

**Files:**
- Modify: `scripts/lib/market-data/store.ts`
- Test: `scripts/lib/market-data/store.test.ts`

**Interfaces:**
- Consumes: `isValidDateString(value: string): boolean` from
  `scripts/lib/date.ts`

- [ ] **Step 1: Write failing persistence and read tests**

For each of `asOf`, `evaluatedThrough`, and
`latestEligibleTransactionDate`, substitute `2026-02-30`. Assert persistence
rejects the artifact. Write one malformed artifact directly and assert
`loadMarketData` ignores it.

- [ ] **Step 2: Run the store test to verify RED**

Run: `node --import tsx --test scripts/lib/market-data/store.test.ts`

Expected: FAIL because format-only date checks accept February 30.

- [ ] **Step 3: Use centralized strict validation**

Replace all three acceptance field regex checks with:

```ts
isValidDateString(value.asOf)
isValidDateString(value.evaluatedThrough)
isValidDateString(value.latestEligibleTransactionDate)
```

Keep timestamp validation for `approvedAt`.

- [ ] **Step 4: Run the store test to verify GREEN**

Run the Step 2 command. Expected: PASS.

### Task 3: Shared Subject-Date Eligibility

**Files:**
- Modify: `scripts/lib/market-data/backtest.ts`
- Test: `scripts/lib/market-data/backtest.test.ts`

**Interfaces:**
- Produces: `heldOutTransactionEligible(transaction): boolean`
- Consumes: parsed transaction date as the sole age/completion evaluation date

- [ ] **Step 1: Write the failing contract test**

Import the wished-for predicate. Create a midrise transaction whose completion
date is after its transaction date and assert the predicate is false, the
transaction does not become `latestEligibleTransactionDate`, and no backtest
case uses it.

- [ ] **Step 2: Run the backtest test to verify RED**

Run: `node --import tsx --test scripts/lib/market-data/backtest.test.ts`

Expected: FAIL because the shared exported predicate does not exist.

- [ ] **Step 3: Implement one intrinsic predicate**

Remove the report-cutoff parameter. Parse the transaction date inside the
predicate and use that date for completion/age validation. Call the predicate
from both the complete-index latest calculation and case population after
entries have already been filtered by `--as-of`.

- [ ] **Step 4: Run the backtest test to verify GREEN**

Run the Step 2 command. Expected: PASS.

### Task 4: Documentation, Verification, and Commit

**Files:**
- Modify: `docs/market-data.md`
- Modify: `.superpowers/sdd/2026-07-26-gps-market-estimation/task-9-report.md`

- [ ] **Step 1: Document the boundaries**

State that production evaluates acceptance once per listing batch, artifact
calendar dates are strict real dates, and held-out eligibility uses the subject
transaction date independently from `--as-of`.

- [ ] **Step 2: Run completion verification**

Run focused backtest/store/integration tests, `npx tsc --noEmit`, `npm test`,
and `git diff --check`. Record exact RED/GREEN and final results in the report.

- [ ] **Step 3: Commit**

Stage only this plan, implementation, tests, and operator docs, then run:

```bash
git commit -m "fix(market): evaluate acceptance once per batch"
```
