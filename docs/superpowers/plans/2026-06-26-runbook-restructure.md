# Runbook Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the iBigFun automation docs so `AGENTS.md` is a single linear runbook a first-time agent can execute top-to-bottom, with each concern owned by exactly one file and the three mechanics gaps (fetching, estimation, source model) filled.

**Architecture:** Fold the daily run sequence from `docs/daily-workflow.md` into `AGENTS.md`; collapse the duplicated source-of-truth map and safety block to single owners in `AGENTS.md`; add a new `docs/fetching.md` (absorbing the browser login flow from `docs/credentials.md`); add a "Market Price & Rent Estimation" section to `docs/reporting-rules.md`; trim the now-redundant content from `README.md`, `docs/credentials.md`, and `docs/automation-state.md`; delete `docs/daily-workflow.md`.

**Tech Stack:** Markdown docs only. Verification is `grep`/read checks, not unit tests. No application code is changed.

**Source spec:** `docs/superpowers/specs/2026-06-26-runbook-restructure-design.md`

---

## File Map

- Create: `docs/fetching.md` — how to fetch listings (browser + `.env` login), fields to extract, MRT calc, future script note.
- Modify: `docs/reporting-rules.md` — add "Market Price & Rent Estimation" section.
- Modify: `AGENTS.md` — full rewrite into the linear runbook (source model, first-run checklist, run sequence, canonical `ai-notify`, single safety block, single source-of-truth map).
- Delete: `docs/daily-workflow.md` — run sequence folded into `AGENTS.md`.
- Modify: `docs/credentials.md` — remove browser login flow (moved to `fetching.md`); keep secrets handling; add pointer.
- Modify: `docs/automation-state.md` — make the "591 URLs" listing-ID wording source-agnostic.
- Modify: `README.md` — slim to a pointer-style overview; remove duplicated structure/safety/map.

Order rationale: create `fetching.md` first so later files can link to it; rewrite `AGENTS.md` before deleting `daily-workflow.md`; finish with a cross-reference sweep.

---

### Task 1: Create `docs/fetching.md`

**Files:**
- Create: `docs/fetching.md`

- [ ] **Step 1: Write the file**

Create `docs/fetching.md` with exactly this content:

```markdown
# Fetching iBigFun Listings

How to retrieve the target date's listings for the daily report. This is the
mechanics referenced by step 3 and step 5 of the run sequence in `AGENTS.md`.

## Why Browser-First, Not Plain Fetch

The iBigFun listing pages redirect unauthenticated requests to `/user/signin`
(login-gated) and render results with client-side JavaScript. Plain HTTP
fetching returns the login wall or empty HTML, so it is not reliable. Drive a
real browser session instead.

## Primary Method (Browser Tool)

1. Build the filtered target-date URL. Base URL:

   ```text
   https://www.ibigfun.com/lists/latest?page=1&expand=0&method=all_case&on_market=1&city=1&price_segment=%2C2500&floor_segment=2%2C4&total_floor=%2C5
   ```

   Add the target-date parameters (same date for both, computed per the
   "Report Date" rule in `AGENTS.md`):

   - `add_date=YYYY-MM-DD`
   - `add_date_max=YYYY-MM-DD`

2. Open the URL in the browser tool.
3. If the browser redirects to `/user/signin`, log in with the project-local
   `.env` credentials (`IBIGFUN_ACCOUNT`, `IBIGFUN_PASSWORD`; see
   `docs/credentials.md`). Fill the **visible** login fields only — the page
   contains duplicate hidden login inputs, so do not match by duplicate IDs
   alone. Never print, log, screenshot, or store either credential value.
4. After login, reopen the filtered target-date URL.
5. Confirm the page shows the expected target date, then collect all result
   pages for that date.
6. If login is blocked by CAPTCHA, 2FA, account-risk checks, missing
   credentials, or repeated failure, stop and ask for manual confirmation. Do
   not attempt to bypass those controls.

## Fields To Extract Per Listing

Normalize each listing with at least:

- title
- URL (canonical listing URL — may point to the originating source such as 591
  or rakuya; see the source model note in `AGENTS.md`)
- address / area
- address coordinate from the iBigFun Google Maps link when available
- published date
- total price
- total ping
- unit price
- floor / total floors
- type / layout
- age
- parking
- iBigFun real-price (實價登錄) URL when available

## MRT Distance

For listings with a credible address coordinate:

- Compute straight-line distance with the **haversine formula** from the listing
  coordinate to every exit in `data/taipei_mrt_exits.csv`, and pick the nearest
  exit. Keep the nearest station, exit ID, and distance.
- Treat a straight-line distance of 700–900 m as a manual walking-distance
  boundary case. Straight-line distance is not walking distance.
- When a walking-time estimate is needed, call OpenStreetMap foot routing only
  for the single nearest exit, not every exit.

See `data/README.md` for the dataset columns and the full distance rules, and
`docs/reporting-rules.md` for how distance feeds the hard-exclusion rule.

## Future: Replace Manual Fetch With A Script

A committed `scripts/fetch.ts` (Playwright) should eventually log in with the
`.env` credentials and write the day's listings to JSON, replacing the manual
browser steps. The `.gitignore` already covers Playwright artifacts
(`storageState.json`, `*.har`, traces, `playwright-report/`, etc.). Until that
exists, use the browser method above.
```

- [ ] **Step 2: Verify the file exists and is well-formed**

Run: `test -f docs/fetching.md && grep -c '^## ' docs/fetching.md`
Expected: prints `5` (five `##` sections: Why Browser-First, Primary Method, Fields To Extract, MRT Distance, Future).

- [ ] **Step 3: Commit**

```bash
git add docs/fetching.md
git commit -m "docs: add fetching runbook for listing acquisition"
```

---

### Task 2: Add estimation section to `docs/reporting-rules.md`

**Files:**
- Modify: `docs/reporting-rules.md` (insert a new section after `## Calculations`, before `## Manual Checks`)

- [ ] **Step 1: Insert the new section**

In `docs/reporting-rules.md`, find the line `## Manual Checks` and insert this block immediately **before** it (leaving one blank line on each side):

```markdown
## Market Price & Rent Estimation

These are the inputs to the discount and rent-coverage calculations above.
Document the source used for each, as required by the data-quality rules below.

### Market Price (推估區域行情)

Use this precedence:

1. iBigFun's own real-price / 實價登錄 link for the listing, when available.
2. Otherwise, agent-gathered comparable transactions matched on area, age,
   floor, and property type.
3. If only stale, weak, timed-out, or cross-site data is available, the listing
   **cannot be labeled `recommended`**. Route it to near-threshold or excluded
   and flag it for manual confirmation.

### Rent (預估月租金)

Estimate from comparable rental listings for the same area and property type.
Always flag the rent figure as needing manual confirmation of the actual
achievable rent and expected vacancy.

### Source Visibility

Keep the source used for each market and rent estimate visible in that
listing's notes.
```

- [ ] **Step 2: Repoint references away from the deleted `daily-workflow.md`**

This file currently links to `docs/daily-workflow.md`, which Task 4 deletes. Fix both references.

Replace this line (in the `## Notification Format` section):

```markdown
- Send with `ai-notify --details-file <markdown-file>`. See `docs/daily-workflow.md` for the full command shape and status selection.
```

with:

```markdown
- Send with the canonical `ai-notify` command in `AGENTS.md`, which also defines the `ok`/`warn`/`fail` status selection.
```

Replace this line (in the `## Rule Ownership` section):

```markdown
Keep durable investment, sorting, notification, and data-quality rules in this file. Keep daily execution steps in `docs/daily-workflow.md`. Keep recent run history and one-off operational observations in automation memory.
```

with:

```markdown
Keep durable investment, sorting, notification, and data-quality rules in this file. Keep the daily execution sequence in `AGENTS.md`. Keep recent run history and one-off operational observations in automation memory.
```

- [ ] **Step 3: Verify placement and content**

Run: `grep -n '^## ' docs/reporting-rules.md`
Expected: `## Market Price & Rent Estimation` appears between `## Calculations` and `## Manual Checks`.

Run: `grep -c '實價登錄\|cannot be labeled' docs/reporting-rules.md`
Expected: at least `2`.

Run: `grep -c 'daily-workflow' docs/reporting-rules.md`
Expected: `0` (both references repointed to `AGENTS.md`).

- [ ] **Step 4: Commit**

```bash
git add docs/reporting-rules.md
git commit -m "docs: add estimation method and repoint refs to AGENTS.md"
```

---

### Task 3: Rewrite `AGENTS.md` as the linear runbook

**Files:**
- Modify: `AGENTS.md` (full replacement)

- [ ] **Step 1: Replace the entire file content**

Overwrite `AGENTS.md` with exactly this content:

```markdown
# Agent Instructions (iBigFun Automation)

This repository monitors iBigFun investment property listings, prepares a daily
Markdown report, and sends a concise notification. It is the shared entrypoint
for Codex and Claude Code. Read it top-to-bottom before operating; follow the
linked docs only when you need rule detail.

## What This Is & The Source Model

iBigFun aggregates sale listings that originate on other sites (591, 樂居,
rakuya, etc.). A listing's canonical URL therefore often points to the
originating source rather than `ibigfun.com` — that is expected, not a bug. The
daily job reads iBigFun's filtered latest-sale view for the target date,
evaluates each listing against `docs/reporting-rules.md`, writes a report, and
notifies.

## First Run — Prerequisites

Do these once before the first run; stop and ask the user if any fails:

- [ ] `ai-notify` is on PATH (`which ai-notify`). If missing, stop and ask.
- [ ] `.env` exists and is filled (`cp .env.example .env`; see
  `docs/credentials.md`).
- [ ] A browser tool is available for the fetch step (see `docs/fetching.md`).

## Daily Run Sequence

1. Read this file, `docs/reporting-rules.md`, `docs/credentials.md`, and
   `docs/automation-state.md` before generating a report or changing behavior.
2. Compute the target date: the previous calendar day in `Asia/Taipei` (see
   "Report Date" below). A run on `2026-06-27` targets `2026-06-26`.
3. Fetch the target date's listings → `docs/fetching.md`.
4. Deduplicate by stable listing ID → `docs/automation-state.md`.
5. Normalize each listing's fields and compute the nearest MRT exit →
   `docs/fetching.md`, `data/taipei_mrt_exits.csv`.
6. Estimate market price and rent → `docs/reporting-rules.md`.
7. Evaluate against the investment criteria, exclusions, and sorting →
   `docs/reporting-rules.md`.
8. Write `reports/YYYY-MM-DD.md` (target date in the filename) using
   `templates/daily-notify-template.md` as the structure.
9. Notify with the canonical command below.

### Report Date

Default recurring runs report on the previous calendar day in `Asia/Taipei`, not
the run date — this avoids an incomplete same-day report. Set both `add_date`
and `add_date_max` to the target date, write `reports/<target>.md`, and title the
report for the target date. Only use the run date itself when the user explicitly
asks for a same-day/intraday check, and mark such output as incomplete/intraday.

## Canonical Notification Command

Send the finished report only after it is written. Use this exact command shape:

```bash
ai-notify --tool <codex|claude> --status <ok|warn|fail> \
  --task "每日 iBigFun 投資房源監測" --title "<short title>" \
  --details-file reports/YYYY-MM-DD.md
```

- `--tool`: the agent actually running (`codex` or `claude`).
- `--status warn`: recommendations, near-threshold candidates, stale/weak market
  data, login fallback, or anything needing review.
- `--status ok`: a clean no-recommendation run with fresh data.
- `--status fail`: only when the monitor cannot complete.

## Safety Rules

- Never commit real credentials, cookies, sessions, browser profiles,
  screenshots with secrets, or raw local output containing secrets.
- Never commit local automation state, traces, HAR files, downloaded HTML pages,
  or browser storage files unless sanitized and explicitly requested.
- Use `.env.example` as the committed template; the real `.env` stays local.
- Do not print `IBIGFUN_ACCOUNT` or `IBIGFUN_PASSWORD` in logs, reports,
  notifications, screenshots, or debug output.
- If login is blocked by CAPTCHA, 2FA, or account-risk checks, stop and ask for
  manual confirmation. Do not bypass those controls.
- Generated reports under `reports/` and local state under `state/` are
  git-ignored. Do not commit them unless the user explicitly asks.

## Source-Of-Truth Map

- `AGENTS.md` (this file): entrypoint, run sequence, safety, notification
  command, source-of-truth map.
- `docs/fetching.md`: how to fetch listings, fields to extract, MRT distance.
- `docs/credentials.md`: credential storage and login secrets handling.
- `docs/reporting-rules.md`: investment criteria, calculations, estimation,
  data quality, sorting, and notification format.
- `docs/automation-state.md`: durable state and deduplication conventions.
- `templates/daily-notify-template.md`: report/notification structure.
- `data/README.md`: MRT reference dataset and distance rules.
- Automation memory: recent run summaries and short-lived notes only. When a
  decision becomes durable, promote it into the relevant doc above.
```

- [ ] **Step 2: Verify structure and single-ownership**

Run: `grep -n '^## ' AGENTS.md`
Expected sections in order: What This Is & The Source Model, First Run — Prerequisites, Daily Run Sequence, Canonical Notification Command, Safety Rules, Source-Of-Truth Map.

Run: `grep -c 'ai-notify --tool' AGENTS.md`
Expected: `1` (the canonical command appears exactly once).

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: make AGENTS.md the linear first-run runbook"
```

---

### Task 4: Delete `docs/daily-workflow.md`

**Files:**
- Delete: `docs/daily-workflow.md`

- [ ] **Step 1: Confirm no remaining references before deleting**

Run: `grep -rn 'daily-workflow' . --include='*.md' | grep -v 'docs/superpowers/'`
Expected: only `README.md` still references it (Task 2 already cleaned `reporting-rules.md`); Task 7 rewrites `README.md`. The spec/plan docs under `docs/superpowers/` reference it historically and are left as-is.

- [ ] **Step 2: Delete the file**

```bash
git rm docs/daily-workflow.md
```

- [ ] **Step 3: Verify deletion**

Run: `test ! -f docs/daily-workflow.md && echo DELETED`
Expected: prints `DELETED`.

- [ ] **Step 4: Commit**

```bash
git commit -m "docs: remove daily-workflow.md (folded into AGENTS.md)"
```

---

### Task 5: Trim `docs/credentials.md`

**Files:**
- Modify: `docs/credentials.md` (remove the `## Browser Login Flow` section; add a pointer)

- [ ] **Step 1: Remove the moved section**

In `docs/credentials.md`, delete the entire `## Browser Login Flow` section (the heading and its numbered list, steps 1–5). The browser login flow now lives in `docs/fetching.md`.

- [ ] **Step 2: Add a pointer in its place**

Where the `## Browser Login Flow` section was, insert:

```markdown
## Browser Login

The browser login flow (when, where, and how to enter these credentials during
a fetch) lives in `docs/fetching.md`. This file owns only how the secrets are
stored and the rule for stopping on blocked login.
```

- [ ] **Step 3: Verify**

Run: `grep -c 'Fill the visible login form' docs/credentials.md`
Expected: `0` (the moved flow is gone).

Run: `grep -c 'docs/fetching.md' docs/credentials.md`
Expected: at least `1` (the pointer is present).

- [ ] **Step 4: Commit**

```bash
git add docs/credentials.md
git commit -m "docs: move browser login flow to fetching.md, trim credentials"
```

---

### Task 6: Fix source framing in `docs/automation-state.md`

**Files:**
- Modify: `docs/automation-state.md`

- [ ] **Step 1: Make the listing-ID wording source-agnostic**

In `docs/automation-state.md`, replace this line:

```markdown
Track each discovered listing by stable listing ID. For 591 URLs, use the numeric listing ID from the URL when available.
```

with:

```markdown
Track each discovered listing by stable listing ID. Use the source's stable numeric listing ID from the URL when available (e.g. 591, rakuya), since iBigFun aggregates listings that originate on other sites.
```

- [ ] **Step 2: Verify**

Run: `grep -c 'For 591 URLs' docs/automation-state.md`
Expected: `0`.

Run: `grep -c 'aggregates listings that originate' docs/automation-state.md`
Expected: `1`.

- [ ] **Step 3: Commit**

```bash
git add docs/automation-state.md
git commit -m "docs: make listing-ID convention source-agnostic"
```

---

### Task 7: Slim `README.md`

**Files:**
- Modify: `README.md` (full replacement)

- [ ] **Step 1: Replace the entire file content**

Overwrite `README.md` with exactly this content:

```markdown
# iBigFun Automation

Workspace for monitoring iBigFun investment property listings, preparing a daily
Markdown report, and sending a concise notification.

## Start Here

**Agents:** read `AGENTS.md` — it is the linear runbook (source model, first-run
prerequisites, daily run sequence, notification command, safety rules, and the
source-of-truth map). Do not duplicate those rules here.

## Credentials

Use a dedicated automation account. Copy `.env.example` to `.env` and fill it
locally; never commit `.env`. See `docs/credentials.md`.

## Repository Layout

- `AGENTS.md` — runbook and entrypoint.
- `docs/` — fetching, credentials, reporting rules, automation state.
- `data/` — static reference data (Taipei MRT exit coordinates).
- `templates/` — notification template.
- `reports/`, `state/` — local generated output and state; git-ignored.

## Safety

See the safety rules in `AGENTS.md`. In short: never commit credentials,
sessions, browser profiles, automation state, traces, screenshots, downloaded
pages, or any local output containing secrets.
```

- [ ] **Step 2: Verify single-ownership (no duplicated map/command)**

Run: `grep -c 'ai-notify' README.md`
Expected: `0` (the command lives only in `AGENTS.md`).

Run: `grep -c 'daily-workflow' README.md`
Expected: `0` (no reference to the deleted file).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: slim README to a pointer-style overview"
```

---

### Task 8: Final cross-reference sweep

**Files:**
- Read-only verification across all docs.

- [ ] **Step 1: No references to the deleted file remain (outside historical specs)**

Run: `grep -rn 'daily-workflow' . --include='*.md' | grep -v 'docs/superpowers/'`
Expected: no output.

- [ ] **Step 2: The notification command exists in exactly one place**

Run: `grep -rln 'ai-notify --tool' . --include='*.md' | grep -v 'docs/superpowers/'`
Expected: only `AGENTS.md`.

- [ ] **Step 3: No hardcoded `--tool codex` remains**

Run: `grep -rn 'tool codex' . --include='*.md' | grep -v 'docs/superpowers/'`
Expected: no output (the canonical command uses `--tool <codex|claude>`).

- [ ] **Step 4: New docs are linked from the runbook**

Run: `grep -c 'docs/fetching.md' AGENTS.md`
Expected: at least `2` (referenced from the run sequence).

- [ ] **Step 5: If any check fails, fix the offending file and re-run that check, then commit the fix**

```bash
git add -A
git commit -m "docs: fix dangling references after runbook restructure"
```

(If all checks passed with no changes, skip this commit.)

---

## Self-Review Notes

- **Spec coverage:** Target file ownership table → Tasks 1–7. New `AGENTS.md`
  outline → Task 3. `docs/fetching.md` → Task 1. Estimation section → Task 2.
  Consistency fixes (`ai-notify`, automation-state framing, README slim) →
  Tasks 3/6/7 + sweep in Task 8. Out-of-scope items (Playwright script, criteria
  changes) are correctly not implemented, only referenced as future work.
- **Single-ownership** of the source-of-truth map, safety block, and `ai-notify`
  command is verified by the `grep -c` checks in Tasks 3, 7, and 8.
```
