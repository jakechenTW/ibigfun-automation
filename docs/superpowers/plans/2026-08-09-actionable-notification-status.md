# Actionable Notification Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow successful runs with fully supported recommendations or matches to use `ok`, while retaining `warn` for actionable uncertainty and stale run-level evidence.

**Architecture:** Keep listing classification fail-closed, but narrow the pipeline status gate to objective enriched-artifact integrity and stale-source checks. Bucket-aware status remains an agent report decision because the pipeline has no structured bucket artifact; shared docs and the daily worker prompt define that decision consistently.

**Tech Stack:** TypeScript, Node.js test runner, Markdown runbooks and profile policy.

## Global Constraints

- `fail` remains reserved for a monitor that cannot complete.
- A fully supported recommendation or match may use `ok`.
- A rendered candidate, risk item, unresolved actionable manual review, stale official source, or unverified filter mapping requires `warn`.
- Fresh `review` or `unavailable` evidence belonging only to a confirmed hard exclusion does not force `warn`.
- `review`, `unavailable`, low-confidence, stale, and inseparable-parking evidence still cannot support automatic recommendation or matching.
- Do not add a new report artifact, parse Markdown to infer buckets, change notifier transport, or rewrite historical runs.

---

### Task 1: Narrow the pipeline market-status gate

**Files:**
- Modify: `scripts/lib/report-notify.test.ts`
- Modify: `scripts/lib/report-notify.ts:49-84`

**Interfaces:**
- Consumes: `assertNotificationStatusAllowsMarketData(status: NotificationStatus, enriched: unknown): void`.
- Produces: the same public function signature, with fresh `review` and `unavailable` statuses accepted for `ok` after structural validation.

- [ ] **Step 1: Change the review test into the desired acceptance test**

Replace the current `rejects ok notification status when any listing needs market review` test with:

```ts
test('allows ok when fresh market review evidence is internally consistent', () => {
  assert.doesNotThrow(() => assertNotificationStatusAllowsMarketData('ok', {
    ...freshEnrichment,
    marketReliable: 0,
    marketReview: 1,
    listings: [{
      tenureGate: 'eligible',
      marketEstimate: { status: 'review', sourceFreshness: { transactionStale: false, doorplateStale: false } },
    }],
  }));
});
```

- [ ] **Step 2: Change the unavailable test into the second desired acceptance test**

Replace the current `rejects ok notification status when the market bundle was unavailable` test with:

```ts
test('allows ok when fresh unavailable market evidence is internally consistent', () => {
  assert.doesNotThrow(() => assertNotificationStatusAllowsMarketData('ok', {
    ...freshEnrichment,
    marketReliable: 0,
    marketUnavailable: 1,
    listings: [{
      tenureGate: 'eligible',
      marketEstimate: { status: 'unavailable', sourceFreshness: { transactionStale: false, doorplateStale: false } },
    }],
  }));
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern='allows ok when fresh (market review|unavailable market)' scripts/lib/report-notify.test.ts
```

Expected: both tests FAIL with `market review or unavailable evidence requires --status-notify warn, not ok`.

- [ ] **Step 4: Remove only the global review/unavailable rejection**

Delete this block from `assertNotificationStatusAllowsMarketData`:

```ts
if (actual.marketReview > 0 || actual.marketUnavailable > 0) {
  throw new Error('market review or unavailable evidence requires --status-notify warn, not ok');
}
```

Keep all artifact-shape, summary-consistency, per-listing market-field, tenure, valuation-review, and stale-source checks unchanged.

- [ ] **Step 5: Run the focused acceptance tests and verify GREEN**

Run:

```bash
node --import tsx --test --test-name-pattern='allows ok when fresh (market review|unavailable market)' scripts/lib/report-notify.test.ts
```

Expected: both tests PASS.

- [ ] **Step 6: Run all report-notification tests**

Run:

```bash
node --import tsx --test scripts/lib/report-notify.test.ts
```

Expected: all tests pass, including stale evidence, malformed evidence, summary mismatch, tenure validation, and valuation-review binding tests.

- [ ] **Step 7: Commit the behavior change**

```bash
git add scripts/lib/report-notify.test.ts scripts/lib/report-notify.ts
git commit -m "fix: scope notification warnings to actionable results"
```

---

### Task 2: Align active notification policy documentation

**Files:**
- Modify: `scripts/lib/notification-template.test.ts`
- Modify: `AGENTS.md:91-94,204-207`
- Modify: `docs/notifications.md:18-20`
- Modify: `docs/reporting-rules.md:252-275`
- Modify: `profiles/example-owner-occupied/evaluation.md:51-56`
- Modify: `prompts/daily-run.md:49-54`

**Interfaces:**
- Consumes: the status contract in `docs/superpowers/specs/2026-08-09-actionable-notification-status-design.md`.
- Produces: one consistent active policy for agents, scheduled workers, and profile evaluation.

- [ ] **Step 1: Add a documentation-contract test**

In `scripts/lib/notification-template.test.ts`, load `AGENTS.md` and `docs/notifications.md` beside the existing rule inputs, then add:

```ts
test('active notification policy separates result presence from warning conditions', () => {
  const statusRules = [agentsInstructions, notificationRules, ownerRules, workerPrompt].join('\n');
  assert.match(statusRules, /recommendations? or matches? may use `ok`/i);
  assert.match(statusRules, /candidate[^\n]*risk[^\n]*manual[^\n]*stale/i);
  assert.match(statusRules, /hard exclusion[^\n]*(?:does not|doesn't)[^\n]*(?:force|require) `warn`/i);
  assert.doesNotMatch(statusRules, /`warn`[^\n]*(?:recommendations?\/matches?|有推薦\/符合條件)/i);
});
```

- [ ] **Step 2: Run the documentation-contract test and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern='separates result presence' scripts/lib/notification-template.test.ts
```

Expected: FAIL because the active documents still say recommendations/matches require `warn`.

- [ ] **Step 3: Update the shared runbook**

In `AGENTS.md`, replace the global market-evidence status wording with:

```md
Any stale official market source requires notification status `warn`;
`pipeline mark report --status ok` rejects malformed or internally inconsistent
enriched market evidence and any stale official source. Fresh `review` or
`unavailable` evidence affects notification status only when it leaves an
actionable candidate or risk item after hard exclusions.
```

Replace the canonical status bullets with:

```md
- `--status warn`: candidates, risk listings, unresolved actionable manual review,
  stale or weak data affecting safe interpretation, login fallback, or unverified mappings.
- `--status ok`: a completed run with no unresolved actionable warning; fully supported recommendations/matches may use `ok`.
- `--status fail`: only when the monitor cannot complete.
```

- [ ] **Step 4: Update notifier, shared reporting, profile, and worker wording**

Apply the same contract in the remaining active documents:

```md
`ok` means the run completed without unresolved actionable warnings; it may contain fully supported recommendations or matches.
`warn` means candidates, risks, unresolved actionable manual review, stale sources, unverified mappings, or other weak evidence affects safe interpretation.
A fresh market review/unavailable result on a confirmed hard exclusion does not force `warn`.
```

Keep each file's existing language and formatting style. Do not alter classification gates or historical design documents.

- [ ] **Step 5: Run the documentation-contract test and verify GREEN**

Run:

```bash
node --import tsx --test --test-name-pattern='separates result presence' scripts/lib/notification-template.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run all notification-focused tests**

Run:

```bash
node --import tsx --test scripts/lib/report-notify.test.ts scripts/lib/notification-template.test.ts scripts/lib/notify.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit the policy alignment**

```bash
git add AGENTS.md docs/notifications.md docs/reporting-rules.md profiles/example-owner-occupied/evaluation.md prompts/daily-run.md scripts/lib/notification-template.test.ts
git commit -m "docs: distinguish notification health from results"
```

---

### Task 3: Full verification

**Files:**
- Verify only; no planned modifications.

**Interfaces:**
- Consumes: all behavior and documentation changes from Tasks 1-2.
- Produces: verified repository state with no test or whitespace regressions.

- [ ] **Step 1: Run the complete test suite**

Run:

```bash
npm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Check patch integrity**

Run:

```bash
git diff --check HEAD~2
git status --short
```

Expected: no whitespace errors; the worktree is clean after the two implementation commits.

- [ ] **Step 3: Review the final diff against the approved design**

Run:

```bash
git diff HEAD~2..HEAD -- scripts/lib/report-notify.ts scripts/lib/report-notify.test.ts scripts/lib/notification-template.test.ts AGENTS.md docs/notifications.md docs/reporting-rules.md profiles/example-owner-occupied/evaluation.md prompts/daily-run.md
```

Confirm that fresh `review`/`unavailable` no longer globally blocks `ok`, stale and structural checks remain, recommendations/matches may use `ok`, and candidate/risk/actionable uncertainty still requires `warn`.
