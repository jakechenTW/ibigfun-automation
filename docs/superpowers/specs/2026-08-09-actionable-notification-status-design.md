# Actionable Notification Status Design

## Goal

Make notification status describe run and decision quality instead of treating
every positive result as a warning. A successfully evaluated recommendation or
match may use `ok`; `warn` is reserved for unresolved conditions that affect a
listing the recipient may need to act on, plus run-level freshness or mapping
problems.

## Status Contract

- `ok`: the pipeline completed and no unresolved condition affects a rendered
  candidate or risk item. `ok` is valid for both an empty result and a result
  containing fully supported recommendations or matches.
- `warn`: at least one rendered candidate or risk item needs review, a manual
  walking/location verdict remains unresolved for an actionable item, an
  official source is stale, a coded filter mapping is unverified, or another
  data-quality issue affects safe interpretation of the actionable result.
- `fail`: the monitor cannot complete.

The notification title and report counts continue to carry the result signal
(`推薦`, `符合`, `候選`, `風險`). Status is not a second result bucket.

## Market-Evidence Boundary

Market evidence continues to fail closed for listing classification:
`review`, `unavailable`, low confidence, stale evidence, or inseparable parking
cannot support an automatic recommendation or match.

The pipeline's `ok` validation keeps these run-level invariants:

- the enriched artifact exists and has a structurally valid listing array;
- tenure gates and tenure summary counts are valid;
- market status/freshness fields and market summary counts are structurally
  valid and internally consistent;
- any stale official source rejects `ok`;
- optional valuation reviews remain bound to authoritative enriched evidence.

Fresh `review` or `unavailable` evidence no longer rejects `ok` merely because
it exists somewhere in the fetched set. The report author applies the status
contract after hard exclusions and bucketing: such evidence forces `warn` when
it leaves a rendered candidate or risk item, but not when it belongs only to a
confirmed hard exclusion.

No new report-summary artifact or Markdown parser is introduced. Bucket-aware
status remains part of the agent report decision, while the pipeline enforces
the objective structural and stale-data invariants it can determine from
`enriched.json`.

## Documentation Changes

The shared runbook and notifier contract will say that recommendations and
matches may be `ok`. Candidate, risk, unresolved manual-review, stale-source,
and unverified-mapping outcomes remain `warn`. The owner-occupied profile will
use the same shared semantics instead of warning on every match.

Historical design documents and git-ignored run artifacts are not rewritten.

## Tests

Update the report-notification unit tests first:

- `ok` accepts internally consistent, fresh enrichment containing
  `marketEstimate.status === 'review'`;
- `ok` accepts internally consistent, fresh enrichment containing
  `marketEstimate.status === 'unavailable'`;
- stale evidence, malformed evidence, inconsistent summaries, and invalid
  tenure gates still reject `ok`;
- valuation-review binding remains status-independent.

Run the focused report-notification tests, then the complete `npm test` suite.

## Non-Goals

- Changing recommendation, match, candidate, risk, or exclusion criteria.
- Weakening stale-source handling or market-evidence classification gates.
- Changing notifier transport or adding a new notification status value.
- Reclassifying or resending historical runs.
