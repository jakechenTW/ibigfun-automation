# Coordinate-Verified Market Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept reliable listing pins with an official doorplate within 100 metres as recommendation-eligible location evidence, and show every available official median plus comparable count in reports.

**Architecture:** Keep exact forward-doorplate validation authoritative. For unresolved public addresses, classify the nearest official doorplate into accepted (`<=100 m`), review-only (`>100 m && <=300 m`), or unavailable (none within 300 m); the estimator continues to select transactions from the listing coordinate and never treats a proximity-derived doorplate as the exact building. Update the agent-facing report contract so review estimates with non-null medians remain qualified but useful.

**Tech Stack:** TypeScript, Node.js test runner, local schema-5 Taipei market-data writer/backtest, Markdown operational policy.

## Global Constraints

- The accepted proximity boundary is exactly `<= 100` metres; `> 100 && <= 300` metres is review-only.
- A road/section/lane/alley mismatch alone is not a conflict when forward address lookup is unresolved.
- Coordinate-derived validation requires `reliability.coordConsistent === true` and matching city/district evidence.
- The listing coordinate remains the estimator subject coordinate; never snap it to the nearest doorplate.
- Coordinate-derived validation must not activate same-building scenario selection.
- Only `marketEstimate.status === "reliable"`, confidence other than `low`, fresh sources, and all existing profile gates may produce a recommendation.
- Any non-null official median renders as one decimal place with `marketEstimate.comparables.length`; review values also carry one concise limitation.
- Never compare asking price with official evidence to label value or choose a bucket.
- Increment active and candidate estimator policy versions together from `7` to `8`; schema versions remain `5`.
- Publish only through `npm run market-data -- update --city taipei`; a failed gate retains the last-known-good pair.

---

### Task 1: Tiered Coordinate-to-Doorplate Location Evidence

**Files:**
- Modify: `scripts/lib/market-data/types.ts`
- Modify: `scripts/lib/steps.ts`
- Test: `scripts/lib/market-data/integration.test.ts`

**Interfaces:**
- Consumes: `nearestDoorplate(index, coordinate)`, `LocationEvidence.uncertaintyMeters` as the nearest-doorplate distance, and `PreMarketEnrichedListing.reliability.coordConsistent`.
- Produces: `SubjectLocationEvidence.verdict` extended to `'matched' | 'uncertain' | 'conflict' | 'unavailable'`; reasons `listing-coordinate-near-doorplate`, `listing-coordinate-doorplate-distance-uncertain`, and `listing-coordinate-doorplate-unavailable`.

- [ ] **Step 1: Add failing integration tests for accepted unresolved addresses**

Add fixture-based tests to `integration.test.ts` that mutate a cloned doorplate index so an unresolved address with a different road name has a nearest official doorplate at literal distances representative of 25.5 m, 37.6 m, and exactly 100 m. Assert:

```ts
assert.equal(result.marketEstimate.subjectLocationEvidence?.verdict, 'matched');
assert.ok(result.marketEstimate.unavailableReasons.every((reason) =>
  reason !== 'listing-coordinate-address-conflict'
  && reason !== 'listing-address-location-unresolved'));
assert.notEqual(result.marketEstimate.status, 'unavailable');
assert.equal(result.marketScenarios.subjectLocationEvidence?.nearestDoorplate.method, 'nearest-doorplate');
assert.equal(result.marketEstimate.subjectLocationEvidence?.address.matchedAddress, null);
```

Use hand-derived coordinates/distances and real `attachMarketEstimates`; do not mock the location functions. The null forward `matchedAddress` is the observable guard that prevents the existing scenario call from receiving an exact-building address.

- [ ] **Step 2: Run the accepted-location tests and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern='coordinate-near-doorplate|100-metre' scripts/lib/market-data/integration.test.ts
```

Expected: FAIL because unresolved cross-road addresses currently become `listing-coordinate-address-conflict` or `listing-address-location-unresolved`.

- [ ] **Step 3: Add failing boundary and failure-mode tests**

Add real-behavior cases for:

```ts
// 100 < distance <= 300
assert.equal(evidence?.verdict, 'uncertain');
assert.equal(result.marketEstimate.status, 'review');
assert.ok(result.marketEstimate.unavailableReasons.includes(
  'listing-coordinate-doorplate-distance-uncertain',
));

// no doorplate within 300
assert.equal(evidence?.verdict, 'unavailable');
assert.equal(result.marketEstimate.status, 'unavailable');
assert.deepEqual(result.marketEstimate.unavailableReasons, [
  'listing-coordinate-doorplate-unavailable',
]);

// resolved forward address > 300 remains a genuine conflict
assert.equal(conflictEvidence?.verdict, 'conflict');
assert.ok(conflictResult.marketEstimate.unavailableReasons.includes(
  'listing-coordinate-address-conflict',
));
```

Retain or adapt the existing unreliable-coordinate test so `coordConsistent: false` stays unavailable. Add a `coordConsistent: null` case if the type permits it; it must not become matched.

- [ ] **Step 4: Run the new boundary tests and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern='doorplate distance|doorplate unavailable|wrong-neighborhood|unreliable GPS' scripts/lib/market-data/integration.test.ts
```

Expected: FAIL on the new verdicts/reasons while the existing genuine-conflict and unreliable-coordinate assertions remain green.

- [ ] **Step 5: Implement the minimal tiered classifier**

In `types.ts`, extend the verdict union with `unavailable`. In `steps.ts`, define:

```ts
const LISTING_LOCATION_ACCEPT_M = 100;
const LISTING_LOCATION_TOLERANCE_M = 300;
```

For `address.method === 'unresolved'`, require coordinate consistency and administrative agreement, then classify `reverse.uncertaintyMeters`:

```ts
if (reverse.method === 'unresolved' || reverse.uncertaintyMeters === null) {
  return evidence('unavailable', ['listing-coordinate-doorplate-unavailable']);
}
if (reverse.uncertaintyMeters <= LISTING_LOCATION_ACCEPT_M) {
  return evidence('matched', ['listing-coordinate-near-doorplate']);
}
return evidence('uncertain', ['listing-coordinate-doorplate-distance-uncertain']);
```

Remove the unresolved-address road-name conflict branch. Preserve forward exact/range behavior and the existing `>300 m` forward-distance conflict. Treat `unavailable` like `conflict` in `attachMarketEstimates`, producing no estimate or scenarios. Keep `address` as the unresolved forward evidence and `nearestDoorplate` as proximity evidence so scenario `matchedAddress` remains `null`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node --import tsx --test scripts/lib/market-data/integration.test.ts scripts/lib/market-data/scenario-estimator.test.ts
```

Expected: all tests pass with pristine output.

- [ ] **Step 7: Run the full suite and commit**

Run:

```bash
npm test
npx tsc --noEmit
```

Expected: both commands exit 0 with no failures.

Commit:

```bash
git add scripts/lib/market-data/types.ts scripts/lib/steps.ts scripts/lib/market-data/integration.test.ts scripts/lib/market-data/scenario-estimator.test.ts
git commit -m "feat: accept nearby doorplate location evidence"
```

### Task 2: Render Useful Official Market Summaries

**Files:**
- Modify: `docs/reporting-rules.md`
- Modify: `prompts/daily-run.md`
- Modify: `profiles/example-investment/evaluation.md`
- Modify: `profiles/example-owner-occupied/evaluation.md`
- Test: `scripts/lib/notification-template.test.ts`

**Interfaces:**
- Consumes: authoritative `marketEstimate.marketUnitPriceMedian`, `marketEstimate.comparables`, `marketEstimate.status`, and `marketEstimate.unavailableReasons`.
- Produces: deterministic `market_summary_line` instructions for reliable, review-with-value, and unavailable-without-value cases.

- [ ] **Step 1: Add failing notification-contract assertions**

Extend the active instruction contract test to require the shared rules and worker prompt to describe these observable output shapes:

```text
官方成交中位約 56.4 萬/坪（13 筆可比）
官方成交中位約 56.4 萬/坪（13 筆可比；地址定位待確認）
官方行情無法估算：座標附近無可驗證門牌。
```

Assert that instructions require one-decimal rounding, `comparables.length`, one concise review limitation, and no P25–P75 in `report.md`.

- [ ] **Step 2: Run the notification test and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern='active report instructions' scripts/lib/notification-template.test.ts
```

Expected: FAIL because current rules tell review/unavailable output to show only a reason.

- [ ] **Step 3: Update shared and profile report instructions**

Replace the old reliable-only display rule with:

```md
- When `marketUnitPriceMedian` is non-null, render `官方成交中位約 {median rounded to 1 decimal} 萬/坪（{comparables.length} 筆可比{review limitation, when applicable}）`.
- A `review` value retains exactly one concise human-readable limitation and never becomes recommendation-eligible merely because a value exists.
- When the median is null, render only a concise unavailable reason.
```

Document the coordinate distance bands and clarify that an incomplete road-name mismatch within the accepted band is not a warning. Keep P25–P75, raw status/confidence/stage/dates, and complete reasons local. Apply the same contract to both committed example profiles and `prompts/daily-run.md`.

- [ ] **Step 4: Run focused and full tests, then commit**

Run:

```bash
node --import tsx --test scripts/lib/notification-template.test.ts
npm test
```

Expected: all tests pass with pristine output.

Commit:

```bash
git add docs/reporting-rules.md prompts/daily-run.md profiles/example-investment/evaluation.md profiles/example-owner-occupied/evaluation.md scripts/lib/notification-template.test.ts
git commit -m "docs: show official values for review estimates"
```

### Task 3: Advance the Policy Contract and Publish Safely

**Files:**
- Modify: `scripts/lib/market-data/config.ts`
- Modify: `scripts/lib/market-data/config.test.ts`
- Modify: `scripts/lib/market-data/store.test.ts`
- Modify: `AGENTS.md`
- Modify: `docs/market-data.md`
- Modify: `docs/reporting-rules.md`
- Modify: `prompts/daily-run.md`

**Interfaces:**
- Consumes: completed Tasks 1–2 and the existing schema-5 / acceptance-schema-3 atomic publication path.
- Produces: active and candidate estimator policy version `8`, current operational documentation, and a validated local schema-5/policy-8 market-data pair.

- [ ] **Step 1: Change contract tests to require policy 8 and verify RED**

Change only current-contract assertions:

```ts
assert.equal(ESTIMATOR_POLICY_VERSION, 8);
assert.equal(CANDIDATE_ESTIMATOR_POLICY_VERSION, 8);
assert.equal(MARKET_SCHEMA_VERSION, 5);
assert.equal(CANDIDATE_MARKET_SCHEMA_VERSION, 5);
```

Do not rewrite historical compatibility fixtures or historical specs/plans.

Run:

```bash
node --import tsx --test scripts/lib/market-data/config.test.ts scripts/lib/market-data/store.test.ts
```

Expected: FAIL because production constants remain 7.

- [ ] **Step 2: Advance both policy constants and active documentation**

Set both policy constants in `config.ts` to `8`. Update live documentation and prompts from policy 7 to policy 8 where they describe the active contract; retain schema 5 and acceptance schema 3. Record that the bump covers listing-location status/eligibility semantics and requires atomic writer publication.

- [ ] **Step 3: Run contract tests and verify GREEN**

Run:

```bash
node --import tsx --test scripts/lib/market-data/config.test.ts scripts/lib/market-data/store.test.ts
```

Expected: all tests pass with pristine output.

- [ ] **Step 4: Run repository verification**

Run:

```bash
npm test
npx tsc --noEmit
rg -n 'policy-7|Policy-7|ESTIMATOR_POLICY_VERSION = 7|CANDIDATE_ESTIMATOR_POLICY_VERSION = 7' AGENTS.md docs prompts scripts profiles --glob '!docs/superpowers/**'
```

Expected: tests and type checking exit 0. The search returns no live policy-7 contract; historical `docs/superpowers/**` records remain unchanged.

- [ ] **Step 5: Commit the source contract before local publication**

```bash
git add scripts/lib/market-data/config.ts scripts/lib/market-data/config.test.ts scripts/lib/market-data/store.test.ts AGENTS.md docs/market-data.md docs/reporting-rules.md prompts/daily-run.md
git commit -m "feat: activate estimator policy 8"
```

- [ ] **Step 6: Refresh, gate, and atomically publish the local pair**

Run once and wait for completion:

```bash
npm run market-data -- update --city taipei
```

Expected: the writer reports every global, residential-use, Grade-B, and parking-family gate passing and atomically publishes a schema-5/policy-8 build plus matching aggregate acceptance. If any gate fails, stop and report the retained last-known-good pair; do not use inline profile refresh or weaken a gate.

- [ ] **Step 7: Verify the published pair and regression behavior**

Run:

```bash
npm run market-data -- backtest --city taipei
npm test
npx tsc --noEmit
```

Expected: gated backtest, full tests, and type checking all exit 0. Confirm the active manifest and acceptance both carry estimator policy version 8 without printing held-out rows, IDs, addresses, or credentials.
