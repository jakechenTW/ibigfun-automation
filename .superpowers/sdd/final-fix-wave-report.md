# Multi-use Parking Valuation Activation — Final Fix-wave Report

Date: 2026-08-03
Branch: `codex/multi-use-parking-valuation`

## Outcome

The corrected policy-7 multi-use and parking valuation contract is
activation-ready. A fresh baseline candidate passed every fixed gate. The code
now requires the same complete gate before atomically publishing a schema-5
build and matching schema-3 acceptance. This branch intentionally has not run
that state-changing local publication command.

| Contract | Build schema | Estimator policy | Acceptance schema | Runtime authority |
|---|---:|---:|---:|---|
| Production | 5 | 7 | 3 | `marketEstimate`, approved scenarios, and report buckets |
| Rollback predecessor | 3 / 4 | 4 / 5 | 2 / 3 | Recovery validation only; never runtime authority |
| Candidate | 5 | 7 | 3 | Aggregate evaluation; never publishes |

Candidate staging remains isolated and non-publishing. Production publication
uses the journaled atomic pair promoter only after the policy-7 gate passes;
schema 4 / policy 5 authorizes neither current path.

## Corrected Candidate Result

The earlier policy-6 result was invalidated because a multi-space masked
holdout compared total official parking value against a single-space estimate,
and the Grade-B comparison used global rather than residential-only metrics.
Policy 7 fixes both semantics. The fresh baseline run completed with:

- `passed: true`
- `complete: true`
- `reasons: []`

The fixed thresholds were not changed after observing the result:

- Global production gate: median / P75 APE at most 0.12 / 0.20, estimate
  coverage at least 0.70, at least 20 high- and medium-confidence estimates,
  and high confidence at least 0.01 better than medium.
- Exact-use candidate cohorts: at least 20 scored cases, median / P75 APE at
  most 0.12 / 0.20, absolute bias at most 0.05, and interval coverage at least
  0.30.
- Direct-to-imputed comparison: strict coverage improvement, absolute-bias
  regression at most 0.01, and interval-coverage regression at most 0.05.
- Each parking family: at least 20 masked cases, estimate coverage at least
  0.50, price median / P75 APE at most 0.25 / 0.45, area median / P75 APE at
  most 0.15 / 0.30, and price / area interval coverage each at least 0.30.

Aggregate held-out results:

| Slice | Cases | Estimated | Coverage | Median APE | P75 APE |
|---|---:|---:|---:|---:|---:|
| Overall | 24,025 | 22,331 | 92.949% | 8.321% | 15.357% |
| Reliable | 17,173 | 17,173 | 100% | 7.691% | 14.073% |
| High confidence | 4,862 | 4,862 | 100% | 6.608% | 12.396% |
| Medium confidence | 12,311 | 12,311 | 100% | 8.168% | 14.803% |

Normalization retained 32,476 reliable and 13,725 review-only rows from
73,803 raw rows. Parking grades A/B/C were 40,208 / 4,149 / 1,844; 2,325
Grade-B rows were causally imputed and 1,824 remained unresolved.

Residential direct-only coverage increased from 82.398% to 83.255% with
Grade-B evidence. Median / P75 APE changed only from 8.168% / 14.929% to
8.174% / 14.935%; absolute bias and interval-coverage regressions remained
inside the fixed limits.

| Masked family | Cases | Estimated | Coverage | Price median / P75 APE | Area median / P75 APE | Price / area interval coverage |
|---|---:|---:|---:|---:|---:|---:|
| Flat | 10,509 | 9,348 | 88.952% | 7.143% / 14.449% | 0% / 12.744% | 53.199% / 67.843% |
| Mechanical | 1,977 | 1,385 | 70.056% | 6.015% / 19.355% | 0% / 23.931% | 62.527% / 67.653% |

This report contains aggregate diagnostics only. No candidate stdout,
held-out cases, transaction rows, IDs, or addresses were retained.

## Runtime Safety and Authority

- Production loading requires a checksum-closed schema-5 / policy-7 build and
  matching aggregate schema-3 acceptance. Older accepted pairs are validated
  only long enough for byte-exact publication rollback and never attach to the
  current runtime.
- Candidate staging is isolated and disposable, validates schema 5 / policy 7,
  and rejects every publication request.
- `market-data update` recovers interrupted publication first, then fetches,
  rebuilds, validates, runs the strict gate, and publishes the build/acceptance
  pair atomically only on success. Failure retains last-known-good.
- If recovery itself fails, the retained bundle reports the real recovery
  error instead of masking it with the normal freeze reason; malformed journal
  tests prove the network is not contacted first.
- If no valid production pair exists and the fresh candidate fails, valuation
  remains unavailable.
- `marketEstimate` controls the conservative P25 investment gate, confidence,
  freshness, and review status. `marketScenarios` can contribute only for use
  cohorts and parking families explicitly approved by the matching acceptance.
- Unsupported or unresolved parking evidence remains review-only.

## Fix Wave 3 Hardening

- Schema-5 validation now recomputes every persisted building price, area, and
  unit price from total minus parking values. Builder and loader share the same
  pure arithmetic helpers.
- Grade-B validation recomputes scalar/P50 and price/area IQR relationships,
  building-bound P50 and relative IQR, joint P50 building arithmetic, and any
  official price/area component across all persisted joint pairs. Positive but
  checksum-consistent tampering therefore fails closed.
- Publication recovery validates a predecessor acceptance against its own exact
  contract: schema-3/policy-4/acceptance-2 or
  schema-4/policy-5/acceptance-3. Fault injection after the build renames proves
  both build and acceptance bytes roll back atomically; neither predecessor can
  authorize a current runtime load.
- A normal update whose strict gate fails removes staging and returns an
  existing accepted bundle as `last-known-good`, including the explicit gate
  reasons and exit-3 semantics. With no accepted bundle it remains unavailable.

## Activated Model Corrections

Policy 7 keeps the corrected official building and
parking counts, partial official parking components, single-space grade-A
training constraint, joint price/area pairs, bounded building-price
uncertainty, family-specific admission gates, uncertainty-aware weights,
exact-use cohort calibration, and aggregate masked-family holdouts.

## Verification Evidence

All verification below used the final code state after the third fix wave:

- Complete repository suite (`npm test`): 491 / 491 passed, 0 failed.
- TypeScript (`npx tsc --noEmit`): exit 0.
- Whitespace/error-marker check (`git diff --check`): exit 0.
- Production-pair tests prove schema-5 / policy-7 plus matching schema-3
  acceptance loads, while predecessor pairs remain rollback-only.
- Byte-identity tests prove pending-journal candidate refusal, failed candidate
  evaluation, and rejected candidate publication do not change the production manifest,
  transaction checksum, acceptance bytes, or build ID.
- Recovery tests prove interrupted production publication is handled before
  load, malformed journals fail closed before network work, and candidate
  validation cannot cross-authorize production.
- Arithmetic tamper tests cover nine independent derived-value mutations plus
  contradictory official price/area pair totals; all use checksum-consistent
  files, and a valid Grade-B row remains accepted.

The real baseline candidate was rerun and passed. Its disposable stage was
removed and no acceptance or production state was published. No production
update or production backtest was performed. The pre-existing local pair
remains schema 4 / policy 5 / acceptance schema 3 and is rejected by the
activated schema-5 / policy-7 loader until an approved update publishes a new
pair.

## Changed-file Summary

- Production/candidate provenance and acceptance separation: market-data
  configuration, types, backtest, store, and their tests.
- Gated atomic update and evaluation-only candidate behavior: updater, CLI,
  candidate staging, and their tests.
- Report authority and rollback-only predecessor handling: enrichment attachment, integration
  tests, runbook, prompts, reporting rules, profiles, and templates.
- Activated candidate corrections: transaction normalization, parking model,
  selector, acceptance policy, and focused regression tests.
- Durable design, implementation plan, and this aggregate-only handoff report.

The working tree review found no `state/` files, candidate stdout, case-level
evidence, or unrelated user files in scope.
