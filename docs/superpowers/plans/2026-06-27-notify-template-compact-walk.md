# Compact Notify Template + MRT Walk Line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each listing in the daily notification compact (merge fields, drop 狀態/刊登日) and add a 🚶 MRT walk line (station + exit + minutes + map link) to the recommended / near-threshold / hard-excluded sections.

**Architecture:** Docs/template-only change. The agent already reads `EnrichedListing` data (`walk`, `coordinate`, etc.) when producing the report. We rewrite `templates/daily-notify-template.md`'s five per-listing blocks and add the matching presentation rules to `docs/reporting-rules.md`. No `scripts/` code changes, therefore no new automated unit tests — verification is deterministic grep checks plus a hand-filled worked example checked against the spec mockups.

**Tech Stack:** Markdown templates (handlebars-style `{{#each}}` / `{{...}}` placeholders that the agent fills), `docs/reporting-rules.md`.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-06-27-notify-template-compact-walk-design.md`. All five block layouts and the walk-line rules are defined there verbatim — match them exactly.
- Map link format is exactly `https://www.google.com/maps?q=<lat>,<lng>`, link text `地圖`.
- 🚶 walk line appears in exactly three sections: 前置排除 (hard_excluded), 推薦 (recommended), 接近門檻 (near_threshold). It does NOT appear in 可疑/待查 or 目標日排除.
- Every listing block loses the `- 狀態：…` line. Recommended and near-threshold additionally lose the `- 刊登日：…` line.
- Do NOT touch the 快速摘要 section, the 需要人工確認 section, or the 規則來源 section.
- Do NOT change `scripts/` code, investment thresholds, sorting, or exclusion logic.
- Field separators: fullwidth middle dot `・` between fields on one line; fullwidth slash `／` between 總價/坪數/單價.
- Single notification target stays ~3,500 Chinese characters (existing rule); compaction only helps.

---

### Task 1: Rewrite the per-listing template blocks

**Files:**
- Modify (full replace): `templates/daily-notify-template.md`

**Interfaces:**
- Consumes: enriched data the agent already has per listing — `walk {stationZh, exitId, minutes}`, `coordinate {lat,lng}`, price/ping/unit numbers, `discount_percent`, `rent_coverage`, `suspicious_label`, etc. No code interface; these are template placeholders the agent fills.
- Produces: a `{{walk_line}}` placeholder used in three blocks (the agent composes the full walk string per Task 2's rules) and the compact block layouts that Task 2's rules describe. Task 2 references these exact layouts.

- [ ] **Step 1: Replace the entire template file with the compact version**

Replace the full contents of `templates/daily-notify-template.md` with exactly this (the 快速摘要 / 需要人工確認 / 規則來源 sections are unchanged from the current file; the five per-listing blocks are the rewrite):

````markdown
## iBigFun 每日投資房源監測 - {{date}}

**結論：{{conclusion}}**

### 快速摘要

- 新刊登物件：{{new_listing_count}} 筆
- iBigFun 查詢：[開啟目標日篩選](https://www.ibigfun.com/lists/latest?page=1&expand=0&method=all_case&on_market=1&city=1&price_segment=%2C2500&floor_segment=2%2C4&total_floor=%2C5&add_date={{date}}&add_date_max={{date}})
- 前置排除：{{hard_excluded_count}} 筆
- 推薦物件：{{recommended_count}} 筆
- 接近門檻：{{near_threshold_count}} 筆
- 目標日排除：{{excluded_count}} 筆
- 可疑/待查：{{suspicious_count}} 筆
- 主要排除原因：{{main_exclusion_reasons}}
- 房貸假設：8 成貸、年利率 2.6%、30 年本息平均攤還
- 推薦門檻：`低於行情 >= 10%` 且 `租金覆蓋率 >= 1.0`
- 接近門檻：`租金覆蓋率 >= 0.8`
- 前置排除：明確離捷運超過 800 公尺（客觀硬排除）
- 可疑/待查：法拍／資訊過少／無室內圖等由 agent 軟標記,降權但不自動移除

### 前置排除

{{#if hard_excluded}}

{{#each hard_excluded}}

#### {{rank}}. [{{title}}]({{url}})

- {{walk_line}}
- 前置排除：{{hard_exclusion_reason}}（{{hard_exclusion_evidence}}）

{{/each}}

{{else}}

- 無明確符合前置排除條件的物件。捷運距離看不出來者不以前置排除處理。

{{/if}}

### 推薦物件

{{#if recommended}}

{{#each recommended}}

#### {{rank}}. [{{title}}]({{url}}) ｜ 低於行情 {{discount_percent}}%・覆蓋率 {{rent_coverage}}

- {{walk_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 行情 {{market_unit_price}} 萬/坪・月租 ~{{estimated_rent}}・房貸 {{monthly_mortgage}}・現金流 {{monthly_cash_flow}}/月
- 推薦理由：{{recommendation_reason}}
- 風險：{{risks_or_manual_checks}}

{{/each}}

{{else}}

- 無符合 `低於行情 >= 10%` 且 `租金覆蓋率 >= 1.0` 的物件。

{{/if}}

### 接近門檻候選

{{#if near_threshold}}

{{#each near_threshold}}

#### {{rank}}. [{{title}}]({{url}}) ｜ 覆蓋率 {{rent_coverage}}・差在 {{near_threshold_reason}}

- {{walk_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 行情 {{market_unit_price}} 萬/坪・月租 ~{{estimated_rent}}・房貸 {{monthly_mortgage}}・現金流 {{monthly_cash_flow}}/月
- 需人工確認：{{manual_checks}}

{{/each}}

{{else}}

- 無租金覆蓋率達 `0.8` 的接近門檻候選。

{{/if}}

### ⚠️ 可疑/待查

{{#if suspicious}}

{{#each suspicious}}

#### {{rank}}. [{{title}}]({{url}}) ｜ `{{suspicious_label}}`

- 命中訊號：{{suspicious_signals}}
- 理由：{{suspicious_reason}}（信心：{{suspicious_confidence}}・{{detail_page_checked}}）

{{/each}}

{{else}}

- 無 agent 標記為可疑/待查的物件。

{{/if}}

### 目標日排除物件

{{#if excluded}}

{{#each excluded}}

#### {{rank}}. [{{title}}]({{url}})

- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・覆蓋率 {{rent_coverage}}
- 排除：{{exclusion_reason}}

{{/each}}

{{else}}

- 目標日無需列出的排除物件。

{{/if}}

### 需要人工確認

- 實際可租金額與出租天數
- 屋況、漏水、頂樓防水、修繕成本
- 貸款成數、銀行估價、利率條件
- 是否有增建、頂加、權狀或用途問題
- 實價登錄可比物件是否足夠接近

### 規則來源

- 投資門檻、排序與通知格式規則見 `docs/reporting-rules.md`。
````

- [ ] **Step 2: Verify the walk line appears in exactly the three intended sections**

Run: `grep -c '{{walk_line}}' templates/daily-notify-template.md`
Expected: `3`

- [ ] **Step 3: Verify removed fields are gone**

Run: `grep -c '狀態：' templates/daily-notify-template.md; grep -c '刊登日' templates/daily-notify-template.md`
Expected: `0` then `0` (both removed everywhere).

- [ ] **Step 4: Verify the map-link format string is documented in the template path it will use**

The template itself uses `{{walk_line}}` (agent-composed), so the literal map URL is not in the template. Confirm no stray hardcoded map URL leaked in:
Run: `grep -c 'maps?q=' templates/daily-notify-template.md`
Expected: `0`

- [ ] **Step 5: Hand-fill one recommended block and check against the spec mockup**

Mentally (or in scratch) fill the 推薦 block with: title 美寓, discount 11, coverage 1.09, walk_line `🚶 東門站 4 號出口・8 分鐘（[地圖](https://www.google.com/maps?q=25.03,121.52)）`, 1000 萬／20 坪／50 萬/坪・3/5 樓・屋齡 30・中正區X街, 行情 56・月租 ~35000・房貸 32031・現金流 +2969/月. Confirm it renders as 6 lines (header + 5 bullets) and matches spec section ①. This is a visual check, no command.

- [ ] **Step 6: Sanity-check the rest of the suite is untouched**

Run: `npm test`
Expected: same pass count as before (no code changed) — 57 tests, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add templates/daily-notify-template.md
git commit -m "feat: compact notify listing blocks + MRT walk line"
```

---

### Task 2: Add the presentation rules to reporting-rules.md

**Files:**
- Modify: `docs/reporting-rules.md` (the `## Notification Format` section, currently the bullet list near the end of the file)

**Interfaces:**
- Consumes: the exact block layouts and `{{walk_line}}` placeholder produced by Task 1.
- Produces: agent-facing rules for composing the walk line, the map link, the inline header metrics, and which sections use which layout. No code interface.

- [ ] **Step 1: Append the new rules to the Notification Format section**

In `docs/reporting-rules.md`, inside the `## Notification Format` bullet list, after the existing bullet `- Add a Markdown link to every listing title.`, insert these bullets:

```markdown
- Each listing section header is `#### {rank}. [title](url)`; do not emit a `- 狀態：…` line — the section heading already names the bucket.
- Append inline metrics to the header: recommended `｜ 低於行情 {discount_percent}%・覆蓋率 {rent_coverage}`; near-threshold `｜ 覆蓋率 {rent_coverage}・差在 {near_threshold_reason}`; suspicious `｜ \`{label}\`` where label is `clean` / `suspicious` / `likely-auction`.
- Do not emit a 刊登日 line in recommended or near-threshold listings.
- Recommended and near-threshold use the full compact layout (walk line, one basics line `總價／坪數／單價・樓層・屋齡・地址`, one financial line `行情・月租・房貸・現金流`, then reason/risk or manual-check). Hard-excluded, suspicious, and excluded use the shorter layout shown in `templates/daily-notify-template.md`.
- Emit the 🚶 walk line in 前置排除, 推薦, and 接近門檻 only — never in 可疑/待查 or 目標日排除. Compose it from the listing's enriched `walk` and `coordinate`:
  - Reliable (`walk` present): `🚶 {stationZh} {exitId} 號出口・{minutes} 分鐘（[地圖]({map_url})）`. If `exitId` is missing, drop the 出口 part: `🚶 {stationZh}・{minutes} 分鐘（[地圖]({map_url})）`.
  - Unreliable but `coordinate` present (`walk` is null — e.g. coordinate inconsistent, route ratio implausible): show the triage result and mark it pending: `🚶 約{station}・步行待確認（[地圖]({map_url})）`, or `🚶 步行待人工確認（[地圖]({map_url})）` when no station can be inferred.
  - No `coordinate`: `🚶 無位置資訊` (no map link).
- Map link `{map_url}` is exactly `https://www.google.com/maps?q=<lat>,<lng>` using the listing `coordinate`, with link text `地圖`.
- When a numeric field (月租, 現金流, 行情, etc.) is null, render it as `—` rather than dropping the line.
```

- [ ] **Step 2: Verify the new rules landed**

Run: `grep -c '🚶' docs/reporting-rules.md; grep -c 'maps?q=' docs/reporting-rules.md`
Expected: at least `3` then at least `1` (walk-line states reference 🚶; map URL appears once).

- [ ] **Step 3: Verify consistency with the template — no contradictory leftover**

Run: `grep -c '狀態：' docs/reporting-rules.md`
Expected: `0` (no rule still tells the agent to emit a 狀態 line).

- [ ] **Step 4: Sanity-check the suite**

Run: `npm test`
Expected: 57 tests, 0 fail (no code changed).

- [ ] **Step 5: Commit**

```bash
git add docs/reporting-rules.md
git commit -m "docs: notify-format rules for walk line, map link, compact blocks"
```

---

## Self-Review

**1. Spec coverage:**
- Compact merge-not-drop layout, remove 狀態/刊登日 → Task 1 Steps 1, 3.
- 🚶 walk line three data states + map link → Task 1 (`{{walk_line}}` in 3 blocks) + Task 2 Step 1 (composition rules).
- Compact tiers (recommended/near full vs hard/suspicious/excluded short) → Task 1 block layouts + Task 2 rule bullet.
- Walk line in exactly 前置排除/推薦/接近門檻 → Task 1 Step 2 (count = 3) + Task 2 rule.
- Quick summary unchanged → Task 1 reproduces it verbatim; Global Constraints forbid touching it.
- reporting-rules update → Task 2.
- No code/test changes → both tasks only `npm test` as a no-regression sanity check.
All spec sections covered.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every step has concrete content or an exact command with expected output.

**3. Type/name consistency:** `{{walk_line}}` named identically in Task 1 template and Task 2 rules. Header metric placeholders (`discount_percent`, `rent_coverage`, `near_threshold_reason`, `suspicious_label`) match between the template blocks and the rule bullets. Map URL string identical in both tasks and Global Constraints.
