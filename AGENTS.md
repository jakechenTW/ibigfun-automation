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
- [ ] `.env` exists and is filled (`cp .env.example .env`): `IBIGFUN_ACCOUNT`/
  `IBIGFUN_PASSWORD` (see `docs/credentials.md`) and `ORS_API_KEY` for the
  enrich step's walking distances (free key at openrouteservice.org/dev).
- [ ] Toolchain installed: `npm install`.

## Daily Run Sequence

1. Read this file, `docs/reporting-rules.md`, `docs/credentials.md`, and
   `docs/automation-state.md` before generating a report or changing behavior.
2. Compute the target date: the previous calendar day in `Asia/Taipei` (see
   "Report Date" below). A run on `2026-06-27` targets `2026-06-26`.
3. Fetch the target date's listings → `docs/fetching.md`
   (`npm run fetch -- --date <target>` writes `state/listings-<target>.json`).
4. Enrich deterministically (`npm run enrich -- --date <target>` writes
   `state/enriched-<target>.json`): nearest MRT exit by **walking distance**
   (OpenRouteService foot routing over OSM), monthly mortgage, parsed numbers,
   objective hard-exclusion flags (>10-min walk when data is reliable), and an
   advisory `signals.auctionKeyword` flag the agent weighs (no longer an
   auto-exclusion — see Quality / Suspicious-Listing Judgment in
   docs/reporting-rules.md). Listings with an unreliable
   coordinate/route are marked `withinWalk: null` for manual review, never
   auto-excluded. See "Tooling" below.
5. Triage unreliable walking distances (`withinWalk: null`): re-locate from the
   address + `nearbyStation`, use `npm run route -- --lat <> --lng <>` for a
   deterministic walk, and give a labelled verdict (likely-within / likely-far /
   unknown→human) → `docs/reporting-rules.md` (Walking-Distance Triage).
6. Deduplicate by stable listing ID → `docs/automation-state.md`.
7. Estimate market price and rent (the agent's judgment; not automated) →
   `docs/reporting-rules.md`.
8. Evaluate against the investment criteria, exclusions, and sorting, using the
   enriched fields plus your estimates → `docs/reporting-rules.md`.
9. Write `reports/YYYY-MM-DD.md` (target date in the filename) using
   `templates/daily-notify-template.md` as the structure.
10. Notify with the canonical command below.

### Tooling

Two committed scripts cover the deterministic steps; the agent does estimation,
evaluation, and writing the report.

- `npm run fetch -- --date <target>` — Browserless fetch. Logs in from `.env`
  via a form POST, calls iBigFun's JSON APIs (`/api/search/list` +
  `on-market/o2o-same`), paginates by `total_records`, writes normalized
  listings to `state/listings-<target>.json`. Details: `docs/fetching.md`.
- `npm run enrich -- --date <target>` — reads that file and adds walking
  distance to the nearest MRT exit (needs `ORS_API_KEY` in `.env`; results
  cached in `state/route-cache.json`), mortgage, parsed numbers, a reliability
  gate, hard-exclusion (walk only), and the advisory auction-keyword signal →
  `state/enriched-<target>.json`. Estimation
  and the final recommend/exclude judgment stay with the agent. The decision is
  `withinWalk` (true ≤10-min walk / false too far / null unreliable→manual).
- `npm run route -- --lat <> --lng <>` — deterministic nearest-walk exit for one
  coordinate (shared ORS cache). Used during triage (step 5) to get a trustworthy
  walking distance after re-locating a listing from its address.
- `npm run pipeline -- run [--date <target>]` — thin orchestrator over the daily
  steps fetch → enrich → report → notify. One run per date is recorded under
  `state/runs/<target>/` (`manifest.json` = resumable state, `journal.jsonl` =
  event timeline). Already-ok steps are skipped, so **re-running resumes** from
  the first non-ok step; it stops at the agent `report` step and prints the
  `mark` command to run when the report is written. `notify` is auto-run from the
  status/title recorded at the report mark (idempotent; `--dry-run` prints the
  composed `ai-notify` command without sending).
  - `npm run pipeline -- status [--date <target>]` — per-step status, timing,
    summary, last error, and the journal tail.
  - `npm run pipeline -- mark report --status ok --artifact reports/<target>.md
    --status-notify <ok|warn|fail> --title "<short>" --tool <codex|claude>` —
    mark the agent report step done and record the notify parameters.
  - `fetch`/`enrich` remain runnable standalone; under the pipeline their
    warnings/summaries flow to the journal instead of stderr.

Both default to the previous Taipei day when `--date` is omitted. Pure logic is
covered by `npm test`.

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
