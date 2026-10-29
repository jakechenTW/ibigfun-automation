# Run lifecycle implementation

The lifecycle module is `scripts/lib/run-lifecycle.ts`.
Its public operations are `resume`, `mark`, and `fail`.
They own profile selection from saved state, execution order, invalidation, state writes, and journal events.
The CLI parses arguments, renders lifecycle events, and maps outcomes to exit codes.
Recovery selects recorded unfinished runs and calls the same `resume` operation once per item.

## Responsibilities

- `manifest.ts` owns the existing state format, legacy migration, step planning, and downstream invalidation primitives.
- `run.ts` records script attempts, timing, output, and failures.
- `report-delivery.ts` owns report approval and delivery preparation.
- `recovery.ts` selects the ordered backlog and reports unreadable entries.
- `pipeline.ts` owns command parsing, terminal output, and the recovery JSON work list.

The lifecycle module uses the existing state writers and approval operations.
It does not add a state format, migration, retry loop, or concurrent-worker support.
Fetch, enrichment, notification, time, and progress output are injected into the lifecycle module.
Tests use temporary directories for actual manifests, journals, and approved report copies.

## Preserved contracts

The refactor preserves command arguments, exit codes, and recovery JSON fields.
It also preserves the semantics of `--only`, `--force`, and `--dry-run`.
Saved profiles and original ranges remain authoritative during recovery.
A failure alert never completes report delivery.
Approval invalidation returns unfinished work to the report step.
Delivery failure retains approval for a later notification attempt.
Upstream work invalidates downstream steps and approval.
Completed legacy runs remain complete without new approval.

## Existing differences retained for separate decisions

The runbook lists `report`, `complete`, and `failed` recovery outcomes.
The implementation can also return `partial`, including a delivery preview that leaves notification pending.
This refactor retains that outcome and the JSON shape.

Failure previews write `fail-details.md`, as documented in the runbook.
Ordinary run previews do not write manifests, journals, or approval copies.
The commands retain these distinct preview semantics.

The `fail` operation uses the saved profile directly.
The `run` and `mark` operations validate saved profiles and support legacy effective profiles.
This refactor preserves that difference rather than changing malformed-state behavior.

Notification acknowledgement and manifest persistence remain separate operations.
A process interruption between them can cause duplicate delivery.
Do not run concurrent workers for the same profile.
