# Range-Native Daily Monitor + Headless Worker Prompt — Design

Date: 2026-06-27
Status: Approved (pending implementation)

## Problem

Two gaps surfaced after the observable/resumable pipeline landed:

1. **The pipeline only monitors a single day.** Run identity is one date
   (`state/runs/<date>/`). There is no way to monitor a span — "last 3 days",
   "6/20–6/25" — as one unit. A backfill or a custom window has no first-class
   representation.
2. **There is no defined daily automation prompt.** The daily run is meant to
   fire headlessly (cron → headless `claude`/`codex`), but no committed prompt
   tells the worker what to do, and there is no safe failure path: `notify`
   only auto-fires when the agent marks `report`, so a block during
   `fetch`/`enrich` (CAPTCHA / login risk / network) would fail **silently** —
   nobody is watching.

This design makes the pipeline **range-native** and defines a **two-layer
headless automation** (trigger decides the range; a committed worker prompt
does the work) with an explicit failure-notification path.

## Goals

- One run can monitor an inclusive date range `[from, to]`, emitting **one
  merged, deduplicated report and one notification**.
- A single day is the degenerate range `[d, d]` — the common nightly case —
  and produces byte-for-byte the same output it does today (`reports/<d>.md`,
  one notification). No regression.
- A committed, **range-agnostic** worker prompt (`prompts/daily-run.md`) drives
  the headless daily run: thin, delegates judgment to `AGENTS.md` /
  `docs/reporting-rules.md`, but pins exact commands and the headless
  failure/resume policy.
- A headless block is **never silent**: a first-class `pipeline fail` path
  always sends a `status=fail` notification.

## Non-Goals

- Per-day fan-out for a range. A range is fetched in **one** call
  (`add_date`/`add_date_max`), not N single-day pipeline runs.
- Hardcoding any date or window in the repo. The range is always a runtime
  input chosen by the trigger layer (which lives outside the repo).
- Replacing agent judgment. `report` stays agent-driven; the orchestrator only
  tracks it.
- New dependencies. Stay fs + JSONL + node builtins, consistent with the repo.

## Design A — Range-Native Pipeline

**Core insight: a single day is the range `[d, d]`.** The pipeline is
generalized to be range-native; single-day is the trivial special case, not a
parallel mode. The nightly run is the range `[previousTaipeiDay,
previousTaipeiDay]`.

### Run identity & label

A run is identified by an inclusive range `[from, to]` (`from <= to`, both
`YYYY-MM-DD`). A **label** derives the on-disk name:

- `from === to` → label = `<date>` (e.g. `2026-06-26`) — pretty, backward
  compatible.
- `from !== to` → label = `<from>_<to>` (e.g. `2026-06-20_2026-06-25`).

Applied uniformly to run dir and artifacts:

- Run dir: `state/runs/<label>/` (`manifest.json`, `journal.jsonl`).
- Artifacts: `state/listings-<label>.json`, `state/enriched-<label>.json`,
  `reports/<label>.md`.

### `fetch` takes a range

iBigFun's search API already accepts `add_date` / `add_date_max`. Today the
script sets both to the single target. Generalize: `add_date = from`,
`add_date_max = to`; one fetch over the whole span; write
`state/listings-<label>.json`. **No per-day loop.**

### Cross-day dedup (deterministic layer)

A listing can recur on multiple days within the span. Dedup by **stable listing
ID** in the deterministic fetch/extract layer (not cross-run), collapsing
repeats to one entry per the existing rules in `docs/automation-state.md` (keep
first-seen; later appearances update last-seen, not duplicated). The merged
report and notification therefore cover a deduplicated set.

### `enrich` / `report` / `notify` by label

- `enrich` reads `state/listings-<label>.json`, writes
  `state/enriched-<label>.json` — unchanged logic, label-parameterized paths.
- The agent writes **one** merged `reports/<label>.md` over the deduplicated
  enriched set, per `docs/reporting-rules.md` + the template.
- `notify` sends **one** notification, `--details-file reports/<label>.md`.
  The canonical task string is unchanged (`每日 iBigFun 投資房源監測`); the
  agent-supplied `--title` reflects the span (e.g. `6/20–6/25 投資房源 digest`).

### CLI

- `npm run pipeline -- run [--from <d> --to <d>] [--date <d>]`
  - `--date <d>` is shorthand for `--from <d> --to <d>`.
  - All omitted → default range `[previousTaipeiDay, previousTaipeiDay]`.
  - `--from`/`--to` must both be valid `YYYY-MM-DD` and satisfy `from <= to`;
    otherwise a clear input error (exit 2), matching existing `--date`
    validation.
- `resolveDate` generalizes to `resolveRange` returning `{ from, to, label }`.
- `status` / `mark` operate on the label (a range run is addressed by
  `--from/--to` or `--date`, same resolution).
- `fetch` / `enrich` standalone CLIs gain `--from/--to` with `--date` as the
  shorthand, same resolution and defaults.

### Failure escape hatch — `pipeline fail`

A new first-class command:

```
npm run pipeline -- fail [--from <d> --to <d> | --date <d>] --reason "<short>"
```

- Marks the run failed in the manifest (a run-level failure, with `reason` and
  the failing step if known) and appends a `run.fail` journal event.
- Sends a `status=fail` notification by **reusing `notify.ts`'s composition**
  (no duplicated command shape): `ai-notify --tool <codex|claude> --status fail
  --task "每日 iBigFun 投資房源監測" --title "<short>"` with details = a
  **safe journal tail** (already `redact()`-ed) rather than a report file that
  may not exist.
- Idempotent with the normal notify guard: if a real notification already went
  out for this run, do not double-send.

This is the single escape hatch the headless worker calls on any unrecoverable
error before `report`, keeping all `ai-notify` assembly inside `notify.ts`.

### Files touched

- `scripts/lib/runpaths.ts` — label-based `runDir`/`manifestPath`/`journalPath`.
- `scripts/lib/manifest.ts` — `targetDate` → `from`/`to` (+ derived `label`);
  `createManifest`/read/write/`planNextSteps` updated; run-level failure fields.
- `scripts/lib/steps.ts`, `scripts/fetch.ts`, `scripts/enrich.ts` — range params,
  label-based artifact paths, `add_date`/`add_date_max` from the range.
- `scripts/lib/extract.ts` — cross-day dedup by listing ID over the span.
- `scripts/pipeline.ts` — `resolveRange`, `--from/--to/--date`, `fail` command.
- `scripts/lib/notify.ts` — reused by `fail`; tolerate the fail/journal-tail
  details path (no report file required for a fail send).
- `AGENTS.md` / relevant docs — document range runs, the label rule, and `fail`.

A new label helper (e.g. `rangeLabel(from, to)`) is the single source of the
`<date>` vs `<from>_<to>` rule, consumed everywhere.

## Design B — Two-Layer Headless Automation

### Layer 1 — Trigger automation agent (outside the repo)

Fired by the scheduler. Sole responsibility: **decide the range/scope** —
default nightly = previous Taipei day; or an explicit window ("last 3 days",
"6/20–6/25"). It understands no listing logic. It hands the worker a concrete
range and points at the committed worker prompt. The range is therefore always
a runtime decision, never committed.

### Layer 2 — Worker prompt (`prompts/daily-run.md`, committed)

A static, **range-agnostic** template. Judgment rules delegate to `AGENTS.md` /
`docs/reporting-rules.md`; exact commands and the headless failure/resume
policy are pinned in the template. Sections:

1. **Role** — daily iBigFun monitor, headless, autonomous, must never stop to
   ask a human.
2. **Range input convention** — the trigger injects the range; map it to
   command params: `from`/`to` → `--from/--to`; single date → `--date`; nothing
   → omit (pipeline defaults to previous Taipei day). The worker does not
   compute dates itself beyond this mapping.
3. **Read first** — `AGENTS.md` and `docs/reporting-rules.md` before judging.
4. **Execution flow (pinned commands)**:
   - `npm run pipeline -- run [params]` — runs fetch+enrich, stops at the agent
     `report` step and prints its requirements; already-`ok` steps skip
     (= resume).
   - Own the `report` step: `withinWalk:null` triage, estimate, evaluate,
     dedup-aware, write `reports/<label>.md` per reporting-rules + template.
   - `npm run pipeline -- mark report --status ok --artifact reports/<label>.md
     --status-notify <ok|warn|fail> --title "<short>" --tool claude` →
     auto-fires `notify` (idempotent). Done.
5. **status mapping** — `warn` (recommendations / near-threshold / stale data /
   login fallback / any manual-review item), `ok` (clean, no recommendation,
   fresh data), `fail` (cannot complete).
6. **Headless failure policy** (the new safety contract):
   - Login blocked by CAPTCHA/2FA/account-risk → **do not bypass**; take the
     escape hatch.
   - Any unrecoverable `fetch`/`enrich` error → escape hatch; do not retry
     indefinitely.
   - Partial failure (e.g. ORS routing all fails) is **not** `fail` — mark
     those listings manual-review and emit `warn`, per `AGENTS.md` (unreliable
     routing is never auto-excluded).
   - Escape hatch: `npm run pipeline -- fail --reason "<short>"` (with the run's
     range params) → one `status=fail` notification (details = safe journal
     tail), then stop.
7. **Safety (full list in `AGENTS.md`)** — never print account/password; never
   commit `state/` or `reports/`; never bypass login controls.

### Done state

A run is done when either the report was written + `notify` recorded `ok`, or
the escape hatch sent a `fail`. Either way the outcome is observable after the
fact via `pipeline status` and the journal — no silent failures.

## Testing (TDD, `node:test`, zero deps)

Pure units, offline:

- `rangeLabel(from, to)` — `<date>` when equal, `<from>_<to>` otherwise.
- `resolveRange(argv)` — `--date` shorthand, `--from/--to`, default = previous
  Taipei day, `from <= to` validation, invalid-input → exit-2 path.
- Manifest range fields + `planNextSteps` unchanged-behavior over a range label.
- Cross-day dedup — same listing ID across days in the span collapses to one
  (keep first-seen), distinct IDs preserved.
- `fetch` request params map a range to `add_date`/`add_date_max` (single day
  sets both equal — the existing behavior).
- `pipeline fail` — marks the run failed, composes a `status=fail` `ai-notify`
  from `notify.ts` with a journal-tail details argument (string assembly
  asserted; not executed), honors the idempotency guard.
- Single-day regression — label `<date>`, artifact `reports/<date>.md`, one
  notification: identical to current behavior.

## Safety (per `AGENTS.md`)

- `state/runs/<label>/` stays under the already-ignored `state/`.
- `pipeline fail` details = `redact()`-ed journal tail only — never credentials,
  cookies, `Set-Cookie`, or the login body.
- Headless worker never prints `IBIGFUN_ACCOUNT` / `IBIGFUN_PASSWORD`, never
  bypasses CAPTCHA/2FA/risk controls, never commits `state/` or `reports/`.

## Implementation Workspace

Implementation happens in an isolated **git worktree**
(`using-git-worktrees`), created at the transition to the implementation plan.

## Open Questions

None outstanding. Range output model (one merged digest), label rule
(`<date>` / `<from>_<to>`), dedup location (deterministic, keep first-seen),
one-notification-per-range, the two-layer trigger/worker split, range injection
(trigger-supplied, worker maps to params), and the failure path (new
`pipeline fail` command) are all decided.
