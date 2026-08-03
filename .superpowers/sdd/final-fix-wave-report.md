# Multi-use Parking Valuation Safe-stop — Final Fix-wave Report

Date: 2026-08-03
Branch: `codex/multi-use-parking-valuation`

## Outcome

The corrected multi-use and parking valuation work remains an evaluation-only
challenger. It was not activated because the completed baseline candidate
failed the frozen flat-parking gate. Daily valuation stays on the exact legacy
production contract and continues to treat `marketEstimate` as authoritative.

| Contract | Build schema | Estimator policy | Acceptance schema | Runtime authority |
|---|---:|---:|---:|---|
| Production | 3 | 4 | 2 | `marketEstimate` and report buckets |
| Challenger | 5 | 6 | 3 | Aggregate candidate evaluation only |

Production and challenger use separate constants, builders, validators, and
load paths. A challenger acceptance cannot attach to or authorize a production
bundle, and schema 4 / policy 5 authorizes neither path.

## Frozen Candidate Result

The completed baseline candidate failed closed for exactly these reasons:

- `parking-family-flat-not-accepted`
- `parking-imputation-comparison-failed`

The frozen thresholds were not changed after observing the result:

- Global production gate: median / P75 APE at most 0.12 / 0.20, estimate
  coverage at least 0.70, at least 20 high- and medium-confidence estimates,
  and high confidence at least 0.01 better than medium.
- Exact-use challenger cohorts: at least 20 scored cases, median / P75 APE at
  most 0.12 / 0.20, absolute bias at most 0.05, and interval coverage at least
  0.30.
- Direct-to-imputed comparison: strict coverage improvement, absolute-bias
  regression at most 0.01, and interval-coverage regression at most 0.05.
- Each parking family: at least 20 masked cases, estimate coverage at least
  0.50, price median / P75 APE at most 0.25 / 0.45, area median / P75 APE at
  most 0.15 / 0.30, and price / area interval coverage each at least 0.30.

Aggregate diagnostics:

| Parking family | Cases | Estimated | Coverage | Price median / P75 APE | Area median / P75 APE | Price / area interval coverage |
|---|---:|---:|---:|---:|---:|---:|
| Flat | 10,671 | 9,467 | 0.8871708368475307 | 0.1 / 0.3264196983141082 | 0.03909952606635073 / 0.374367172928324 | 0.4388929967254674 / 0.5611070032745326 |
| Mechanical | 2,013 | 1,406 | 0.6984600099354198 | 0.06666666666666667 / 0.2 | 0 / 0.2896142433234421 | 0.5903271692745377 / 0.647226173541963 |

Direct-only estimate coverage was `0.7768882226688925`; direct-plus-imputed
coverage was `0.7868701665928525`. Comparison accuracy, absolute-bias
regression, and interval-coverage regression were within their frozen limits,
but activation still failed because both parking families must be accepted and
flat parking missed only the 0.30 area-P75 maximum.

This report contains aggregate diagnostics only. No candidate stdout,
held-out cases, transaction rows, IDs, or addresses were retained.

## Runtime Safety and Authority

- Production loading accepts only the checksum-closed schema-3 / policy-4
  build and its matching aggregate schema-2 acceptance.
- Candidate staging is isolated and disposable, validates schema 5 / policy 6,
  and rejects every publication request.
- `market-data update` is load-only during the freeze: it first recovers an
  interrupted production publication, then returns the existing valid pair
  with `last-known-good` and `challenger-activation-withheld`. It does not
  fetch, rebuild, migrate, advance source timestamps, or publish.
- If recovery itself fails, the retained bundle reports the real recovery
  error instead of masking it with the normal freeze reason; malformed journal
  tests prove the network is not contacted first.
- If no valid production pair exists, valuation remains unavailable rather
  than bootstrapping from the failed challenger.
- `marketEstimate` controls report buckets, the P25 investment gate,
  confidence, freshness, and review status. `marketScenarios` remains labelled
  diagnostic-only and cannot upgrade, downgrade, or replace it.
- Inseparable parking remains review-only under the legacy production policy.

The operational tradeoff is intentional: automatic official-data refresh is
withheld, so source timestamps do not advance. Existing freshness rules will
therefore move stale evidence to `warn` / manual review instead of presenting
it as freshly checked.

## Retained Challenger Corrections

The evaluation-only challenger keeps the corrected official building and
parking counts, partial official parking components, single-space grade-A
training constraint, joint price/area pairs, bounded building-price
uncertainty, family-specific admission gates, uncertainty-aware weights,
exact-use cohort calibration, and aggregate masked-family holdouts. These
changes do not alter production loading or report authority.

## Verification Evidence

All verification below used the final code state after the verification-only
corrections:

- Original failing regression set: 83 / 83 passed.
- Focused 12-suite market-data safety set: 213 / 213 passed.
- Complete repository suite (`npm test`): 465 / 465 passed, 0 failed.
- TypeScript (`npx tsc --noEmit`): exit 0.
- Whitespace/error-marker check (`git diff --check`): exit 0.
- Production-pair tests prove a base-compatible schema-3 / policy-4 build plus
  matching schema-2 acceptance loads and authorizes legacy estimates.
- Byte-identity tests prove load-only ensure, failed candidate evaluation, and
  rejected candidate publication do not change the production manifest,
  transaction checksum, acceptance bytes, or build ID.
- Recovery tests prove interrupted production publication is handled before
  load, malformed journals fail closed before network work, and candidate
  validation cannot cross-authorize production.

No production update, production backtest, real candidate rerun, threshold
change, or local-state publication was performed during this fix wave.

## Changed-file Summary

- Production/challenger provenance and acceptance separation: market-data
  configuration, types, backtest, store, and their tests.
- Frozen update and evaluation-only candidate behavior: updater, CLI,
  candidate staging, and their tests.
- Legacy report authority restoration: enrichment attachment, integration
  tests, runbook, prompts, reporting rules, profiles, and templates.
- Retained challenger corrections: transaction normalization, parking model,
  selector, acceptance policy, and focused regression tests.
- Durable design, implementation plan, and this aggregate-only handoff report.

The working tree review found no `state/` files, candidate stdout, case-level
evidence, or unrelated user files in scope.
