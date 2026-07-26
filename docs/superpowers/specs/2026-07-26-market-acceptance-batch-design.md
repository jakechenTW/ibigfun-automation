# Market Acceptance Batch Evaluation Design

## Goal

Evaluate backtest acceptance once per listing batch, reject impossible calendar
dates in acceptance artifacts, and ensure coverage and case population use one
held-out eligibility definition.

## Batch-scoped acceptance

Add a decision API that returns whether one loaded market-data bundle has valid
backtest acceptance and, when it does not, the fail-closed reason. The decision
owns the complete transaction-index eligibility scan. `attachMarketEstimates`
computes this decision once before mapping listings and passes it into estimate
enforcement; enforcement never reads or scans the bundle.

An optional diagnostics object records `eligibleTransactionScans`. It is
injected at the batch boundary and incremented by the real coverage scan, so a
regression can prove that N listings cause exactly one scan. The existing
boolean helper may remain as a compatibility wrapper only when it delegates to
the decision API.

A bundle without approval, with a checksum/policy/date mismatch, or with no
eligible transaction returns the same `market-backtest-not-approved`
enforcement reason used today.

## Strict acceptance dates

Acceptance `asOf`, `evaluatedThrough`, and
`latestEligibleTransactionDate` must each pass the repository's centralized
real-calendar `YYYY-MM-DD` validator. Format-only matches such as
`2026-02-30` are invalid. `approvedAt` remains an ISO timestamp validated by
timestamp parsing.

Both artifact reads and writes fail closed on impossible calendar dates.

## One held-out eligibility predicate

Define one held-out transaction eligibility predicate. It parses the
transaction date, validates coordinate, district, ownership, areas, prices,
floors, and building completion, and evaluates age/completion consistency at
the subject transaction date.

The complete-index latest eligible date and actual backtest case population
call this same predicate. `--as-of` filtering remains a separate step applied
before case population. This prevents a later report cutoff from changing a
subject's intrinsic eligibility and prevents completion-date inconsistencies
from appearing in coverage but not cases, or vice versa.

## Tests

- An N-listing integration batch observes exactly one real eligible-index scan.
- Acceptance read/write rejects impossible calendar dates.
- A non-apartment transaction completed after its transaction date is excluded
  from both the latest eligible boundary and case population through the shared
  predicate.
- Existing acceptance mismatch, historical cutoff, and `--no-gate` tests remain
  green.
