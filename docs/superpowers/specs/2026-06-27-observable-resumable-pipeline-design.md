# Observable / Debuggable / Resumable Pipeline — Design

Date: 2026-06-27
Status: Approved (pending implementation)

## Problem

The daily iBigFun monitor runs as a multi-step pipeline (fetch → enrich →
agent report → notify). Today it is hard to operate when something goes wrong:

- **Mid-run failure means starting over.** If `fetch` dies partway through the
  per-listing history pool (kick / 429 / network), the whole step is lost and
  must re-login, re-paginate, and re-fetch everything — wasted time and account
  risk.
- **No post-hoc visibility.** After a run (or failure) there is only scattered
  `console.error` output. It is hard to answer "which listings were dropped and
  why", "which step failed", or "how does today differ from yesterday".
- **Hard to debug in situ.** A failure lacks captured context (which call, which
  listing, request/response metadata); diagnosing means adding prints and
  re-running.
- **Cannot re-run only the broken step.** No mechanism to resume just the failed
  step or stage.

## Goals

Make the whole pipeline **observable**, **debuggable**, and **resumable** at
**step granularity**, with a thin orchestrator and a shared per-run record.
Steps: `fetch` (script) → `enrich` (script) → `report` (agent) →
`notify` (script). Stay dependency-free (fs + JSONL), consistent with the
repo's lean style. Honor `AGENTS.md` safety rules (no secrets in any artifact).

## Non-Goals

- Within-step resume (e.g., resuming the history pool mid-way). Step-level
  resume only; existing caches (`route-cache.json`) already make `enrich`
  re-runs cheap.
- Replacing agent judgment with automation. The `report` step stays agent-driven
  (triage, estimate, evaluate, write). The orchestrator only tracks it.
- A database / job-queue / new dependencies.

## Architecture

### Run identity & directory

One **target date = one run**. Run directory: `state/runs/<date>/` (under
`state/`, already git-ignored). Contains exactly two files; produced artifacts
stay in their current locations and are referenced by path:

- `manifest.json` — the resumable state machine (source of truth for "what is
  done").
- `journal.jsonl` — append-only event timeline (the observability + debug
  surface).

Artifacts referenced (unchanged locations): `state/listings-<date>.json`,
`state/enriched-<date>.json`, `reports/<date>.md`.

### `manifest.json`

```json
{
  "targetDate": "2026-06-26",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "notify": { "status": "warn", "title": "<short>" },
  "steps": {
    "fetch":  { "kind": "script", "status": "ok", "attempt": 2,
                "startedAt": "ISO", "endedAt": "ISO", "durationMs": 1234,
                "artifacts": ["state/listings-2026-06-26.json"],
                "summary": { "listings": 87, "historyDropped": 3 },
                "error": null },
    "enrich": { "kind": "script", "status": "ok",
                "summary": { "withinWalk": 40, "manualReview": 5,
                             "orsCalls": 12, "cacheHits": 60, "routeErrors": 0 } },
    "report": { "kind": "agent",  "status": "pending",
                "artifacts": ["reports/2026-06-26.md"] },
    "notify": { "kind": "script", "status": "pending" }
  }
}
```

- `status`: `pending | running | ok | failed | skipped`.
- `kind`: `script | agent`.
- `error`: `{ message, where }` or `null`.
- `summary`: free-form metrics per step.
- Run-level `notify`: `{ status: ok|warn|fail, title }` — set when the agent
  marks `report`; consumed by the `notify` step (see below).

### `journal.jsonl`

Append-only, one JSON event per line:

```json
{ "ts": "ISO", "step": "fetch", "level": "info|warn|error",
  "event": "step.start|step.end|history.drop|route.error|...",
  "msg": "human-readable", "data": { } }
```

Replaces scattered `console.error`/WARN with structured events
(`history.drop`, `route.error`, step start/end, etc.). On failure, `data`
carries the **debug context**: `url` (path only), `httpStatus`, `contentType`,
`listingId`, response `snippet` — all passed through `redact()`.

### Thin orchestrator — `scripts/pipeline.ts`

`npm run pipeline -- <command>`:

- **`run [--date <d>] [--from <step>] [--only <step>] [--force <step>]`**
  - Load or create the manifest for the date.
  - Iterate steps in order `[fetch, enrich, report, notify]`.
  - Already `ok` (and not forced) → skip (record a `step.skip` event).
  - `script` step → invoke its step fn; on success mark `ok` + `summary` +
    `artifacts`; on throw mark `failed` + `error` and stop.
  - `agent` step (`report`) → orchestrator cannot auto-run it: print what the
    step requires and the exact `mark` command to run when done, then stop.
  - **Resume = run again.** `ok` steps are skipped; execution picks up at the
    first non-`ok` step.
- **`status [--date <d>]`** — render manifest + journal tail: per-step
  status / duration / summary, and the last `error` with its captured context.
- **`mark <step> --status ok|failed [--artifact <path>] [--summary k=v ...]
  [--status-notify ok|warn|fail] [--title "<short>"] [--note ...]`** — for the
  agent `report` step. Marking `report ok` **requires** `--status-notify` and
  `--title`; they are stored in the run-level `notify` object for the `notify`
  step.

### `notify` step (auto-run script wrapper, with guards)

A script step that composes the canonical `ai-notify` command from a single
in-code template and runs it automatically:

```
ai-notify --tool <codex|claude> --status <notify.status> \
  --task "每日 iBigFun 投資房源監測" --title "<notify.title>" \
  --details-file reports/<date>.md
```

- Inputs: run-level `notify.status` + `notify.title` (set at `report` mark) and
  the report artifact path. If either is missing → fail the step with a clear
  message (do not send a malformed notification).
- **Guard 1 — idempotency:** if `notify` is already `ok`, skip (no double-send).
- **Guard 2 — `--dry-run`:** `pipeline run --dry-run` (or `--only notify
  --dry-run`) prints the fully composed command without sending; used for
  debugging or when unsure. Normal scheduled runs send for real.
- Captures `ai-notify` exit code / stderr into the manifest + journal so "did
  the notification actually send?" is answerable.

### Integration with existing steps (minimal intrusion)

New `scripts/lib/run.ts` provides:

- Run-dir resolution, manifest read/write, `appendJournal(event)`.
- `runStep(name, fn)` — wraps a step: `running` → time it → `ok`/`failed`,
  capture `error`, append `step.start`/`step.end`.
- A `Logger` injected into steps so their events flow to the journal.
- `planNextSteps(manifest, opts)` — **pure** function: given a manifest and run
  options, return which steps to run / skip. This is the resume logic, unit
  tested in isolation.

`fetch`/`enrich` core logic gains an optional `logger`:

- Under the pipeline → emit journal events (`history.drop`, `route.error`,
  summaries).
- Run standalone (`npm run fetch`) → keep current `console.error` behavior.
- Existing CLIs (`npm run fetch` / `enrich` / `route`) keep working
  independently.

### Safety (per `AGENTS.md`)

- Confirm `.gitignore` covers `state/runs/` (`state/` is already ignored —
  verify the run dir falls under it).
- Everything written to `journal.jsonl` passes `redact()`: **never** write
  `IBIGFUN_ACCOUNT` / `IBIGFUN_PASSWORD`, cookies, `Set-Cookie`, or the login
  POST body. Capture only URL path, HTTP status, content type, listing id, and a
  short response snippet (HTML stripped, length-capped).
- The login step logs only `login ok/failed`, never request bodies.

## Testing (TDD, `node:test`, zero deps)

Pure units, all offline:

- `planNextSteps(manifest, opts)` — resume selection: skip `ok`, stop at first
  `failed`, honor `--from/--only/--force`, idempotent notify skip.
- Manifest transitions — `pending → running → ok/failed`, `skipped` when `ok`.
- `journal` append + event shape.
- `redact()` — strips credentials / cookies / Set-Cookie / login body; keeps
  safe debug fields.
- Summary extraction for `fetch`/`enrich`.
- `notify` command composition from `{status, title, date}` (string assembly
  only; `--dry-run` path asserts the composed command without executing).

## Implementation Workspace

Implementation happens in an isolated **git worktree** (per the user's request),
created at the transition to the implementation plan (`using-git-worktrees`).

## Open Questions

None outstanding. Step count (4), resume granularity (step-level), orchestration
model (shared journal + thin orchestrator), and notify mechanism (auto script
wrapper + idempotency + `--dry-run`) are all decided.
