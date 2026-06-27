# Consolidate Run Artifacts Under `state/runs/<label>/` — Design

Date: 2026-06-27
Status: Approved (pending implementation)

## Problem

A pipeline run's files are scattered across three locations: the run record
(`manifest.json`, `journal.jsonl`, `fail-details.md`) lives in
`state/runs/<label>/`, but the produced artifacts do not — `listings` and
`enriched` are written flat in `state/` (`state/listings-<label>.json`,
`state/enriched-<label>.json`) and the report in `reports/<label>.md`. They
share the `<label>` only in their filenames. Inspecting or archiving "one run"
means touching three directories.

## Goal

Co-locate **every per-run artifact** under `state/runs/<label>/` so one run = one
folder. Single-day (`label = <date>`) and range (`label = <from>_<to>`) runs
behave identically; only the paths change.

## Non-Goals

- Changing artifact *contents* / JSON shape. Only file locations change.
- Migrating pre-existing runs. `state/` is git-ignored ephemeral scratch; old
  flat-path files are left as-is and ignored.
- Touching the shared route cache. `state/route-cache.json` is cross-run, not a
  per-run artifact, and stays at `state/route-cache.json`.

## Target layout

```
state/runs/<label>/
  manifest.json       (unchanged)
  journal.jsonl       (unchanged)
  listings.json       ← was state/listings-<label>.json
  enriched.json       ← was state/enriched-<label>.json
  report.md           ← was reports/<label>.md
  fail-details.md     (already here)
```

Filenames drop the now-redundant `<label>` (the directory carries it). The
`reports/` directory is simply no longer written.

## Design

### Path helpers (single source) — `scripts/lib/runpaths.ts`

Add three helpers beside the existing `runDir`/`manifestPath`/`journalPath`,
all derived from `runDir(label)`:

```ts
export function listingsPath(label: string): string { return path.join(runDir(label), 'listings.json'); }
export function enrichedPath(label: string): string { return path.join(runDir(label), 'enriched.json'); }
export function reportPath(label: string): string { return path.join(runDir(label), 'report.md'); }
```

Every producer/consumer of these artifacts calls a helper — no path string is
assembled anywhere else.

### Writers/readers — `steps.ts`, `enrich.ts`, `pipeline.ts`

- `fetchStep(range, …)`: write `listingsPath(range.label)`; `mkdir` the run dir
  (`runDir(range.label)`, recursive) before writing.
- `enrichStep(range, …)`: read `listingsPath(range.label)`; write
  `enrichedPath(range.label)`; `mkdir` the run dir (recursive — this also
  creates `state/` so the existing `saveCache` to `state/route-cache.json` keeps
  working).
- `enrich.ts` CLI: input path + not-found message use `listingsPath(range.label)`.
- `pipeline.ts`:
  - report-step stop message references `reportPath(range.label)` (both the
    `reports/<label>.md` mention and the `mark … --artifact` example).
  - notify step passes `reportPath(range.label)` to `composeNotifyCommand` /
    `runNotify` (the `--details-file`).
  - `cmdFail` already writes `fail-details.md` under `runDir(label)` — unchanged.

### The agent `report` step

The agent now writes the report to `state/runs/<label>/report.md` (the path the
orchestrator prints) and marks it with `--artifact state/runs/<label>/report.md`.
The worker prompt (`prompts/daily-run.md`) and `AGENTS.md` are updated to the new
path.

### Docs

Update all path references: `AGENTS.md` (Daily Run Sequence, Tooling bullets,
the pipeline run/mark/status bullets, the Canonical Notification Command
example) and `prompts/daily-run.md` (`state/enriched-<label>.json` →
`state/runs/<label>/enriched.json`; `reports/<label>.md` →
`state/runs/<label>/report.md`). A repo-wide grep catches any straggler path
references in other docs (e.g. `docs/fetching.md`).

## Testing

- Unit-test the new `runpaths` helpers (`listingsPath`/`enrichedPath`/
  `reportPath`) assert they resolve to `state/runs/<label>/{listings.json,
  enriched.json,report.md}` for both a single-day label and a `<from>_<to>`
  label. Register the new test file in `package.json`'s `"test"` script.
- `npm test` stays green; `npx tsc --noEmit` stays green at every task (this
  change is additive helpers + self-contained path swaps — no red-tsc window).
- A repo-wide grep confirms no remaining `state/listings-`, `state/enriched-`,
  or `reports/<label>` writer references in code.

## Safety (per `AGENTS.md`)

Unchanged. `state/` (including `state/runs/`) stays git-ignored; `report.md`
now lives under `state/` so reports are git-ignored by default (consistent with
the run record). Credentials/secrets handling and `redact()` are untouched.

## Implementation

Git worktree, subagent-driven (per the user's standing preference). Small,
~3 tasks: (1) path helpers + tests, (2) thread helpers through steps/enrich/
pipeline, (3) docs.

## Open Questions

None. Report destination (moved into the run dir), filename scheme (drop
redundant label), and route-cache location (stays shared) are decided.
