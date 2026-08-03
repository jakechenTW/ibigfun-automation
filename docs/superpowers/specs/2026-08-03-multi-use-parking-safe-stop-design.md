# Multi-use Parking Valuation Safe-stop Design

## Outcome

Keep the corrected multi-use and parking valuation work as a challenger, but
do not activate it after the 2026-08-03 baseline candidate failed its frozen
production gate. Daily reports continue to use the exact production contract
from merge base `ab54d11`: market-data build schema 3, estimator policy 4,
aggregate acceptance schema 2, and `marketEstimate` as the report authority.

The challenger remains build schema 5, estimator policy 6, with a strict
aggregate-only candidate acceptance schema 3. No artifact from schema 4 / policy
5 or schema 5 / policy 6 may authorize production reporting.

## Candidate evidence

The baseline evaluation was complete and failed closed with
`parking-family-flat-not-accepted` and
`parking-imputation-comparison-failed`. No thresholds were changed after seeing
the result.

- Flat parking: 10,671 masked cases, 88.72% estimate coverage, 10.00% / 32.64%
  price median / P75 APE, 3.91% / 37.44% area median / P75 APE, and 43.89% /
  56.11% price / area interval coverage. Only area P75 APE missed its frozen
  30% maximum.
- Mechanical parking: 2,013 masked cases, 69.85% estimate coverage, 6.67% /
  20.00% price median / P75 APE, 0.00% / 28.96% area median / P75 APE, and
  59.03% / 64.72% price / area interval coverage. It passed every frozen gate.
- Direct-to-imputed comparison improved estimate coverage from 77.69% to
  78.69%; its error, absolute-bias regression, and interval-coverage regression
  remained inside the frozen limits. The comparison still failed because
  activation requires both parking families to be accepted.

These are aggregate diagnostics only. The repository must not retain raw
candidate stdout, held-out cases, transaction rows, IDs, or addresses.

## Version and validation boundaries

Production and challenger provenance are separate constants and validators:

| Contract | Build schema | Estimator policy | Acceptance schema | Authority |
|---|---:|---:|---:|---|
| Production | 3 | 4 | 2 | `marketEstimate` and daily reports |
| Challenger | 5 | 6 | 3 | candidate evaluation only |

`loadMarketData`, `readBacktestAcceptance`, production backtest persistence,
and report enrichment use only the production contract. Candidate staging uses
a separate schema-5 validator and a separate strict policy-6 acceptance
validator. Candidate acceptance is never attached to a production bundle.

The schema-5 validator preserves the corrected transaction-count fields,
partial official parking components, joint price/area evidence, bounded
building-unit-price uncertainty, exact normalization diagnostics, use-cohort
checks, and family-specific masked holdouts. Its strictness must not make an
existing valid schema-3 / policy-4 production pair unloadable.

## Runtime and update behavior

While challenger activation is withheld:

1. Daily enrichment recovers any interrupted production publication, loads the
   existing schema-3 / policy-4 build and matching schema-2 acceptance, and
   continues legacy valuation.
2. It does not run a schema-5 challenger build as an implicit refresh.
3. `market-data candidate` may build and evaluate schema 5 / policy 6, but it
   cannot publish or replace production files.
4. `market-data update` must not relabel candidate semantics as policy 4 or
   mutate the active pair. It returns the existing production bundle with an
   explicit refresh-withheld warning and a non-success update status.
5. If no valid production pair exists, daily valuation is unavailable. It must
   not bootstrap from the failed challenger.
6. Source timestamps are not advanced during the freeze. Existing freshness
   rules therefore turn stale evidence into `warn` / manual review rather than
   presenting it as freshly checked.

A later activation requires a deliberate code change, a passing candidate with
the same predeclared gates, a version/provenance review, and normal publication.
A future data-only pass cannot silently activate this branch.

## Report authority

Restore the pre-activation reporting contract in `AGENTS.md`, the headless
worker prompt, shared reporting rules, profile evaluation rules, and report
templates:

- `marketEstimate` is authoritative for buckets, P25 investment gates,
  confidence, freshness, and review status.
- Listings whose parking price and area are not separable remain review-only
  under the production policy.
- `marketScenarios` may remain in enriched output as clearly labelled
  non-authoritative challenger diagnostics. It cannot downgrade, upgrade, or
  replace `marketEstimate`, and it does not control report buckets.
- The location conflict/uncertainty safety fixes apply to both legacy output and
  challenger diagnostics because they are independent data-quality safeguards.

## Failure safety and tests

Tests must establish the following boundaries before implementation is
considered complete:

- The runtime constants are production schema 3 / policy 4, while challenger
  constants remain schema 5 / policy 6.
- A checksum-closed base-compatible schema-3 / policy-4 build plus matching
  schema-2 acceptance loads and authorizes legacy estimates.
- Strict candidate validation accepts only schema 5 / policy 6 and never makes
  that bundle loadable through the production loader.
- A failed candidate and a candidate publish request leave the production
  manifest, transaction checksum, acceptance bytes, and build ID unchanged.
- `market-data update` cannot mutate the production pair while activation is
  withheld and reports the freeze explicitly.
- Daily attachment keeps a valid legacy `marketEstimate` authoritative even
  when challenger scenarios are unavailable or rejected.
- Existing trainer-count, partial-component, joint-pair, uncertainty,
  location, family-gate, strict-shape, and no-raw-evidence tests remain green.
- The complete test suite, TypeScript check, and diff whitespace check pass.

No production update, production backtest, threshold change, or local-state
publication is part of this safe-stop change.
