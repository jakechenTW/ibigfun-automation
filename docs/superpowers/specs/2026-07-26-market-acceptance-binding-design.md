# Market Backtest Acceptance Binding Design

## Goal

Make a passing backtest acceptance valid only for the exact estimator policy
and complete transaction history that it evaluated. Any mismatch must keep
production estimates in review.

## Policy identity

Add an explicit `ESTIMATOR_POLICY_VERSION` constant. Persist it in every
acceptance artifact and require an exact match when the artifact is written,
read, attached to a market-data bundle, and used to authorize reliable
estimates.

This version is an intentional compatibility contract, not a data schema
version. Any change to comparable selection stages, weighting, outlier
handling, confidence, estimate status, or backtest semantics must bump it.
Keeping the version explicit makes semantic review mandatory; a derived hash
could omit behavior that is not represented by configuration constants.

## Temporal coverage

Backtesting computes `latestEligibleTransactionDate` from the complete,
deduplicated active transaction index before filtering cases by `--as-of`.
Eligibility uses the same held-out-subject requirements as the backtest.

The report carries that date. The quality gate fails with
`incomplete-active-transaction-coverage` when `asOf` is earlier, so a historical
run cannot approve the current artifact. A passing acceptance persists both:

- `evaluatedThrough`, equal to the report's `asOf`;
- `latestEligibleTransactionDate`, equal to the complete index's latest
  eligible date.

At runtime, acceptance requires an exact transaction checksum, exact estimator
policy version, exact current latest eligible date, and
`evaluatedThrough >= latestEligibleTransactionDate`. A newer eligible
transaction therefore invalidates an old cutoff even when index schema stays
unchanged. An index with no eligible transactions cannot pass the existing
completeness gate.

## CLI and persistence

A normal gated run writes acceptance only when accuracy, confidence
calibration, and complete-index temporal coverage all pass. `--no-gate`
continues to print diagnostics and never writes or updates acceptance.
Malformed or stale artifacts are ignored rather than weakening active build
validation.

## Tests

- Configuration test fixes the intentional policy identity.
- Backtest tests prove a historical cutoff fails the gate and a complete cutoff
  can form acceptance with the required fields.
- Store tests reject policy-version, evaluated-through, and latest-date
  mismatches against the active index.
- Integration tests prove policy mismatch and newly added eligible transaction
  history downgrade an otherwise reliable estimate to review.
- Focused tests, TypeScript, the full test suite, and `git diff --check` provide
  completion evidence.
