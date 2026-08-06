# Concise ai-notify Message Format Design

Date: 2026-08-06

## Problem

The profile report is also the Markdown body sent by `ai-notify`. The current
templates mix user decisions with operational counters, valuation internals,
calculation assumptions, repeated manual-check boilerplate, and individual
exclusion details. This makes daily notifications long and difficult to scan,
especially on a phone.

The failure path has the same problem: it sends a redacted journal tail that is
useful for local diagnosis but not for the notification recipient.

## Goals

1. Make investment and owner-occupied notifications decision-first and easy to
   scan.
2. Keep every recommended/matched, candidate, and risk listing visible.
3. Keep the user-requested property signals: asking total, area, asking unit
   price, walking/map information, days on market, and price history.
4. Replace valuation implementation details with a compact human-readable
   market-evidence conclusion while preserving the same fail-closed gates.
5. Summarize exclusions by reason and count without listing excluded properties.
6. Make failure notifications actionable without embedding journal events.

## Non-goals

- Do not change fetch, enrich, market estimation, tenure, route, bucketing,
  sorting, or notification-status semantics.
- Do not remove mortgage, estimated-rent, or cash-flow computation from the
  investment workflow. Remove those fields only from notification output.
- Do not reintroduce asking-premium logic. Asking price versus official market
  evidence must not decide whether a listing is a deal, determine its bucket,
  mark it suspicious, sort it, or exclude it.
- Do not create a second `notification.md` artifact or teach `ai-notify` to
  parse and rewrite profile Markdown.
- Do not cap or truncate the candidate bucket.

## Architectural Decision

Keep the existing one-artifact contract: `report.md` remains the user-facing
report and the exact `--details-file` sent to `ai-notify`. Make the profile
templates concise at the source. Full machine and audit evidence remains in
`enriched.json`, `valuation-review.json` when applicable, the pipeline manifest,
and the journal.

This avoids two user-facing documents drifting apart and keeps `ai-notify` a
transport rather than a profile-aware renderer.

## Common Notification Structure

Both profiles use this reading order:

1. **Title:** status icon, date/range, profile purpose, and the most important
   action count. Example: `⚠️ 8/4 投資房源｜6 筆候選待確認`.
2. **Conclusion:** one sentence stating whether anything deserves action.
3. **Compact counts:** one line containing new, positive, candidate, risk, and
   excluded counts.
4. **Data warning:** render only when stale, weak, missing, or inconsistent data
   changes what the user may safely conclude. Omit the line for a clean run.
5. **Positive bucket:** list every recommended investment or matched self-use
   property.
6. **Candidate bucket:** list every candidate; never replace candidates with an
   `and N more` summary.
7. **Risk bucket:** list every risk property.
8. **Exclusion summary:** counts grouped by current valid hard-exclusion reason;
   never render individual excluded listings.

Remove rule-source footers, calculation assumptions, generic repeated
manual-check lists, route/cache/enrich counters, raw status identifiers, and
other operational metadata from the notification.

The existing approximately 3,500-Chinese-character target remains a soft
compactness goal. Completeness of the positive, candidate, and risk buckets
takes precedence over that target. There is no silent truncation.

## Per-listing Layout

Every individually rendered property uses a stable, compact sequence:

1. `#### {rank}. [title](listing URL)`
2. Core property facts.
3. Walking information and a map link.
4. Days on market and price history.
5. A human-readable market-evidence conclusion plus the bucket reason or next
   action.

Keep the existing agent-filled template model. Continue using `{{walk_line}}`
and `{{tenure_line}}`; replace the collection of raw market placeholders with
one required `{{market_summary_line}}`, and use the bucket's existing reason,
risk, or manual-check placeholder for the final decision phrase. The agent must
render `market_summary_line` from authoritative `marketEstimate` evidence under
the rules below; it is not free-form external valuation.

### Core facts

All listings show total asking price, total area, asking unit price, floor, age,
and address/area when available. Owner-occupied listings additionally show room
layout, flat parking, and building type because those are self-use decision
signals.

Investment notifications do not show mortgage payment, estimated rent, monthly
cash flow, rental-coverage figures, or the financing assumptions that produced
them. Those computations remain available to the workflow but are not user
notification content.

### Walking and map

Recommended/matched, candidate, and risk listings all show walking information.
Reliable data uses:

`🚶 {station} {exit} 號出口・{minutes} 分鐘・[地圖](maps URL)`

When coordinates exist but walking is unresolved, use:

`🚶 步行距離待確認・[地圖](maps URL)`

When coordinates do not exist, use `🚶 無位置資訊` without a link. Continue to
use the current Google Maps coordinate URL contract.

### Tenure and price history

Keep the tenure signal for every individually rendered property:

- Target-day listing: `🕒 今日上架`.
- Known tenure: `🕒 刊登 {days} 天・{price history}`.
- Unknown tenure: `🕒 刊登天數待確認`.

Preserve `未降價`, `曾降價 {old}→{new} 萬`, and
`曾調漲 {old}→{new} 萬`. If only price-history detail is unavailable, omit that
segment and retain the known days-on-market value.

### Market evidence

The notification must retain the official evidence status in human-readable
form, but it no longer prints P25-P75, internal stage, raw confidence enum,
source-check date, or the full unavailable-reason list for every listing.
Examples:

- `行情可靠｜官方中位 68.5 萬/坪・5 筆可比`
- `行情待覆核｜可比資料信心不足`
- `行情無法估算｜地址資料需確認`

A source-freshness problem must remain visible both in the top warning and in
the affected listing's compact conclusion. The existing rule that only fresh,
non-low-confidence `reliable` evidence can support an automatic positive bucket
does not change. Full official quantiles, confidence, comparables, selection
stage, provenance, freshness dates, and unavailable reasons remain in local
evidence.

The compact conclusion must never describe a property as cheap, expensive, a
deal, overpriced, or excludable based on asking price versus official evidence.

## Profile-specific Presentation

### Investment

Use the buckets `推薦物件`, `候選／資料待確認`, and `風險物件／待查`.
The last listing line explains market reliability and why the listing is
recommended, held for review, or risky. The region and walking gates, tenure
gate, ownership/use checks, and all other existing criteria remain unchanged.

The exclusion summary separately counts target-station-outside,
in-region-too-far, expired-tenure, and other confirmed hard failures when those
counts are non-zero. It contains no asking-premium or conservative-price
language.

### Owner occupied

Use the buckets `符合條件`, `候選／資料待確認`, and `風險物件／待查`.
The last listing line emphasizes self-use fit, missing confirmation, or risk.
Room layout, flat parking, floor, building age, and building type remain visible.
Investment-only financial fields never appear.

The exclusion summary groups failures of the owner-occupied hard criteria,
including the configured tenure limit, without listing excluded properties.

## Status Presentation

Keep existing status-selection semantics and make the visual distinction clear:

- `ok`: `✅`; clean no-positive/no-candidate/no-risk result.
- `warn`: `⚠️`; any positive, candidate, risk, manual review, or stale/weak data.
- `fail`: `❌`; the monitor cannot complete.

The title carries the icon and primary outcome. Do not repeat raw
`status=review`, `status=unavailable`, or similar implementation syntax in the
body.

## Failure Notification

Replace the journal-tail body with four user-facing elements:

1. Profile and date/range in the title.
2. The human-readable pipeline step that stopped.
3. The operator-supplied, already-redacted reason.
4. A short next action.

Determine the stopped step from the last redacted journal event that has a
pipeline step. Map known steps (`fetch`, `enrich`, `report`, and `notify`) to
short user-facing labels and safe step-specific retry guidance. If no known step
is available, show `中斷步驟：未知` and use the generic action `查看本機 pipeline
狀態，排除原因後重新執行本次任務`. This uses the journal only as structured
input; it does not copy journal event text into the notification.

Example:

```markdown
# ❌ 8/4 投資房源監測中斷

- 中斷步驟：登入 iBigFun
- 原因：需要人工完成驗證
- 建議：完成登入後重新執行本次任務
```

Do not include journal timestamps, internal event names, raw stack traces, or
the journal tail in `fail-details.md`. The existing local journal remains the
diagnostic source of truth. Failure text must continue to pass through existing
redaction and must never contain credentials.

## Missing Data and Edge Cases

- Omit an unavailable optional segment instead of filling the notification with
  repeated em dashes.
- Convert decision-relevant missing data into a short action phrase, such as
  `行情無法估算｜地址資料需確認`.
- Never invent a station, map link, tenure, price history, valuation, layout, or
  parking value.
- If there are no properties in a bucket, use one short empty-state sentence.
- If there are many candidates, render them all and compact lower-priority
  summary prose; do not drop candidate listings.
- A stale official source still forces `warn` and blocks an automatic positive
  bucket exactly as it does today.

## Source and Local Profile Scope

Update the tracked example investment and owner-occupied templates and rules as
the committed source of truth. During implementation, apply the same
formatting-only changes to currently present ignored `profiles/*.local/`
investment and owner-occupied profiles while preserving all of their personal
fetch filters and evaluation criteria. Those local files remain uncommitted.

## Verification

Add or update automated contract tests to verify:

1. Both tracked templates retain their positive, candidate, risk, and exclusion
   summary sections.
2. Both templates include required core facts, walk/map, tenure, and compact
   market-conclusion placeholders for individually rendered user-action buckets.
3. Investment notification templates do not contain mortgage, rent, cash flow,
   coverage, P25-P75, internal stage, ORS/cache/enrich counters, or individual
   exclusion loops.
4. Owner-occupied templates retain layout and parking signals and do not contain
   investment-only financial fields or individual exclusion loops.
5. Failure-details rendering omits journal events and renders step, reason, and
   safe next action.
6. Existing stale/review/unavailable notification-status gates continue to pass.
7. Missing coordinate, missing tenure, and unavailable market evidence produce
   the required human-readable fallback phrases.
8. Full unit tests and TypeScript checks pass after implementation.

Perform a no-send dry-run for each profile and the failure path. Inspect the
rendered Markdown for mobile-scale scanability and confirm that the composed
notifier argv remains unchanged.

## Expected Files Changed During Implementation

- `docs/reporting-rules.md`
- `docs/notifications.md`
- `AGENTS.md`
- `profiles/example-investment/evaluation.md`
- `profiles/example-investment/notify-template.md`
- `profiles/example-owner-occupied/evaluation.md`
- `profiles/example-owner-occupied/notify-template.md`
- `scripts/lib/notify.ts`
- `scripts/lib/notify.test.ts`
- Focused template/report contract tests, added in the existing test structure
- Present ignored investment/owner-occupied `profiles/*.local/` rules and
  templates, formatting only and not committed

`scripts/lib/notify.ts` keeps the canonical notifier argv and command-resolution
behavior unchanged; only concise failure-detail composition changes.
