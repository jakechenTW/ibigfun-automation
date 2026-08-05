# Remove Asking Premium and Add a Profile Listing-Age Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all live asking-premium machinery and enforce a profile-configured 365-day recommendation limit across all four current profiles.

**Architecture:** Add a required `evaluation.maxDaysOnMarket` policy, derive a deterministic `tenureGate` during enrichment, and fail report completion closed when an old artifact lacks that gate. Keep official market-value evidence and its reliability semantics, while removing every asking-versus-market comparison from runtime output and current documentation.

**Tech Stack:** TypeScript 5.6, Node.js test runner, `tsx`, JSON profiles, Markdown rules/templates.

## Global Constraints

- All four current profiles set `evaluation.maxDaysOnMarket` to `365`.
- Day 365 is `eligible`; day 366 is `expired`; unknown tenure is `review`.
- `expired` is exclusion-only. `review` cannot be automatically recommended. Verified risk takes precedence over ordinary data review.
- Investment recommendation no longer compares asking price with official market value.
- Keep asking-price validity checks and official median/P25/P75 evidence. Do not change estimator selection, weighting, confidence, status, eligibility, backtest semantics, `ESTIMATOR_POLICY_VERSION`, or active market-data state.
- Remove `askingPremium*`, `askingPremiumPercent`, unused inverse `discountPercent`, `p*`, and negotiation-rate data from live code and current documentation.
- Keep valuation-review `differencePercent`; it compares external and official valuations.
- Historical files under `docs/superpowers/` are excluded from live-reference cleanup.
- Use TDD for every behavior change and make focused commits.

---

### Task 1: Make Listing-Age Policy Part of the Profile Contract

**Files:**
- Modify: `scripts/lib/profiles.ts`
- Modify: `scripts/lib/profiles.test.ts`
- Modify: `profiles/example-investment/profile.json`
- Modify: `profiles/example-owner-occupied/profile.json`
- Modify locally: `profiles/investment-taipei.local/profile.json`
- Modify locally: `profiles/owner-occupied-taipei.local/profile.json`
- Modify: `profiles/README.md`

**Interfaces:**
- Produces `ProfileEvaluation { maxDaysOnMarket: number }`
- Produces `Profile.evaluation: ProfileEvaluation`
- Produces `parseProfile(id: string, parsed: unknown): Profile`
- Preserves fetch-only CLI overrides

- [ ] **Step 1: Add failing schema tests**

Import `parseProfile` in `profiles.test.ts` and add:

```ts
test('loadProfile reads required listing-age policy', () => {
  assert.equal(loadProfile('example-investment').evaluation.maxDaysOnMarket, 365);
  assert.equal(loadProfile('example-owner-occupied').evaluation.maxDaysOnMarket, 365);
});

test('parseProfile rejects invalid maxDaysOnMarket', () => {
  const base = { displayName: 'x', fetch: {}, evaluation: { maxDaysOnMarket: 365 } };
  assert.throws(() => parseProfile('x', { ...base, evaluation: undefined }), /evaluation must be an object/);
  assert.throws(() => parseProfile('x', { ...base, evaluation: {} }), /non-negative integer/);
  assert.throws(() => parseProfile('x', { ...base, evaluation: { maxDaysOnMarket: -1 } }), /non-negative integer/);
  assert.throws(() => parseProfile('x', { ...base, evaluation: { maxDaysOnMarket: 1.5 } }), /non-negative integer/);
  assert.throws(() => parseProfile('x', { ...base, evaluation: { maxDaysOnMarket: '365' } }), /non-negative integer/);
});

test('fetch overrides preserve evaluation policy', () => {
  const p = resolveProfileFromArgs(['--profile', 'example-investment', '--set', 'fetch.city=2']);
  assert.equal(p.fetch.city, '2');
  assert.equal(p.evaluation.maxDaysOnMarket, 365);
});
```

- [ ] **Step 2: Observe the intended failure**

Run: `node --import tsx --test scripts/lib/profiles.test.ts`

Expected: FAIL because the parser and field do not exist.

- [ ] **Step 3: Implement strict parsing**

Add to `profiles.ts`:

```ts
export interface ProfileEvaluation { maxDaysOnMarket: number; }

function assertEvaluation(value: unknown): ProfileEvaluation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid profile: evaluation must be an object');
  }
  const maxDaysOnMarket = (value as Record<string, unknown>).maxDaysOnMarket;
  if (typeof maxDaysOnMarket !== 'number' || !Number.isSafeInteger(maxDaysOnMarket) || maxDaysOnMarket < 0) {
    throw new Error('invalid profile: evaluation.maxDaysOnMarket must be a non-negative integer');
  }
  return { maxDaysOnMarket };
}

export function parseProfile(id: string, parsed: unknown): Profile {
  const o = parsed as Record<string, unknown>;
  return {
    id,
    displayName: assertString(o.displayName, 'displayName'),
    fetch: assertFetch(o.fetch),
    evaluation: assertEvaluation(o.evaluation),
  };
}
```

Add `evaluation` to `Profile`, and make `loadProfile` reuse `parseProfile`.

- [ ] **Step 4: Set all four profiles**

Add after `displayName` in every current profile:

```json
"evaluation": { "maxDaysOnMarket": 365 },
```

Keep both `.local` edits ignored and uncommitted.

- [ ] **Step 5: Document the schema**

Update `profiles/README.md` examples and schema table. Declare the field required, a non-negative integer, inclusive, and unavailable to `--set`/`--unset`.

- [ ] **Step 6: Verify and commit**

Run: `node --import tsx --test scripts/lib/profiles.test.ts`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: only existing `Profile` literals without `evaluation` fail; Task 2 fixes them without weakening the type.

```bash
git add scripts/lib/profiles.ts scripts/lib/profiles.test.ts profiles/example-investment/profile.json profiles/example-owner-occupied/profile.json profiles/README.md
git commit -m "feat: add profile listing age policy"
```

---

### Task 2: Derive and Persist the Deterministic Tenure Gate

**Files:**
- Create: `scripts/lib/tenure-gate.ts`
- Create: `scripts/lib/tenure-gate.test.ts`
- Modify: `scripts/lib/types.ts`
- Modify: `scripts/lib/walk.ts`
- Modify: `scripts/lib/walk.test.ts`
- Modify: `scripts/lib/steps.ts`
- Modify: `scripts/lib/steps.test.ts`
- Modify other test-only `Profile` literals identified by type checking

**Interfaces:**
- Produces `TenureGate = 'eligible' | 'expired' | 'review'`
- Produces `classifyTenureGate(daysOnMarket: number | null, maxDaysOnMarket: number): TenureGate`
- Produces `EnrichedListing.tenureGate`
- Produces `tenureEligible`, `tenureExpired`, and `tenureReview` summary counts

- [ ] **Step 1: Write failing classifier tests**

Create `tenure-gate.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTenureGate } from './tenure-gate.ts';

test('listing-age gate has an inclusive maximum', () => {
  assert.equal(classifyTenureGate(0, 365), 'eligible');
  assert.equal(classifyTenureGate(365, 365), 'eligible');
  assert.equal(classifyTenureGate(366, 365), 'expired');
});

test('unknown tenure requires review', () => {
  assert.equal(classifyTenureGate(null, 365), 'review');
});
```

- [ ] **Step 2: Observe failure and implement**

Run: `node --import tsx --test scripts/lib/tenure-gate.test.ts`

Expected: FAIL because the module is missing.

Create `tenure-gate.ts`:

```ts
export type TenureGate = 'eligible' | 'expired' | 'review';

export function classifyTenureGate(daysOnMarket: number | null, maxDaysOnMarket: number): TenureGate {
  if (daysOnMarket === null) return 'review';
  return daysOnMarket <= maxDaysOnMarket ? 'eligible' : 'expired';
}
```

- [ ] **Step 3: Add failing enrichment assertions**

Change `finalizeWalk` tests to pass:

```ts
const policy = { targetDate: '2026-06-26', maxDaysOnMarket: 365 };
```

Add history cases yielding exactly 365 and 366 days, plus no history, and assert `eligible`, `expired`, and `review`.

- [ ] **Step 4: Attach the profile-aware gate**

Change `finalizeWalk` to:

```ts
export function finalizeWalk(
  o: OfflineEnriched,
  routed: (number | null)[] | null,
  options: { targetDate: string; maxDaysOnMarket: number },
): PreMarketEnrichedListing
```

Compute tenure once, then return:

```ts
tenure,
tenureGate: classifyTenureGate(tenure.daysOnMarket, options.maxDaysOnMarket),
```

Add `tenureGate` and the three root counts to `types.ts`. In `steps.ts`, pass `range.to` and `profile.evaluation.maxDaysOnMarket`, compute all three counts, and include them in the artifact, step summary, and journal.

- [ ] **Step 5: Repair required Profile fixtures**

Add `evaluation: { maxDaysOnMarket: 365 }` to `steps.test.ts` and any other test-only `Profile` literals. Extend the empty-run expected summary with three zero tenure counts.

- [ ] **Step 6: Verify and commit**

Run: `node --import tsx --test scripts/lib/tenure-gate.test.ts scripts/lib/walk.test.ts scripts/lib/steps.test.ts`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: PASS.

```bash
git add scripts/lib/tenure-gate.ts scripts/lib/tenure-gate.test.ts scripts/lib/types.ts scripts/lib/walk.ts scripts/lib/walk.test.ts scripts/lib/steps.ts scripts/lib/steps.test.ts
git commit -m "feat: derive profile-aware tenure gate"
```

---

### Task 3: Reject Legacy Enriched Artifacts at Report Completion

**Files:**
- Modify: `scripts/lib/report-notify.ts`
- Modify: `scripts/lib/report-notify.test.ts`
- Modify: `scripts/pipeline.ts`

**Interfaces:**
- Produces `assertValidTenureGates(enriched: unknown): void`
- Makes `validateReportEvidence` validate tenure for `ok`, `warn`, and `fail`
- Makes successful report marking always load `enriched.json`

- [ ] **Step 1: Add failing fail-closed tests**

Give `freshEnrichment` matching root counts and `tenureGate: 'eligible'`. Add:

```ts
test('all report statuses reject legacy enrichment without tenureGate', () => {
  const legacy = { ...freshEnrichment, listings: [{ marketEstimate: freshEnrichment.listings[0].marketEstimate }] };
  for (const status of ['ok', 'warn', 'fail'] as const) {
    assert.throws(() => validateReportEvidence(status, legacy), /rerun enrich.*tenureGate/);
  }
});

test('tenure summary counts must match listing gates', () => {
  assert.throws(() => validateReportEvidence('warn', { ...freshEnrichment, tenureExpired: 1 }), /tenure summary counts must match listings/);
});
```

Update all other enriched fixtures with valid gates and counts.

- [ ] **Step 2: Observe failure and implement validation**

Run: `node --import tsx --test scripts/lib/report-notify.test.ts`

Expected: FAIL because tenure is not validated.

Implement `assertValidTenureGates`: require a listings array, non-negative safe-integer root counts, one valid gate per listing, and exact recomputed counts. Missing/invalid gates throw `rerun enrich: every listing requires a valid tenureGate`; disagreement throws `tenure summary counts must match listings`.

Call it first in `validateReportEvidence`.

- [ ] **Step 3: Always load enrichment**

In `pipeline.ts`, remove the `sNotify === 'ok' || hasValuationReview` condition. Every `mark report --status ok` requires and parses `enriched.json`, then calls `validateReportEvidence`. Do not change `pipeline fail`.

- [ ] **Step 4: Verify and commit**

Run: `node --import tsx --test scripts/lib/report-notify.test.ts`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: PASS.

```bash
git add scripts/lib/report-notify.ts scripts/lib/report-notify.test.ts scripts/pipeline.ts
git commit -m "fix: reject reports built from legacy enrichment"
```

---

### Task 4: Remove Premium Fields Without Changing Valuation Semantics

**Files:**
- Modify: `scripts/lib/finance.ts`
- Modify: `scripts/lib/finance.test.ts`
- Modify: `scripts/lib/market-data/types.ts`
- Modify: `scripts/lib/market-data/estimator.ts`
- Modify: `scripts/lib/market-data/estimator.test.ts`
- Modify: `scripts/lib/market-data/scenario-estimator.ts`
- Modify: `scripts/lib/market-data/scenario-estimator.test.ts`
- Modify: `scripts/lib/steps.ts`

**Interfaces:**
- Removes both percent helper functions and three premium output fields
- Preserves asking-price subject fields and validity reasons
- Preserves all quantiles, evidence, confidence, status, and policy version

- [ ] **Step 1: Replace premium tests with absence tests**

Remove percent helper tests/imports from `finance.test.ts`. In `estimator.test.ts`, replace the premium-boundary test with one that asserts quantiles, reliable status, and:

```ts
assert.equal(Object.hasOwn(estimate, 'askingPremiumMedian'), false);
assert.equal(Object.hasOwn(estimate, 'askingPremiumConservative'), false);
```

Retain the missing/invalid asking-price status assertions, deleting only the premium-null assertion. Rename the scenario invalid-total test and retain `status === 'review'`, plus:

```ts
assert.equal(Object.hasOwn(result.scenarios[0]!, 'askingPremiumConservative'), false);
```

- [ ] **Step 2: Observe the intended failure**

Run: `node --import tsx --test scripts/lib/finance.test.ts scripts/lib/market-data/estimator.test.ts scripts/lib/market-data/scenario-estimator.test.ts`

Expected: FAIL because estimates still own premium keys.

- [ ] **Step 3: Remove calculations and fields**

Delete `discountPercent`, `askingPremiumPercent`, their estimator imports, the premium fields in `market-data/types.ts`, all premium return properties, and null premium placeholders in `steps.ts`. Keep `askingUnitPriceWan`, `askingTotalPriceNtd`, `invalid-asking-unit-price`, and `invalid-asking-total-price` unchanged.

- [ ] **Step 4: Verify semantics and commit**

Run: `node --import tsx --test scripts/lib/finance.test.ts scripts/lib/market-data/*.test.ts scripts/lib/steps.test.ts`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: PASS.

Run: `git diff -- scripts/lib/market-data/config.ts`

Expected: no output.

```bash
git add scripts/lib/finance.ts scripts/lib/finance.test.ts scripts/lib/market-data/types.ts scripts/lib/market-data/estimator.ts scripts/lib/market-data/estimator.test.ts scripts/lib/market-data/scenario-estimator.ts scripts/lib/market-data/scenario-estimator.test.ts scripts/lib/steps.ts
git commit -m "refactor: remove asking premium outputs"
```

---

### Task 5: Rewrite Profile Rules and Notification Templates

**Files:**
- Modify: `profiles/example-investment/evaluation.md`
- Modify: `profiles/example-investment/notify-template.md`
- Modify: `profiles/example-owner-occupied/evaluation.md`
- Modify: `profiles/example-owner-occupied/notify-template.md`
- Modify corresponding ignored `.local` rule/template files
- Modify: `docs/reporting-rules.md`

**Interfaces:**
- Investment buckets: `推薦物件`, `候選／資料待確認`, `風險物件／待查`, `排除物件`
- Owner buckets: `符合條件`, `候選／資料待確認`, `風險物件／待查`, `排除摘要`

- [ ] **Step 1: Rewrite shared tenure and valuation rules**

Replace the information-only tenure statement with:

```md
- `eligible`: continue through the selected profile's remaining criteria.
- `expired`: exclude; never recommend or place in a candidate bucket.
- `review`: never auto-recommend; place a clean listing in `候選／資料待確認`.
- A suspicious/likely-auction or other verified risk verdict takes precedence and goes to `風險物件／待查`.
```

Require quick-summary expired/review counts. Remove premium formulas, thresholds, P25 premium gating, median-only boundary language, and premium-specific non-freehold correction. Keep ownership incompatibility as a data-quality/risk rule.

- [ ] **Step 2: Rewrite investment rules and template**

Recommendation requires `eligible`, accepted region/walk, `clean`, reliable and fresh market data, non-low confidence, and passing parking/ownership/use quality. Candidate means only resolvable data uncertainty. Risk means suspicious/likely-auction or material ownership/use/info risk. Exclusion includes expired and other hard failures. Sort known tenure ascending, then total price ascending; unknown tenure is candidate-only and last.

In the template add `{{tenure_expired_count}}` and `{{tenure_review_count}}`; rename `接近門檻` data to `candidate_count`, `candidates`, and `candidate_reason`; remove `premium_percent` and threshold copy; rename risk heading; preserve official evidence, mortgage, rent, and cash flow.

- [ ] **Step 3: Rewrite owner rules and template**

Add the same tenure precedence. Rename candidate headings to `候選／資料待確認`. Add quick-summary `risk_count` and a `### ⚠️ 風險物件／待查` loop using linked title, tenure, signals, market evidence, `risk_reason`, confidence, and detail-page status. Keep expired in exclusion summary.

- [ ] **Step 4: Synchronize ignored local profile files**

Apply the same family rules and template vocabulary to both `.local` profiles while preserving their private profile wording. Do not stage them.

- [ ] **Step 5: Verify and commit**

Run:

```bash
rg -n "開價溢價|asking premium|premium_percent|p\*/2|溢價 >|溢價 ≤|接近門檻" docs/reporting-rules.md profiles --glob '!*.local/**'
```

Expected: no output.

Run:

```bash
rg -n "tenure_expired_count|tenure_review_count|候選／資料待確認|風險物件／待查" profiles/example-* docs/reporting-rules.md
```

Expected: both profile families and shared rules appear.

```bash
git add profiles/example-investment/evaluation.md profiles/example-investment/notify-template.md profiles/example-owner-occupied/evaluation.md profiles/example-owner-occupied/notify-template.md docs/reporting-rules.md
git commit -m "docs: replace premium buckets with tenure policy"
```

---

### Task 6: Remove Live Negotiation-Rate References

**Files:**
- Modify: `AGENTS.md`
- Modify: `prompts/daily-run.md`
- Modify: `docs/market-data.md`
- Modify: `docs/fetching.md`
- Modify: `data/README.md`
- Delete: `data/negotiation-rate.md`
- Modify any additional current non-historical docs found by audit

**Interfaces:**
- Documents the profile policy, tenure gate, new buckets, and evidence-only role of official valuation

- [ ] **Step 1: Update the runbook and headless prompt**

In `AGENTS.md`, describe `profile.json` as `displayName + evaluation + fetch`; apply `tenureGate` before recommendations; make expired exclusion-only and review candidate/risk-only; describe official values as context plus reliability gates; remove P25 premium and negotiation-rate instructions.

In `prompts/daily-run.md`, use this rule:

```md
先依 profile 的 `evaluation.maxDaysOnMarket` 與 enriched `tenureGate` 判斷刊登年限；`expired` 排除，`review` 不得自動推薦。官方行情保留為成交證據與可靠性閘門，不再與開價計算溢價或決定划算程度。
```

- [ ] **Step 2: Update data documentation**

In `docs/market-data.md`, remove `askingPremiumConservative`; retain median/P25/P75, confidence, freshness, and comparable evidence. In `docs/fetching.md`, say empty/failed history yields `review`. Delete `data/negotiation-rate.md` and remove its index section from `data/README.md`.

- [ ] **Step 3: Audit live references**

Run:

```bash
rg -n -i "askingPremium|asking premium|premium_percent|開價溢價|典型開價溢價|p\*/2|negotiation-rate|議價率" . --glob '!docs/superpowers/**' --glob '!state/**' --glob '!.git/**'
```

Expected: no output.

- [ ] **Step 4: Verify all four profiles and the full repository**

Run:

```bash
node --import tsx --input-type=module -e "import { loadProfile } from './scripts/lib/profiles.ts'; for (const id of ['example-investment','example-owner-occupied','investment-taipei.local','owner-occupied-taipei.local']) { const p = loadProfile(id); if (p.evaluation.maxDaysOnMarket !== 365) throw new Error(id); console.log(id, p.evaluation.maxDaysOnMarket); }"
npm test
npx tsc --noEmit
git diff --check
```

Expected: four profile lines ending in `365`; all tests pass; type checking exits 0; no whitespace errors.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md prompts/daily-run.md docs/market-data.md docs/fetching.md data/README.md data/negotiation-rate.md
git commit -m "docs: remove premium mechanism from runbook"
```

---

### Task 7: Final Requirements Audit

**Files:**
- Verify only; fix the smallest owning file if an audit reveals a miss

**Interfaces:**
- Produces a clean, tested repository and implementation handoff

- [ ] **Step 1: Check every acceptance criterion**

Confirm: four limits equal 365; 365/366/null map correctly; all report statuses reject missing gates; expired/review/risk precedence is consistent; premium output is absent; policy version and market-data indexes are untouched.

- [ ] **Step 2: Rerun final verification**

Run:

```bash
npm test
npx tsc --noEmit
git diff --check
git status --short
```

Expected: tests and types pass, no whitespace errors, and no uncommitted tracked implementation changes.

- [ ] **Step 3: Inspect commits and prepare handoff**

Run: `git log --oneline -8`

Report the four limits, bucket vocabulary, exact verification results, ignored local-file updates, and confirmation that no policy bump or market-data refresh was required.
