# Notification Title and Map Link Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure `ai-notify` shows one release-style notification title and every rendered property with coordinates includes a clickable Google Maps link.

**Architecture:** Keep `--title` as the sole notification title and make `report.md` begin with the conclusion. Add a deterministic report-format validator to the pipeline's `mark report` boundary so a heading or a map-less walking line cannot be sent. Keep templates, worker instructions, shared rules, and failure details aligned with that enforced contract.

**Tech Stack:** TypeScript, Node.js `node:test`, Markdown templates, existing pipeline CLI.

## Global Constraints

- Do not send a real notification while testing.
- Do not expose credentials or commit ignored `state/` artifacts or local profiles.
- A map link uses `https://www.google.com/maps?q=<lat>,<lng>` and is omitted only when the report says `🚶 無位置資訊`.
- The report body starts with the conclusion; the notifier `--title` owns the only top-level summary title.

---

### Task 1: Enforce the report format at the send boundary

**Files:**
- Create: `scripts/lib/report-format.ts`
- Create: `scripts/lib/report-format.test.ts`
- Modify: `scripts/pipeline.ts`

**Interfaces:**
- Produces: `validateNotificationReport(report: string): void`.
- Consumes: the `report.md` body passed through `pipeline mark report --artifact`.

- [ ] **Step 1: Write failing tests**

Add real behavior tests proving that the validator rejects a first-line Markdown heading and rejects a rendered `- 🚶` line without `[地圖](https://www.google.com/maps?q=<lat>,<lng>)`, while accepting mapped lines and `🚶 無位置資訊`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test scripts/lib/report-format.test.ts`

Expected: FAIL because `report-format.ts` does not exist.

- [ ] **Step 3: Implement the minimal validator and pipeline integration**

Read the marked report artifact, call `validateNotificationReport`, and convert validation errors to the existing `BAD INPUT` failure before the manifest stores notify parameters.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --import tsx --test scripts/lib/report-format.test.ts scripts/lib/report-notify.test.ts`

Expected: PASS.

### Task 2: Make every report producer follow the same contract

**Files:**
- Modify: `profiles/example-investment/notify-template.md`
- Modify: `profiles/example-owner-occupied/notify-template.md`
- Modify: `scripts/lib/notification-template.test.ts`
- Modify: `scripts/lib/notify.ts`
- Modify: `scripts/lib/notify.test.ts`
- Modify: `docs/reporting-rules.md`
- Modify: `docs/notifications.md`
- Modify: `prompts/daily-run.md`

**Interfaces:**
- Consumes: the validator contract from Task 1.
- Produces: templates and failure details whose body starts with content rather than a duplicate heading.

- [ ] **Step 1: Write failing contract tests**

Require both templates to start with `{{conclusion}}`, require the worker prompt to state that `--title` is the only notification title and to check map links, and require failure details not to start with a Markdown heading.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --import tsx --test scripts/lib/notification-template.test.ts scripts/lib/notify.test.ts`

Expected: FAIL on the current body headings and failure heading.

- [ ] **Step 3: Apply the minimal producer changes**

Remove the report-heading row from both templates and from `renderFailDetails`. Update shared notification docs and the worker's report step/checklist to say that `--title` owns the title and every coordinate-backed walking line includes the clickable map link.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --import tsx --test scripts/lib/notification-template.test.ts scripts/lib/notify.test.ts scripts/lib/report-format.test.ts`

Expected: PASS.

### Task 3: Verify the production regression and full suite

**Files:**
- Read only: `state/runs/investment-taipei.local/2026-08-06/report.md`
- Local-only sync after integration: `profiles/investment-taipei.local/notify-template.md`, `profiles/owner-occupied-taipei.local/notify-template.md`

**Interfaces:**
- Consumes: the actual 2026-08-06 report supplied by the user.
- Produces: evidence that the old report is rejected for both observed defects and the corrected contract passes.

- [ ] **Step 1: Run the validator against the historical report**

Expected: the old report is rejected for a leading heading and missing map links. Do not edit or commit the ignored historical artifact.

- [ ] **Step 2: Run full verification**

Run: `npm test`

Run: `npx tsc --noEmit`

Expected: all tests pass and type checking exits 0.

- [ ] **Step 3: Review the diff and sync local templates after integration**

Confirm only notification-contract files changed. After merging to the main checkout, remove the heading row from both ignored local templates so the next scheduled run starts with the corrected format.
