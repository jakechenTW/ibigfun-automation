# Running profile monitors

Read this guide before generating reports or changing monitor behavior.
Paths in commands and inline code are relative to the repository root.
For headless execution, also follow [the worker prompt](../prompts/daily-run.md).
Read [routing.md](routing.md) before enrichment, walking triage, or the report-owned route trial.
Read [notifications.md](notifications.md) before report approval or delivery.

## Source model

iBigFun aggregates sale listings that originate on other sites (591, 樂居,
rakuya, etc.). A listing's canonical URL therefore often points to the
originating source rather than `ibigfun.com` — that is expected, not a bug. The
daily job reads iBigFun's latest-sale view for the selected profile and target
date using the profile's `fetch` filter map (`profiles/<id>/profile.json`,
walked generically by `buildSearchBody`). That same file carries the profile's
`displayName` and structured `evaluation` policy. The job evaluates each
fetched listing against `docs/reporting-rules.md` plus the profile's
`evaluation.md`, writes a report, and notifies. A profile is a self-contained
folder; see `profiles/README.md` to add or change one.

## First-run prerequisites

Do these once before the first run; stop and ask the user if any fails:

- [ ] `ai-notify` is on PATH (`which ai-notify`). If missing, stop and ask.
- [ ] `.env` exists and is filled (`cp .env.example .env`): `IBIGFUN_ACCOUNT`/
  `IBIGFUN_PASSWORD` (see `docs/credentials.md`) and `ORS_API_KEY` for the
  enrich step's walking distances (free key at openrouteservice.org/dev).
- [ ] Toolchain installed: `npm install`.

## Market-data prerequisite

The independent writer must finish before profile pipelines start.
Follow [the scheduled writer contract](market-data.md#scheduled-writer-and-read-only-consumers).
Profile workers never run an inline market-data refresh as recovery.

## Daily run sequence

1. Read `AGENTS.md`, this file, `docs/reporting-rules.md`, `docs/credentials.md`, and
   `docs/automation-state.md` before generating a report or changing behavior.
2. Identify the target profile explicitly (`example-investment` or
   `example-owner-occupied`). Do not infer a profile. Ad-hoc one-off conditions
   can be layered on with `--set fetch.<key>=<val>` / `--unset fetch.<path>`
   (see `profiles/README.md`); natural-language tweaks map to the same flags.
   Compute the target date: the previous calendar day
   in `Asia/Taipei` unless the user supplied a range/date. A default run on
   `2026-06-27` targets `2026-06-26`.
   Before the current run, execute `npm run pipeline -- recover --profile
   <profile> [the same date/range flags] --tool <codex|claude>`. It retries
   recorded unfinished older runs sequentially and returns a JSON work list.
   Complete every `outcome: report` item with its own original range using
   steps 5–12 below, then run that range's pipeline to deliver it. Record
   failures with `pipeline fail` and continue with the other backlog items
   and the current run. Never recursively recover or retry indefinitely.
3. Fetch the target date's listings → `docs/fetching.md`
   (`npm run fetch -- --profile <profile> --date <target>` writes
   `state/runs/<profile>/<label>/listings.json`).
4. Enrich deterministically (`npm run enrich -- --profile <profile> --date
   <target>` writes `state/runs/<profile>/<label>/enriched.json`): nearest MRT
   exit by **walking distance** (OpenRouteService foot routing over OSM),
   monthly mortgage, parsed numbers, reusable walk signals (`withinWalk`),
   reliability flags, official `marketEstimate` evidence loaded read-only from
   the active validated market-data pair, and an advisory `signals.auctionKeyword` flag
   the agent weighs (no longer an auto-exclusion — see Quality /
   Suspicious-Listing Judgment in docs/reporting-rules.md). Listings with an
   unreliable coordinate/route are marked `withinWalk: null` for manual review,
   never auto-excluded. See [routing.md](routing.md) for enrichment and routing commands.
5. Triage unreliable walking distances (`withinWalk: null`): re-locate from the
   address + `nearbyStation`, use `npm run route -- --lat <> --lng <>` for a
   deterministic walk, and give a labelled verdict (likely-within / likely-far /
   unknown→human) → `docs/reporting-rules.md` (Walking-Distance Triage).
   If the profile sets `evaluation.requireResolvedRegionGate: true`, resolve all
   region decisions before report completion. `pipeline mark report` rejects
   `步行時間待確認`. Use `pipeline fail` when the headless run cannot resolve it.
   Enrich waits 60 seconds and retries once for ORS 429 or quota-exhausted 403
   responses. It stops further ORS calls when that retry also fails.
6. Deduplicate by stable listing ID → `docs/automation-state.md`.
7. Apply the profile's `evaluation.maxDaysOnMarket` through each listing's
   enriched `tenureGate` before considering a recommendation: `expired` is
   exclusion-only, while `review` is candidate/risk-only and never an automatic
   recommendation. Then read the deterministic `marketEstimate`: retain the
   official median, P25–P75, confidence, comparable count, selected stage, and
   source freshness as transaction context and reliability gates. Do not compare
   the asking price with official values to decide whether a listing is a deal.
   `review`, `unavailable`, low confidence, stale sources, and inseparable
   parking are never auto-recommended. A bounded external valuation may review
   a boundary case but never silently overwrites official values; write
   `valuation-review.json` when it affects a bucket →
   `docs/reporting-rules.md` and `profiles/<profile>/evaluation.md`.
8. Estimate the remaining profile-specific fields (for investment: rent; for
   self-use: fit, risks, and missing confirmations) →
   `docs/reporting-rules.md` and `profiles/<profile>/evaluation.md`.
9. Evaluate against the selected profile criteria, shared data-quality rules,
   and sorting/notification rules, using the enriched fields plus your estimates →
   `docs/reporting-rules.md` and `profiles/<profile>/evaluation.md`.
10. After bucketing, run the report-owned dual-route trial only for every
    positive, candidate, and risk listing that will be rendered individually.
    Write their enriched indexes to the exact `listingIndexes` field in
    `route-trial-request.json`; it accepts at most 25 unique, non-negative safe
    integer indexes, each less than the current `enriched.json` listings-array
    length. Include `schemaVersion: 1`, the exact `profileId`, and the exact
    `rangeLabel`, then invoke `npm run route-trial` once with the same
    profile/date-or-range arguments and bind `route-trial.json` comparisons
    back by index and listing ID.
    Excluded/count-only listings never enter the request. Trial or provider
    failure keeps the available primary route visible and omits the trial result; it never changes the ORS-owned
    bucket, order, or notification status and never by itself triggers
    `pipeline fail`.
11. Write `state/runs/<profile>/<label>/report.md` using the profile's
   `profiles/<profile>/notify-template.md` as the structure.
12. Approve with `pipeline mark report`, then deliver with `pipeline run`. Any stale official market source requires notification status `warn`;
   `pipeline mark report --status ok` rejects malformed or internally inconsistent
   enriched market evidence and any stale official source. Fresh `review` or
   `unavailable` evidence affects notification status only when it leaves an
   actionable candidate or risk item after hard exclusions.

## Pipeline commands

- `npm run pipeline -- run --profile <profile> [--date <target> | --from <a>
  --to <b>]` — thin orchestrator over fetch → enrich → report → notify. A run
  covers an inclusive date range; a single day is the default (previous Taipei
  day) and uses the bare date as its label. A multi-day range uses the label
  `<from>_<to>`. One run per profile and label is recorded under
  `state/runs/<profile>/<label>/`; artifacts are
  `state/runs/<profile>/<label>/{listings.json, enriched.json, report.md, valuation-review.json?}`.
  `valuation-review.json` is optional and exists only if a bounded external review affects a report bucket; `mark report --status ok` binds every review to exactly one listing's authoritative `marketEstimate` even when notification status is `warn`/`fail`. A whole range is fetched in **one** query
  (`add_date`/`add_date_max`), deduped by listing id, and emitted as **one**
  merged report + **one** notification. Already-ok steps are skipped, so
  re-running resumes.
  - `npm run pipeline -- recover --profile <profile> [--date <target> | --from
    <a> --to <b>] --tool <codex|claude> [--dry-run]` — retry the recorded
    unfinished backlog through the target end date, excluding the target run
    itself. Successful report delivery is skipped. Script steps resume and
    stop at the agent report boundary; stdout JSON lists `report`, `complete`,
    or `failed` outcomes. A failed item does not block later items. Daily
    workers must finish the returned report work list before the current run.
    Failure alerts are separate from report delivery; a sent failure alert
    never completes a run. Recovered report titles include `補送`.
  - `npm run pipeline -- status --profile <profile> [--date <target> | --from
    <a> --to <b>]` —
    per-step status, timing, summary, last error, and the journal tail.
  - `npm run pipeline -- mark report --profile <profile> [--date <target> |
    --from <a> --to <b>] --status ok --artifact
    state/runs/<profile>/<label>/report.md --status-notify <ok|warn|fail>
    --title "<short>" --tool <codex|claude>` — approve the canonical report version
    and its evidence, publish its delivery copy, and record the notify parameters.
    Changed inputs or missing approval return unfinished runs to the report step.
    Review the original files before reapproval. Never create approval from hashes alone.
  - `npm run pipeline -- fail --profile <profile> [--date <d> | --from <a>
    --to <b>] --reason "<short>" --tool <codex|claude> [--dry-run]` —
    headless failure escape hatch: marks the run failed, writes a safe details
    file with concise user-facing guidance while retaining the journal locally,
    and sends one `status=fail` notification. `--dry-run` writes the details
    and prints the composed command without sending.
  - `fetch`/`enrich` remain runnable standalone; under the pipeline their
    warnings/summaries flow to the journal instead of stderr.

Date/range arguments default to the previous Taipei day when omitted, but
`--profile <profile>` is always required. Pure logic is covered by `npm test`.

## Report date

Default recurring runs report on the previous calendar day in `Asia/Taipei`, not
the run date — this avoids an incomplete same-day report. Set both `add_date`
and `add_date_max` to the target date, write
`state/runs/<profile>/<label>/report.md`, and title the report for the target
date and profile. Only use the run date itself when the user explicitly asks for
a same-day/intraday check, and mark such output as incomplete/intraday.

## Reference files

Each profile folder contains `profile.json`, `evaluation.md`, and `notify-template.md`.
The folder name is its runnable ID, including `example-investment` and `example-owner-occupied`.
See [profiles/README.md](../profiles/README.md) for profile authoring and fetch overrides.
See [data/README.md](../data/README.md) for MRT exits, filter mappings, and the investment region allowlist.
Use [automation-state.md](automation-state.md) for deduplication, durable state, and approval recovery.
Use [the trigger templates](../prompts/schedule-triggers.md) to inject profile, tool, and date range into the headless worker.
Automation memory holds recent summaries and short-lived notes only.
Promote durable decisions into the relevant reference document.
