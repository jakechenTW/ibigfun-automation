# Concise ai-notify Message Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make investment, owner-occupied, and failure notifications concise and decision-first without changing evaluation, enrichment, status gates, or notifier transport.

**Architecture:** Keep `report.md` as the single user-facing `ai-notify --details-file` artifact and simplify both profile templates at the source. Add static template-contract tests so required decision fields cannot drift back toward verbose operational output. Keep the notifier argv unchanged, but render failure details from a deterministic step-to-guidance mapping instead of copying journal lines.

**Tech Stack:** TypeScript 5.6, Node.js test runner, Markdown profile templates, existing `ai-notify` shell notifier.

## Global Constraints

- Do not change fetch, enrich, market estimation, tenure, route, bucketing, sorting, or `ok`/`warn`/`fail` selection semantics.
- Do not remove mortgage, rent, or cash-flow computation; remove those fields only from notification output.
- Do not compare asking price with official evidence to decide whether a listing is a deal, bucket, risk, sort order, or exclusion.
- Keep every recommended/matched, candidate, and risk listing visible; never cap or silently truncate candidates.
- Summarize exclusions by current valid hard reason and count; never list excluded properties individually.
- Keep the canonical notifier argv exactly `--tool`, `--status`, `--task`, `--title`, and `--details-file`.
- Keep complete official evidence, valuation review, manifest, and journal data local; never expose credentials, raw stack traces, or journal events in notifications.
- Preserve a single compact external-valuation review conclusion when an external review affects a bucket; do not expose the raw response or comparables.
- Treat the approximately 3,500-Chinese-character target as a soft compactness goal; complete action buckets take precedence.

---

## File Responsibility Map

- `profiles/example-investment/notify-template.md`: tracked investment notification structure.
- `profiles/example-owner-occupied/notify-template.md`: tracked owner-occupied notification structure.
- `profiles/*/evaluation.md`: profile-specific field, bucket, and sorting instructions used by the report-writing agent.
- `docs/reporting-rules.md`: shared notification field composition, missing-data, market-summary, and exclusion rules.
- `scripts/lib/notification-template.test.ts`: static contract preventing verbose or unsafe template regressions.
- `scripts/lib/notify.ts`: notifier argv plus concise failure-title/body composition.
- `scripts/lib/notify.test.ts`: notifier and failure-format unit tests.
- `scripts/pipeline.ts`: passes profile display name and default failure title to the failure renderer.
- `docs/notifications.md`: notifier transport and user-facing body contract.
- `AGENTS.md`: daily-run and failure-path operator instructions.
- `profiles/investment-taipei.local/` and `profiles/owner-occupied-taipei.local/`: ignored local profiles that receive formatting-only synchronization while retaining personal filters and criteria.

### Task 1: Lock and implement concise profile templates

**Files:**
- Create: `scripts/lib/notification-template.test.ts`
- Modify: `profiles/example-investment/notify-template.md:1-end`
- Modify: `profiles/example-owner-occupied/notify-template.md:1-end`
- Modify, ignored: `profiles/investment-taipei.local/notify-template.md:1-end`
- Modify, ignored: `profiles/owner-occupied-taipei.local/notify-template.md:1-end`

**Interfaces:**
- Consumes: existing agent-filled Mustache-style placeholders and bucket names.
- Produces: `{{status_icon}}`, `{{headline}}`, `{{data_warning}}`, and `{{market_summary_line}}` presentation contracts; continues to use `{{walk_line}}`, `{{tenure_line}}`, and existing bucket-reason placeholders.

- [ ] **Step 1: Write the failing static contract test**

Create `scripts/lib/notification-template.test.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const investment = readFileSync(
  new URL('../../profiles/example-investment/notify-template.md', import.meta.url),
  'utf8',
);
const owner = readFileSync(
  new URL('../../profiles/example-owner-occupied/notify-template.md', import.meta.url),
  'utf8',
);

function occurrences(text: string, token: string): number {
  return text.split(token).length - 1;
}

function assertCommonContract(template: string): void {
  assert.match(template, /\{\{status_icon\}\}/);
  assert.match(template, /\{\{headline\}\}/);
  assert.match(template, /\{\{data_warning\}\}/);
  assert.equal(occurrences(template, '{{walk_line}}'), 3);
  assert.equal(occurrences(template, '{{tenure_line}}'), 3);
  assert.equal(occurrences(template, '{{market_summary_line}}'), 3);
  assert.match(template, /\{\{unit_price\}\} 萬\/坪/);
  assert.match(template, /### 排除摘要/);
  assert.doesNotMatch(template, /\{\{#each excluded\}\}/);
  assert.doesNotMatch(
    template,
    /monthly_mortgage|estimated_rent|monthly_cash_flow|房貸|月租|現金流|租金覆蓋率|market_p25_wan|market_p75_wan|selected_stage|market_confidence|official_source_date|ORS|cache|enrich/i,
  );
}

test('investment notification template is concise and decision-first', () => {
  assertCommonContract(investment);
  assert.match(investment, /### 推薦物件/);
  assert.match(investment, /### 候選／資料待確認/);
  assert.match(investment, /### ⚠️ 風險物件／待查/);
  assert.match(investment, /目標捷運站外.*out_of_region_count/s);
  assert.match(investment, /站內走路過遠.*in_region_too_far_count/s);
  assert.doesNotMatch(investment, /開價溢價|保守行情|p\*/i);
});

test('owner-occupied notification template keeps self-use decision fields', () => {
  assertCommonContract(owner);
  assert.match(owner, /### 符合條件/);
  assert.match(owner, /### 候選／資料待確認/);
  assert.match(owner, /### ⚠️ 風險物件／待查/);
  assert.match(owner, /格局 \{\{room\}\}房\{\{living_room\}\}廳\{\{bathroom\}\}衛/);
  assert.match(owner, /車位 \{\{parking\}\}/);
  assert.match(owner, /類型 \{\{type_layout\}\}/);
});
```

- [ ] **Step 2: Run the new test and verify the old templates fail**

Run:

```bash
node --import tsx --test scripts/lib/notification-template.test.ts
```

Expected: FAIL because the current templates lack `{{status_icon}}`,
`{{headline}}`, `{{data_warning}}`, and `{{market_summary_line}}`, still contain
financial/internal evidence fields, and investment still has an individual
excluded loop.

- [ ] **Step 3: Replace the tracked investment template**

Replace `profiles/example-investment/notify-template.md` with:

```markdown
## {{status_icon}} {{date}} 投資房源｜{{headline}}

{{conclusion}}

**新案 {{new_listing_count}}｜推薦 {{recommended_count}}｜候選 {{candidate_count}}｜風險 {{suspicious_count}}｜排除 {{excluded_count}}**

{{#if data_warning}}

> ⚠️ {{data_warning}}

{{/if}}

### 推薦物件

{{#if recommended}}

{{#each recommended}}

#### {{rank}}. [{{title}}]({{url}})

- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- {{walk_line}}
- {{tenure_line}}
- {{market_summary_line}}
{{#if valuation_review_line}}
- 覆核：{{valuation_review_line}}
{{/if}}
- 推薦：{{recommendation_reason}}
- 注意：{{risks_or_manual_checks}}

{{/each}}

{{else}}

- 今日無可直接推薦的物件。

{{/if}}

### 候選／資料待確認

{{#if candidates}}

{{#each candidates}}

#### {{rank}}. [{{title}}]({{url}})

- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- {{walk_line}}
- {{tenure_line}}
- {{market_summary_line}}
{{#if valuation_review_line}}
- 覆核：{{valuation_review_line}}
{{/if}}
- 下一步：{{manual_checks}}

{{/each}}

{{else}}

- 今日無候選物件。

{{/if}}

### ⚠️ 風險物件／待查

{{#if suspicious}}

{{#each suspicious}}

#### {{rank}}. [{{title}}]({{url}}) ｜ `{{suspicious_label}}`

- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- {{walk_line}}
- {{tenure_line}}
- {{market_summary_line}}
{{#if valuation_review_line}}
- 覆核：{{valuation_review_line}}
{{/if}}
- 風險：{{suspicious_reason}}（{{suspicious_confidence}}・{{detail_page_checked}}）

{{/each}}

{{else}}

- 今日無風險物件。

{{/if}}

### 排除摘要

- 目標捷運站外：{{out_of_region_count}} 筆
- 站內走路過遠：{{in_region_too_far_count}} 筆
- 刊登超過上限：{{tenure_expired_count}} 筆
- 其他硬性排除：{{other_hard_exclusion_count}} 筆
- 主要原因：{{main_exclusion_reasons}}
```

- [ ] **Step 4: Replace the tracked owner-occupied template**

Replace `profiles/example-owner-occupied/notify-template.md` with:

```markdown
## {{status_icon}} {{date}} 自住房源｜{{headline}}

{{conclusion}}

**新案 {{new_listing_count}}｜符合 {{matched_count}}｜候選 {{candidate_count}}｜風險 {{risk_count}}｜排除 {{excluded_count}}**

{{#if data_warning}}

> ⚠️ {{data_warning}}

{{/if}}

### 符合條件

{{#if matched}}

{{#each matched}}

#### {{rank}}. [{{title}}]({{url}})

- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
- {{walk_line}}
- {{tenure_line}}
- {{market_summary_line}}
{{#if valuation_review_line}}
- 覆核：{{valuation_review_line}}
{{/if}}
- 符合：{{strengths}}
- 下一步：{{manual_checks}}

{{/each}}

{{else}}

- 今日無符合條件的物件。

{{/if}}

### 候選／資料待確認

{{#if candidates}}

{{#each candidates}}

#### {{rank}}. [{{title}}]({{url}})

- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
- {{walk_line}}
- {{tenure_line}}
- {{market_summary_line}}
{{#if valuation_review_line}}
- 覆核：{{valuation_review_line}}
{{/if}}
- 下一步：{{manual_checks}}

{{/each}}

{{else}}

- 今日無候選物件。

{{/if}}

### ⚠️ 風險物件／待查

{{#if risks}}

{{#each risks}}

#### {{rank}}. [{{title}}]({{url}}) ｜ `{{risk_label}}`

- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
- {{walk_line}}
- {{tenure_line}}
- {{market_summary_line}}
{{#if valuation_review_line}}
- 覆核：{{valuation_review_line}}
{{/if}}
- 風險：{{risk_reason}}（{{risk_confidence}}・{{detail_page_checked}}）

{{/each}}

{{else}}

- 今日無風險物件。

{{/if}}

### 排除摘要

- 刊登超過上限：{{tenure_expired_count}} 筆
- 自住硬性條件不符：{{hard_criteria_excluded_count}} 筆
- 其他硬性排除：{{other_hard_exclusion_count}} 筆
- 主要原因：{{main_exclusion_reasons}}
```

- [ ] **Step 5: Synchronize the two present ignored local templates without losing personal settings**

Use `apply_patch` on the two known local templates. Give
`profiles/investment-taipei.local/notify-template.md` the investment structure
from Step 3, but preserve its non-example heading and its `price_segment=%2C2500`
search URL only if a search-link line remains. The concise design intentionally
removes that line, so no fetch URL is copied into the new body.

Give `profiles/owner-occupied-taipei.local/notify-template.md` the owner structure
from Step 4. Its current `7000 萬` criteria sentence disappears with the verbose
summary; do not modify `profile.json` or the criteria in `evaluation.md`.

Confirm the operation touched only each local `notify-template.md`; do not copy
tracked `profile.json` or the top criteria sections of local `evaluation.md`.

- [ ] **Step 6: Run the focused template contract**

Run:

```bash
node --import tsx --test scripts/lib/notification-template.test.ts
```

Expected: PASS, 2 tests and 0 failures.

Then run the same forbidden-field check against tracked and present local
templates:

```bash
rg -n '房貸|月租|現金流|租金覆蓋率|market_p25_wan|market_p75_wan|selected_stage|market_confidence|official_source_date|ORS|cache|enrich|開價溢價|保守行情|p\*|#each excluded' profiles/*/notify-template.md
```

Expected: no matches.

- [ ] **Step 7: Commit the tracked template contract and templates**

```bash
git add scripts/lib/notification-template.test.ts profiles/example-investment/notify-template.md profiles/example-owner-occupied/notify-template.md
git commit -m "feat: streamline profile notifications"
```

Do not stage ignored `profiles/*.local/` files.

### Task 2: Align shared and profile-specific report-writing rules

**Files:**
- Modify: `docs/reporting-rules.md:258-300` (`Notification Format`)
- Modify: `profiles/example-investment/evaluation.md:50-end` (`Notification Format`)
- Modify, ignored: `profiles/investment-taipei.local/evaluation.md:50-end`
- Modify: `profiles/example-owner-occupied/evaluation.md` (append `Notification Format`)
- Modify, ignored: `profiles/owner-occupied-taipei.local/evaluation.md` (append `Notification Format` without changing its districts or 7000 萬 limit)

**Interfaces:**
- Consumes: template placeholders established in Task 1 and existing enriched `walk`, `coordinate`, `tenure`, and `marketEstimate` evidence.
- Produces: deterministic agent instructions for `{{status_icon}}`, `{{headline}}`, `{{data_warning}}`, `{{market_summary_line}}`, optional segments, and exclusion summaries.

- [ ] **Step 1: Replace the shared notification-format rules with the concise contract**

Keep the existing walking and tenure composition facts, but rewrite the
`Notification Format` section so it states all of the following exact rules:

```markdown
## Notification Format

- `report.md` is the exact user-facing Markdown body sent to `ai-notify`; do not create a second notification artifact.
- Use `✅` for `ok`, `⚠️` for `warn`, and `❌` for `fail`. The title contains the date/range, profile purpose, and primary outcome.
- Pass the same concise status-icon/date/outcome wording through `pipeline mark report --title`; do not use a generic notifier title that disagrees with the report heading.
- Put one conclusion sentence first, followed by one compact count line. Render `data_warning` only when stale, weak, missing, or inconsistent data affects safe interpretation.
- List every positive, candidate, and risk property. Summarize excluded properties by valid hard reason and count; never list excluded properties individually.
- Every individually rendered property shows total price, area, asking unit price, profile-relevant basics, `walk_line`, `tenure_line`, `market_summary_line`, and one bucket reason or next action.
- Keep the current Google Maps coordinate-link and three-state walking composition. Apply it to positive, candidate, and risk buckets.
- Keep `今日上架`, known days on market plus `未降價`/`曾降價`/`曾調漲`, and `刊登天數待確認` fallbacks.
- Omit an unavailable optional segment instead of printing repeated `—`. Convert decision-relevant missing data into a short action phrase; never invent a value.
- Compose `market_summary_line` from authoritative `marketEstimate`: reliable evidence may show the official median and comparable count; review/unavailable evidence states the human-readable reason. Do not print raw status syntax, P25-P75, internal stage, raw confidence enum, source-check date, or the full reason list per property.
- Any stale official source remains visible in the top warning and affected listing, forces `warn`, and blocks an automatic positive bucket.
- A bounded external review that affects a bucket gets one compact review conclusion. It never overwrites official evidence and raw external content remains local.
- Never describe a listing as cheap, expensive, a deal, overpriced, suspicious, sorted, bucketed, or excludable from asking price versus official evidence.
- Do not show mortgage, rent, cash flow, financing assumptions, generic repeated manual-check lists, rule-source footers, route/cache/enrich counters, timestamps, internal event names, or raw stack traces.
- Keep a single notification around 3,500 Chinese characters when possible. Completeness of positive, candidate, and risk buckets takes precedence; never silently truncate.
```

Retain the existing shared safety and data-quality sections outside
`Notification Format`; do not change their decision semantics.

- [ ] **Step 2: Replace the investment profile's notification instructions**

Replace its current `Notification Format` section with:

```markdown
## Notification Format

- Use `notify-template.md` and the shared concise contract in `docs/reporting-rules.md`.
- Render all `推薦物件`, `候選／資料待確認`, and `風險物件／待查`; never render excluded listings individually.
- Sort each rendered bucket by known `daysOnMarket` ascending and then total price ascending. Unknown tenure follows known tenure; verified risk still remains in the risk bucket.
- Core facts are total price, area, asking unit price, floor, building age, and address/area when available.
- Show `walk_line`, `tenure_line`, `market_summary_line`, and one listing-specific recommendation, review action, or risk phrase.
- Mortgage, estimated rent, cash flow, rental coverage, and financing assumptions remain workflow data but do not appear in the notification.
- The exclusion summary separately counts target-station-outside, in-region-too-far, expired tenure, and other confirmed hard failures.
- Do not emit asking-premium, conservative-price threshold, P25 gate, `p*`, or price-versus-market deal language.
```

Apply the same section to
`profiles/investment-taipei.local/evaluation.md`; its earlier criteria are
currently identical, but still use a targeted section replacement rather than a
whole-file copy.

- [ ] **Step 3: Add owner-occupied notification instructions**

Append this section to both owner-occupied evaluation files:

```markdown
## Notification Format

- Use `notify-template.md` and the shared concise contract in `docs/reporting-rules.md`.
- Render all `符合條件`, `候選／資料待確認`, and `風險物件／待查`; never render excluded listings individually.
- Sort each rendered bucket by known `daysOnMarket` ascending and then total price ascending. Unknown tenure follows known tenure; verified risk still remains in the risk bucket.
- Core facts are total price, area, asking unit price, floor, building age, address/area, room layout, flat parking, and building type when available.
- Show `walk_line`, `tenure_line`, `market_summary_line`, and one listing-specific self-use fit, review action, or risk phrase.
- Do not show investment-only mortgage, rent, cash-flow, coverage, or financing fields.
- Put an unverified coded filter mapping in `data_warning`; it still forces `warn` and blocks a clean `ok` conclusion.
- Summarize the configured tenure limit, self-use hard-criteria failures, and other confirmed hard failures by count.
```

Do not edit the local owner's five-district allowlist or 7000 萬 limit.

- [ ] **Step 4: Verify documentation consistency**

Run:

```bash
rg -n '開價溢價|保守行情|p\*|逐筆列出.*排除|月租.*通知|現金流.*通知|房貸.*通知' AGENTS.md docs/reporting-rules.md profiles/*/evaluation.md profiles/*/notify-template.md
```

Expected: no active rule says price-versus-market affects a bucket, excluded
listings are rendered individually, or investment financial fields belong in a
notification. Historical text under `docs/superpowers/` is outside this check.

Run:

```bash
node --import tsx --test scripts/lib/notification-template.test.ts
```

Expected: PASS, 2 tests and 0 failures.

- [ ] **Step 5: Commit tracked report-writing rules**

```bash
git add docs/reporting-rules.md profiles/example-investment/evaluation.md profiles/example-owner-occupied/evaluation.md
git commit -m "docs: align concise report rules"
```

Do not stage ignored local profile files.

### Task 3: Replace journal-tail failure messages with safe guidance

**Files:**
- Modify: `scripts/lib/notify.test.ts:27-37`
- Modify: `scripts/lib/notify.ts:79-end`
- Modify: `scripts/pipeline.ts:221-236`
- Modify: `docs/notifications.md:1-end`
- Modify: `AGENTS.md` pipeline-fail description and safety/source-of-truth wording

**Interfaces:**
- Consumes: `JournalEvent[]`, `RunRange`, profile `displayName`, and the already-redacted operator reason.
- Produces: `defaultFailTitle(profileName: string, range: RunRange): string` and the retained `renderFailDetails(profileName: string, range: RunRange, reason: string, tail: JournalEvent[]): string` signature shape.

- [ ] **Step 1: Replace the old journal-tail test with failing concise-format tests**

In `scripts/lib/notify.test.ts`, replace the current
`renderFailDetails includes ... journal tail lines` test with:

```ts
import {
  composeNotifyArgs,
  composeNotifyCommand,
  defaultFailTitle,
  renderFailDetails,
} from './notify.ts';

test('renderFailDetails maps the stopped step without copying journal content', () => {
  const range = { from: '2026-06-20', to: '2026-06-25', label: '2026-06-20_2026-06-25' };
  const tail = [
    { ts: '2026-06-27T00:00:00.000Z', step: 'fetch', level: 'error', event: 'step.error', msg: 'fetch failed: boom' },
  ] as const;
  const md = renderFailDetails('iBigFun 台北自住房源監測', range, 'login blocked', tail as any);
  assert.match(md, /❌ 2026-06-20_2026-06-25 iBigFun 台北自住房源監測中斷/);
  assert.match(md, /中斷步驟：抓取房源/);
  assert.match(md, /原因：login blocked/);
  assert.match(md, /建議：確認 iBigFun 登入與連線狀態後，重新執行本次任務/);
  assert.doesNotMatch(md, /2026-06-27T00:00:00\.000Z|step\.error|fetch failed: boom|journal/);
});

test('renderFailDetails uses safe generic guidance when no step is known', () => {
  const range = { from: '2026-06-25', to: '2026-06-25', label: '2026-06-25' };
  const md = renderFailDetails('iBigFun 台北投資房源監測', range, 'operator stopped', []);
  assert.match(md, /中斷步驟：未知/);
  assert.match(md, /建議：查看本機 pipeline 狀態，排除原因後重新執行本次任務/);
});

test('defaultFailTitle includes status icon, range, and profile name', () => {
  const range = { from: '2026-06-25', to: '2026-06-25', label: '2026-06-25' };
  assert.equal(
    defaultFailTitle('iBigFun 台北投資房源監測', range),
    '❌ 2026-06-25 iBigFun 台北投資房源監測中斷',
  );
});
```

Move the existing import rather than creating a duplicate import declaration.

- [ ] **Step 2: Run the focused notifier test and verify it fails**

Run:

```bash
node --import tsx --test scripts/lib/notify.test.ts
```

Expected: FAIL because `defaultFailTitle` does not exist and the old renderer
copies journal lines.

- [ ] **Step 3: Implement deterministic failure guidance**

In `scripts/lib/notify.ts`, add this immediately above `renderFailDetails` and
replace that function:

```ts
interface FailureGuidance {
  label: string;
  nextAction: string;
}

const FAILURE_GUIDANCE: Record<string, FailureGuidance> = {
  fetch: {
    label: '抓取房源',
    nextAction: '確認 iBigFun 登入與連線狀態後，重新執行本次任務',
  },
  enrich: {
    label: '補充房源資料',
    nextAction: '確認路線與官方市場資料狀態後，重新執行本次任務',
  },
  report: {
    label: '產生報告',
    nextAction: '查看本機 pipeline 狀態與報告輸入後，重新產生本次報告',
  },
  notify: {
    label: '發送通知',
    nextAction: '確認 NOTIFY_CMD 或 ai-notify 設定後，重新執行通知步驟',
  },
};

const UNKNOWN_FAILURE_GUIDANCE: FailureGuidance = {
  label: '未知',
  nextAction: '查看本機 pipeline 狀態，排除原因後重新執行本次任務',
};

function failureGuidance(tail: JournalEvent[]): FailureGuidance {
  const lastStep = [...tail].reverse().find((event) => event.step.trim())?.step;
  return lastStep ? FAILURE_GUIDANCE[lastStep] ?? UNKNOWN_FAILURE_GUIDANCE : UNKNOWN_FAILURE_GUIDANCE;
}

export function defaultFailTitle(profileName: string, range: RunRange): string {
  return `❌ ${range.label} ${profileName}中斷`;
}

export function renderFailDetails(
  profileName: string,
  range: RunRange,
  reason: string,
  tail: JournalEvent[],
): string {
  const guidance = failureGuidance(tail);
  return [
    `# ❌ ${range.label} ${profileName}中斷`,
    '',
    `- 區間：${range.from} → ${range.to}`,
    `- 中斷步驟：${guidance.label}`,
    `- 原因：${reason}`,
    `- 建議：${guidance.nextAction}`,
  ].join('\n') + '\n';
}
```

The tail remains an input only to identify its last known step. Do not render
`ts`, `event`, `msg`, or `data`.

- [ ] **Step 4: Wire the profile display name and default title into `pipeline fail`**

In `scripts/pipeline.ts`:

1. Import `defaultFailTitle` from `./lib/notify.ts`.
2. Change the default title to:

```ts
const title = flag(argv, '--title') ?? defaultFailTitle(profile.displayName, range);
```

3. Change the failure body call to:

```ts
fs.writeFileSync(
  detailsFile,
  renderFailDetails(profile.displayName, range, reason, tail),
);
```

Keep custom `--title`, notifier argv, idempotence, redaction, and manifest
behavior unchanged.

- [ ] **Step 5: Run focused tests and type checking**

Run:

```bash
node --import tsx --test scripts/lib/notify.test.ts
npx tsc --noEmit
```

Expected: notifier tests PASS with 0 failures; TypeScript exits 0.

- [ ] **Step 6: Update failure-notification documentation**

In `docs/notifications.md`, retain the existing argv and missing-notifier
contract, then add:

```markdown
## Message body

Profile `report.md` is already the concise user-facing notification body. Full enrichment, valuation-review, manifest, and journal evidence stays local.

Failure notifications contain only the profile/range, human-readable stopped step, redacted operator reason, and safe next action. They never include the journal tail, timestamps, internal event names, raw stack traces, credentials, or source payloads.
```

In `AGENTS.md`, change the `pipeline fail` description from writing details from
the redacted journal tail to writing a concise user-facing failure details file
while retaining the journal locally. Do not change the command shape or status
rules.

- [ ] **Step 7: Commit concise failure notifications**

```bash
git add scripts/lib/notify.ts scripts/lib/notify.test.ts scripts/pipeline.ts docs/notifications.md AGENTS.md
git commit -m "feat: simplify failure notifications"
```

### Task 4: Run full verification and no-send notification smokes

**Files:**
- Verify: all tracked files changed in Tasks 1-3
- Verify, ignored: `profiles/investment-taipei.local/{evaluation.md,notify-template.md}`
- Verify, ignored: `profiles/owner-occupied-taipei.local/{evaluation.md,notify-template.md}`
- Generated, ignored: `state/runs/example-investment/2099-12-30/fail-details.md`

**Interfaces:**
- Consumes: final templates, rules, failure renderer, pipeline CLI, and notifier contract.
- Produces: fresh evidence that tests, types, tracked cleanliness, local-profile formatting, and dry-run payloads meet the design.

- [ ] **Step 1: Run the full automated suite**

Run:

```bash
npm test
```

Expected: exit 0, all tests pass, 0 failures.

- [ ] **Step 2: Run full TypeScript checking**

Run:

```bash
npx tsc --noEmit
```

Expected: exit 0 with no diagnostics.

- [ ] **Step 3: Verify tracked and local template contracts**

Run:

```bash
node --import tsx --test scripts/lib/notification-template.test.ts
rg -n '房貸|月租|現金流|租金覆蓋率|market_p25_wan|market_p75_wan|selected_stage|market_confidence|official_source_date|ORS|cache|enrich|開價溢價|保守行情|p\*|#each excluded' profiles/*/notify-template.md
```

Expected: template tests pass; `rg` returns no matches.

Inspect local criteria preservation:

```bash
rg -n 'price_segment.*2500|Total price: <= 7000|District ids:.*6.*8.*9' profiles/investment-taipei.local profiles/owner-occupied-taipei.local
```

Expected: the investment 2500 filter remains in `profile.json`; the local owner
still has the 7000 萬 limit and five-district criteria. Formatting changes must
not alter those values.

- [ ] **Step 4: Dry-run both profile bodies through `ai-notify`**

Run:

```bash
ai-notify --tool codex --status warn --task "iBigFun 台北投資房源監測（範例）" --title "⚠️ 模板驗證" --details-file profiles/example-investment/notify-template.md --dry-run
ai-notify --tool codex --status warn --task "iBigFun 台北自住房源監測（範例）" --title "⚠️ 模板驗證" --details-file profiles/example-owner-occupied/notify-template.md --dry-run
```

Expected: each command exits 0 and prints JSON containing the unchanged keys
`prefix`, `tool`, `status`, `host`, `task`, `title`, and `details`; neither
command sends a notification.

- [ ] **Step 5: Dry-run the pipeline failure path**

Run:

```bash
npm run pipeline -- fail --profile example-investment --date 2099-12-30 --reason "verification-only failure" --tool codex --dry-run
```

Expected: exit 0, writes
`state/runs/example-investment/2099-12-30/fail-details.md`, prints a composed
`ai-notify` command without sending, and the body contains `中斷步驟：未知`, the
redacted reason, and generic next action. It contains no `journal` section or
event lines.

- [ ] **Step 6: Inspect final Git state and commits**

Run:

```bash
git diff --check
git status --short
git log -4 --oneline --decorate
```

Expected: `git diff --check` exits 0; no tracked changes remain; the design,
template, rules, and failure-format commits are visible. Ignored local profile
format changes and ignored verification state do not appear in `git status`.
