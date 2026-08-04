# Decouple Market Refresh from Daily Enrich

## Problem

The daily property pipeline currently calls `ensureTaipeiMarketData` from the
`enrich` step. That function is a write path: it checks official sources,
rebuilds the staged doorplate and transaction indexes, runs the complete
Policy-7 backtest, and publishes an accepted build/acceptance pair.

The Policy-7 build contains roughly 46,000 retained transactions and its full
backtest takes about 15 minutes on the current machine. Both profile runs repeat
that work even when the official sources have not changed. The headless worker
therefore times out before enrichment begins. A run with zero listings also
pays the full refresh cost. Because ORS routing happens only after market data
is ready, the investment run's reported ORS stall was a misclassification.

## Goals

- Run official market-data refresh and complete backtesting once per day in a
  dedicated job.
- Make property enrichment a read-only consumer of the most recent validated,
  accepted market-data build.
- Preserve all existing fail-closed valuation rules. Missing, invalid,
  unaccepted, or stale evidence must never produce an automatic recommendation.
- Allow an empty listing run to complete without network routing or expensive
  market-data work.
- Make timeout/failure classification reflect the component that actually
  stalled.
- Preserve the explicit `market-data update`, candidate, and backtest commands
  and their atomic publication guarantees.

## Non-Goals

- Do not weaken the Policy-7 gates, freshness thresholds, acceptance binding,
  checksum closure, or publication recovery rules.
- Do not add background work inside the property pipeline.
- Do not change listing fetch filters, valuation formulas, report buckets, or
  notification semantics.
- Do not make `enrich` silently fall back to an unvalidated staging build.

## Considered Approaches

### 1. Dedicated refresh job and read-only enrichment (selected)

The explicit market-data update command remains the only normal daily write
path. Enrichment loads the active build and matching acceptance artifact without
checking remote sources or creating staging state.

This removes the expensive shared dependency from both property runs, keeps the
security boundary easy to audit, and makes a failed refresh independent of the
property monitor. The trade-off is that scheduling must run the refresh job
before the profile jobs.

### 2. Conditional refresh inside enrichment

Enrichment could issue conditional requests and rebuild only when a source
changed. Normal days would be faster, but the first source-change day would
still turn a property run into a 15-minute build/backtest. It also retains the
undesired coupling between reporting and market-data publication.

### 3. Increase the headless timeout

A longer timeout would avoid today's immediate failure but would repeat the
same full backtest for every profile. Runtime would grow with future Policy-7
work and the reported component could still be wrong. This treats the symptom
rather than the lifecycle problem.

## Architecture

### Market-data writer

`npm run market-data -- update --city taipei` remains the sole scheduled refresh
entrypoint. It owns source checks, staged index construction, full backtesting,
gate evaluation, recovery, and atomic publication of the active build plus its
acceptance artifact.

The refresh runs once per Taipei calendar day before property monitoring. If it
publishes a valid pair, later enrich jobs see that pair. If it cannot publish,
the active last-known-good pair remains untouched and the refresh job reports
its existing non-success status. Property runs may still use that pair subject
to the existing freshness rules.

### Market-data reader

The enrich step uses a focused read-only loader. The loader:

1. recovers no publication and acquires no refresh lock;
2. performs no network calls and creates no staging directory;
3. validates the checksum-closed active build using the existing production
   minimums;
4. attaches the acceptance artifact only when its schema, estimator policy,
   transaction checksum, policy ID, and evaluated coverage match;
5. returns `null` when no valid active build exists.

The implementation should reuse `loadMarketData` and its existing validation
contract rather than introduce a second definition of build validity. A thin
reader function may provide logging and production minimums, but must not call
`ensureTaipeiMarketData`.

### Enrichment flow

After reading `listings.json`, enrichment loads the validated active market
bundle and logs either:

- `market-data.ready` with the active build ID and freshness flags; or
- `market-data.unavailable` when no validated active build is available.

It then performs offline parsing, ORS routing when needed, valuation attachment,
and artifact writing as today. When the bundle is unavailable, the existing
market-estimate fallback marks evidence unavailable and prevents automatic
recommendation.

An input with zero listings still loads the local bundle so the run can report
the source freshness consistently, but it performs zero ORS requests and writes
an empty, successful `enriched.json`. Loading is local validation only and must
not rebuild or backtest.

## Scheduling and Operations

The scheduling documentation will define this order:

1. Run the market-data update job once.
2. Wait for it to finish or retain last-known-good state.
3. Run the investment profile.
4. Run the owner-occupied profile after the existing shared-login spacing.

The two property jobs must not invoke the update command as a recovery action.
If the refresh fails, operators inspect or rerun the independent refresh job.
Property jobs continue only with a locally validated active pair and rely on
the report's existing stale-data warning and recommendation gates.

The daily worker and trigger documentation must distinguish these stages. A
property worker that has not logged `market-data.ready` cannot classify a stall
as ORS work, because routing starts later. Failure text must name market-data
loading/validation until readiness is logged, and ORS only after the first
routing activity is observable.

## Failure and Safety Behavior

- **Refresh succeeds:** publish the new accepted pair atomically; property runs
  consume it read-only.
- **Refresh source or gate failure with last-known-good:** retain the old pair;
  the refresh job reports its non-success status. Property valuation follows
  normal freshness and acceptance checks.
- **Missing or invalid active pair:** enrichment completes with unavailable
  market estimates where listings exist. It must not load staging or backup
  artifacts.
- **Acceptance mismatch:** the loader omits invalid acceptance and the existing
  valuation enforcement prevents reliable recommendations.
- **Stale active pair:** preserve existing `warn` notification behavior and
  prohibit automatic recommendations.
- **ORS failure:** preserve the existing partial-failure policy: affected walks
  become manual review and the report can still complete with `warn`.
- **Zero listings:** write a successful empty enrichment artifact with zero ORS
  calls.

## Interfaces and Files

Expected implementation scope:

- `scripts/lib/steps.ts`: replace the write-path market-data call with the
  read-only production loader and keep readiness/freshness logging.
- `scripts/lib/market-data/store.ts` or a small focused reader module: expose a
  read-only production load operation using the existing validation rules.
- Relevant tests under `scripts/lib/market-data/` and the step test suite: prove
  that enrichment does not refresh, invalid evidence fails closed, and empty
  runs avoid routing.
- `prompts/daily-run.md`, `prompts/schedule-triggers.md`, `AGENTS.md`, and the
  market-data operator documentation: describe the separate refresh lifecycle
  and accurate stall classification.

No new runtime dependency or state-file schema is required.

## Testing Strategy

Tests are written before production changes and cover these observable
behaviors:

1. The production reader returns an accepted active pair without calling any
   source fetcher, building indexes, running a backtest, taking the refresh
   lock, or creating staging state.
2. A missing active build returns `null` and enrichment produces unavailable
   estimates rather than throwing or refreshing.
3. A build with missing or mismatched acceptance cannot produce a reliable
   estimate.
4. An empty listing input writes a successful empty enrichment result with zero
   ORS calls.
5. Explicit `market-data update` still performs the full gated candidate flow,
   preserves last-known-good on failure, and publishes a validated pair on
   success.
6. Existing focused market-data tests, type checking, and the full `npm test`
   suite pass.

## Acceptance Criteria

- A normal profile `enrich` performs no official-source network request, index
  rebuild, full backtest, or market-data publication.
- Both profiles can reuse the same active accepted market-data pair.
- A zero-listing profile run reaches the report step successfully.
- Invalid, missing, stale, or unaccepted evidence cannot create an automatic
  recommendation.
- The explicit refresh command retains all current Policy-7 gates and atomic
  publication behavior.
- Operational documentation schedules one daily refresh before the sequential
  profile jobs and no longer labels pre-readiness stalls as ORS stalls.
