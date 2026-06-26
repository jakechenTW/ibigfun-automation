# Runbook Restructure — Design Spec

- Date: 2026-06-26
- Status: Approved (design); ready for implementation plan
- Goal: A first-time AI agent can read the docs and operate the daily iBigFun
  monitoring workflow end-to-end without external context.

## Problem

The current docs are a strong *rulebook* (criteria, calculations, sorting,
notification format are all well specified) but a cold agent still gets stuck
on the *mechanics*:

1. **Data acquisition is undefined.** The workflow says "open the URL in the
   in-app browser," but a fresh agent has no obvious in-app browser, no script,
   and no `WebFetch`-vs-Playwright guidance. This is the single biggest blocker.
2. **Market price & rent estimation is undocumented.** The sample report cites
   `推估區域行情` and `預估月租金`, but nothing says where those numbers come
   from. The report cannot be reproduced.
3. **Source model is unexplained.** `automation-state.md` references "591
   URLs/IDs" and report links point to 591/rakuya, yet the project is framed as
   "iBigFun." The aggregator relationship is never stated.
4. **Duplication and no linear path.** The source-of-truth map is duplicated in
   three files (`AGENTS.md`, `README.md`, `daily-workflow.md`), safety rules in
   two, and the `ai-notify` command appears in three slightly different forms.
   A cold agent reads overlapping, drifting copies and never gets one clean
   top-to-bottom procedure.

## Approach

Full runbook restructure (chosen over minimal-patch and quickstart-only). Make
`AGENTS.md` the single linear runbook a cold agent reads top-to-bottom, collapse
every duplicated concern to exactly one owner, and fill the three content gaps
(fetching, estimation, source model). The proven rulebook content is preserved;
only its organization and the missing mechanics change.

## Target File Ownership

Each concern lives in exactly one place after the restructure.

| File | Becomes | Owns (single source of truth) |
|---|---|---|
| `AGENTS.md` | The runbook + entrypoint | Source model, First-Run prerequisites, the linear daily run sequence (folded in from `daily-workflow.md`), the one safety block, the one source-of-truth map, the one canonical `ai-notify` command |
| `README.md` | Slim human overview | 3-line "what this is" + "agents start at `AGENTS.md`"; duplicated safety/structure/map removed |
| `CLAUDE.md` | Unchanged | Redirect to `AGENTS.md` |
| `docs/fetching.md` | NEW | How to fetch: browser tool + `.env` login, fields to extract, MRT calc method, future `scripts/fetch.ts` note |
| `docs/credentials.md` | Trimmed | Secrets handling only (storage, retrieval, blocked-login rule); browser login flow moves to `fetching.md` |
| `docs/reporting-rules.md` | Rules source + new estimates section | Criteria, exclusions, calcs, NEW "Market Price & Rent Estimation," data quality, sorting, notification format |
| `docs/automation-state.md` | Fixed framing | Dedup/state; "591-only" wording made source-agnostic |
| `docs/daily-workflow.md` | Deleted | Run sequence folded into `AGENTS.md`; reference map deleted (lives in `AGENTS.md`) |
| `data/README.md` | Unchanged | MRT reference data |
| `templates/daily-notify-template.md` | Unchanged | Report structure |

Headline moves:

- `daily-workflow.md` is deleted; its run sequence becomes the heart of
  `AGENTS.md`.
- The source-of-truth map and safety block collapse to single copies in
  `AGENTS.md`.

## New `AGENTS.md` Outline

A cold agent reads this top-to-bottom and can execute.

1. **What this is & the source model** — 1–2 lines on purpose; note that iBigFun
   aggregates listings originating on 591 / 樂居 / rakuya, so listing URLs point
   to the original source (expected, not a bug).
2. **First Run — prerequisites checklist** (do once):
   - `ai-notify` on PATH → else stop, ask user
   - `.env` filled (see `docs/credentials.md`)
   - browser tool available for the fetch step
   - target date computed (per run sequence)
3. **Daily Run Sequence** (canonical numbered list, folded from
   `daily-workflow.md`); each step is one line that links into its deep-dive doc:
   1. Read this file + `reporting-rules` + `credentials` + `automation-state`
   2. Compute target date (previous calendar day, `Asia/Taipei`)
   3. Fetch listings → `docs/fetching.md`
   4. Deduplicate → `docs/automation-state.md`
   5. Normalize fields (+ MRT nearest-exit) → `docs/fetching.md`, `data/`
   6. Estimate market price & rent → `docs/reporting-rules.md`
   7. Evaluate against criteria → `docs/reporting-rules.md`
   8. Write `reports/YYYY-MM-DD.md` from `templates/`
   9. Notify (canonical command below)
4. **Canonical notification command** (defined once here), with `ok`/`warn`/`fail`
   selection rules inline:
   ```bash
   ai-notify --tool <codex|claude> --status <ok|warn|fail> \
     --task "每日 iBigFun 投資房源監測" --title "<short>" \
     --details-file reports/YYYY-MM-DD.md
   ```
5. **Safety rules** (single canonical block).
6. **Source-of-truth map** (single canonical copy).

## New / Changed Content

### `docs/fetching.md` (NEW)

- **Primary method:** open the filtered URL in the browser tool; if redirected
  to `/user/signin`, log in with `.env` creds (flow moved from `credentials.md`);
  fill *visible* fields only (the page has duplicate hidden inputs); reopen the
  target URL with `add_date` / `add_date_max`.
- **What to extract per listing:** the existing normalize list — title, URL,
  address/area, coordinate from the Google Maps link, published date, total
  price, total ping, unit price, floor/total floors, type/layout, age, parking,
  iBigFun real-price URL when available.
- **MRT calc:** straight-line distance via **haversine** to all exits in
  `data/taipei_mrt_exits.csv`, pick the nearest; treat 700–900 m as a manual
  walking-distance boundary; call OSM foot routing only for the nearest exit
  when a walking-time estimate is needed.
- **Future:** replace manual fetch with a committed `scripts/fetch.ts`
  (Playwright) that logs in and writes listings to JSON; `.gitignore` already
  covers its artifacts.
- **Why browser-first (not `WebFetch`):** the site redirects to `/user/signin`
  (login-gated) and is a JS-rendered SPA, so plain `WebFetch` is unreliable.

### `docs/reporting-rules.md` → new "Market Price & Rent Estimation" section

- **Market price precedence:** (1) iBigFun's own real-price / 實價登錄 link for
  the listing → (2) agent-gathered comparables matched on area/age/floor/type →
  if only stale, weak, or timed-out data is available, the listing **cannot be
  labeled "recommended"** (ties into existing data-quality rules; route to
  near-threshold or excluded with a manual-confirm flag).
- **Rent:** estimate from comparable rental listings; **always** flag as
  manual-confirm.
- Reinforce the existing rule that every market estimate keeps its source
  visible in the listing notes.

### Consistency Fixes

- **`ai-notify`:** every file references the one canonical command in
  `AGENTS.md`; `--tool` matches the running agent (`codex` or `claude`), not a
  hardcoded `codex`.
- **`automation-state.md`:** "For 591 URLs, use the numeric listing ID" becomes
  source-agnostic — "use the source's stable numeric listing ID (e.g. 591,
  rakuya)."
- **`README.md`:** strip duplicated safety/structure/source-of-truth map; point
  agents to `AGENTS.md` as the runbook.

## Out of Scope

- Building the `scripts/fetch.ts` Playwright scraper (documented as future work).
- Any change to investment criteria, thresholds, calculations, sorting, or the
  notification template structure — these are preserved as-is.
- Reorganizing `data/` or the MRT dataset.

## Success Criteria

- A first-time agent can read `AGENTS.md` top-to-bottom and execute every step,
  following links only when it needs rule detail.
- Each concern (safety, source-of-truth map, `ai-notify` command) appears in
  exactly one file.
- The three content gaps (fetch mechanics, estimation method, source model) are
  documented well enough to reproduce the existing sample report's approach.
