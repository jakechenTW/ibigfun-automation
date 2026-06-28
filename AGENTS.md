# Agent Instructions (iBigFun Automation)

This repository monitors iBigFun property listings through explicit profiles,
prepares a profile-specific Markdown report, and sends a concise notification.
It is the shared entrypoint for Codex and Claude Code. Read it top-to-bottom
before operating; follow the linked docs only when you need rule detail.

## What This Is & The Source Model

iBigFun aggregates sale listings that originate on other sites (591, 樂居,
rakuya, etc.). A listing's canonical URL therefore often points to the
originating source rather than `ibigfun.com` — that is expected, not a bug. The
daily job reads iBigFun's latest-sale view for the selected profile and target
date using the profile's `fetch` filter map (`profiles/<id>/profile.json`,
walked generically by `buildSearchBody`). The job evaluates each fetched listing
against `docs/reporting-rules.md` plus the profile's `evaluation.md`, writes a
report, and notifies. A profile is a self-contained folder; see
`profiles/README.md` to add or change one.

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
2. Identify the target profile explicitly (`investment-taipei` or
   `owner-occupied-taipei`). Do not infer a profile. Ad-hoc one-off conditions
   can be layered on with `--set fetch.<key>=<val>` / `--unset fetch.<path>`
   (see `profiles/README.md`); natural-language tweaks map to the same flags.
   Compute the target date: the previous calendar day
   in `Asia/Taipei` unless the user supplied a range/date. A default run on
   `2026-06-27` targets `2026-06-26`.
3. Fetch the target date's listings → `docs/fetching.md`
   (`npm run fetch -- --profile <profile> --date <target>` writes
   `state/runs/<profile>/<label>/listings.json`).
4. Enrich deterministically (`npm run enrich -- --profile <profile> --date
   <target>` writes `state/runs/<profile>/<label>/enriched.json`): nearest MRT
   exit by **walking distance** (OpenRouteService foot routing over OSM),
   monthly mortgage, parsed numbers, reusable walk signals (`withinWalk`) and
   reliability flags, and an advisory `signals.auctionKeyword` flag
   the agent weighs (no longer an auto-exclusion — see Quality /
   Suspicious-Listing Judgment in docs/reporting-rules.md). Listings with an
   unreliable coordinate/route are marked `withinWalk: null` for manual review,
   never auto-excluded. See "Tooling" below.
5. Triage unreliable walking distances (`withinWalk: null`): re-locate from the
   address + `nearbyStation`, use `npm run route -- --lat <> --lng <>` for a
   deterministic walk, and give a labelled verdict (likely-within / likely-far /
   unknown→human) → `docs/reporting-rules.md` (Walking-Distance Triage).
6. Deduplicate by stable listing ID → `docs/automation-state.md`.
7. Estimate profile-specific judgment fields (for investment: market price and
   rent; for self-use: fit, risks, and missing confirmations) →
   `docs/reporting-rules.md` and `profiles/<profile>/evaluation.md`.
8. Evaluate against the selected profile criteria, shared data-quality rules,
   and sorting/notification rules, using the enriched fields plus your estimates →
   `docs/reporting-rules.md` and `profiles/<profile>/evaluation.md`.
9. Write `state/runs/<profile>/<label>/report.md` using the profile's
   `profiles/<profile>/notify-template.md` as the structure.
10. Notify with the canonical command below.

### Tooling

Two committed scripts cover the deterministic steps; the agent does estimation,
evaluation, and writing the report.

- `npm run fetch -- --profile <profile> --date <target>` — Browserless fetch.
  Logs in from `.env` via a form POST, calls iBigFun's JSON APIs
  (`/api/search/list` + `on-market/o2o-same`), paginates by `total_records`,
  writes normalized listings to `state/runs/<profile>/<label>/listings.json`.
  Details: `docs/fetching.md`.
- `npm run enrich -- --profile <profile> --date <target>` — reads that file and
  adds walking distance to the nearest MRT exit (needs `ORS_API_KEY` in `.env`;
  results cached in `state/route-cache.json`), mortgage, parsed numbers, a
  reliability gate for walking distance, and the advisory auction-keyword
  signal → `state/runs/<profile>/<label>/enriched.json`. Profile-specific
  estimation and final include/exclude judgment stay with the agent. The walk
  decision is `withinWalk` (true ≤10-min walk / false too far / null
  unreliable→manual).
- `npm run route -- --lat <> --lng <>` — deterministic nearest-walk exit for one
  coordinate (shared ORS cache). Used during triage (step 5) to get a trustworthy
  walking distance after re-locating a listing from its address.
- `npm run pipeline -- run --profile <profile> [--date <target> | --from <a>
  --to <b>]` — thin orchestrator over fetch → enrich → report → notify. A run
  covers an inclusive date range; a single day is the default (previous Taipei
  day) and uses the bare date as its label. A multi-day range uses the label
  `<from>_<to>`. One run per profile and label is recorded under
  `state/runs/<profile>/<label>/`; artifacts are
  `state/runs/<profile>/<label>/{listings.json, enriched.json, report.md}`. A whole range is fetched in **one** query
  (`add_date`/`add_date_max`), deduped by listing id, and emitted as **one**
  merged report + **one** notification. Already-ok steps are skipped, so
  re-running resumes.
  - `npm run pipeline -- status --profile <profile> [--date <target> | --from
    <a> --to <b>]` —
    per-step status, timing, summary, last error, and the journal tail.
  - `npm run pipeline -- mark report --profile <profile> [--date <target> |
    --from <a> --to <b>] --status ok --artifact
    state/runs/<profile>/<label>/report.md --status-notify <ok|warn|fail>
    --title "<short>" --tool <codex|claude>` — mark the agent report step done
    and record the notify parameters.
  - `npm run pipeline -- fail --profile <profile> [--date <d> | --from <a>
    --to <b>] --reason "<short>" --tool <codex|claude> [--dry-run]` —
    headless failure escape hatch: marks the run failed, writes a safe details
    file from the (redacted) journal tail, and sends one `status=fail`
    notification. `--dry-run` writes the details and prints the composed command
    without sending.
  - `fetch`/`enrich` remain runnable standalone; under the pipeline their
    warnings/summaries flow to the journal instead of stderr.

Date/range arguments default to the previous Taipei day when omitted, but
`--profile <profile>` is always required. Pure logic is covered by `npm test`.

### Report Date

Default recurring runs report on the previous calendar day in `Asia/Taipei`, not
the run date — this avoids an incomplete same-day report. Set both `add_date`
and `add_date_max` to the target date, write
`state/runs/<profile>/<label>/report.md`, and title the report for the target
date and profile. Only use the run date itself when the user explicitly asks for
a same-day/intraday check, and mark such output as incomplete/intraday.

## Canonical Notification Command

Send the finished report only after it is written. Use this exact command shape:

```bash
ai-notify --tool <codex|claude> --status <ok|warn|fail> \
  --task "<profile displayName>" --title "<short title>" \
  --details-file state/runs/<profile>/<label>/report.md
```

- `--tool`: the agent actually running (`codex` or `claude`).
- `--task`: use the selected profile's `displayName` from
  `profiles/<profile>/profile.json`.
- `--status warn`: recommendations/matches, near-threshold candidates, stale or
  weak data, login fallback, or anything needing review.
- `--status ok`: a clean no-recommendation/no-match run with fresh data.
- `--status fail`: only when the monitor cannot complete.

## Safety Rules

- Never commit real credentials, cookies, sessions, browser profiles,
  screenshots with secrets, or raw local output containing secrets.
- Never commit local automation state, traces, HAR files, downloaded HTML pages,
  or browser storage files unless sanitized and explicitly requested.
- Use `.env.example` as the committed template; the real `.env` stays local.
- Do not print `IBIGFUN_ACCOUNT` or `IBIGFUN_PASSWORD` in logs, reports,
  notifications, screenshots, or debug output.
- If login is blocked by CAPTCHA, 2FA, or account-risk checks, interactive
  agents stop and ask for manual confirmation. Headless daily workers must use
  `npm run pipeline -- fail ... --tool <codex|claude>`. Do not bypass those
  controls.
- Generated reports and local run state under `state/` (incl.
  `state/runs/<profile>/<label>/`) are git-ignored. Do not commit them unless
  the user explicitly asks.

## Source-Of-Truth Map

- `AGENTS.md` (this file): entrypoint, run sequence, safety, notification
  command, source-of-truth map.
- `docs/fetching.md`: how to fetch listings, fields to extract, MRT distance.
- `docs/credentials.md`: credential storage and login secrets handling.
- `docs/reporting-rules.md`: shared calculations, data quality, sorting, and
  notification conventions.
- `profiles/<id>/`: one self-contained folder per runnable profile —
  `profile.json` (`displayName` + `fetch` filter map), `evaluation.md`
  (profile-specific criteria, thresholds, report buckets), and
  `notify-template.md` (report/notification structure). Runnable ids are the
  folder names: `investment-taipei`, `owner-occupied-taipei`.
- `profiles/README.md`: how to author a profile (folder layout, `profile.json`
  schema, the `fetch` encoding, the add-a-search recipe, `--set fetch.*`
  overrides).
- `docs/automation-state.md`: durable state and deduplication conventions.
- `data/`: static reference data — `data/README.md` indexes the datasets
  (Taipei MRT exits, filter id→name mappings, per-city 議價率, investment region
  allowlist).
- `prompts/daily-run.md`: the committed headless worker prompt for the daily
  automated run (profile/range-agnostic; the trigger injects the profile and
  date range).
- `prompts/schedule-triggers.md`: copy-paste trigger template that injects
  profile / tool / date range into the `prompts/daily-run.md` SOP for scheduled
  runs.
- Automation memory: recent run summaries and short-lived notes only. When a
  decision becomes durable, promote it into the relevant doc above.
