# Taipei Market-Data Operations

This guide operates the local, evidence-carrying market-price baseline used by
enrichment. It currently supports **Taipei City only** and is designed for the
`example-investment` profile. It does not replace the report rules in
[`reporting-rules.md`](reporting-rules.md): an estimate with weak evidence stays
in review rather than becoming an automatic recommendation.

## Sources, scope, and credentials

The build uses two public official sources:

- Taipei City Government's [臺北市門牌位置數值資料](https://data.taipei/dataset/detail?id=b7c8e724-1e98-45ee-a0bd-f3840623ed97), the local doorplate geocoder. Check the dataset page for its current release terms and comply with the official [Government Open Data License, version 1.0](https://data.gov.tw/license) when that is the release's stated license.
- Ministry of the Interior [real-price open-data download](https://plvr.land.moi.gov.tw/DownloadOpenData) and its [data.gov.tw dataset record](https://data.gov.tw/dataset/139700), for official sale transactions. The official [Government Open Data License, version 1.0](https://data.gov.tw/license) is the license text; confirm the dataset record's current license and attribution requirement before reuse.

No API key, TGOS key, or online geocoder is required. The market-data update
uses the public sources directly; iBigFun credentials and `ORS_API_KEY` are
unrelated to it. Do not add a market-data credential to `.env`.

Only Taipei City is indexed. A listing can receive an automatic estimate only
when its iBigFun result preserves server-side building-type provenance:

- `house_type=16` maps to `apartment`.
- `house_type=17` maps to `midrise` at 10 floors or fewer and `highrise` at 11 or more.

The fetcher records this as `queryHouseType` and `buildingType`; it never
guesses the type from title text or room layout. Untyped listings remain
`unavailable` for automatic valuation.

## Local build lifecycle

The active build is entirely local and git-ignored:

```text
state/market-data/taipei/
  manifest.json
  doorplates-index.json
  transactions-index.json
  raw/
    doorplate-detail.html
    doorplates.csv
    transactions/<season>.zip
    transactions/<season>.csv
state/market-data/taipei-backtest-acceptance.json
state/market-data/backtests/taipei/
  <date>.json
```

`state/` must never be committed. It contains raw public source files,
derived indexes, manifests, checksums, aggregate backtest acceptance, and any
local backtest captures; it can also contain listing evidence elsewhere under
`state/runs/`. The active `state/market-data/taipei/` directory is
checksum-closed: every file in it must be declared in its manifest. Never put
diagnostics or other ad-hoc files there, because an undeclared file invalidates
the active build. Do not paste raw transactions or a listing's full comparable
set into notifications.

### Address evidence and transaction eligibility

Doorplate construction and official transaction lookup use the same
`baseDoorplateKey`: city, district, road, optional section/lane/alley, main
number, and optional sub-number. Only an empty suffix or the explicit
floor/unit grammar is eligible for exact matching: a positive floor (optionally
`地下`) with an optional `之<unit>` / `<unit>室`, or a positive terminal
`<unit>室`. Fullwidth and Chinese numerals are normalized before this check.
The accepted suffix is not part of the key, so an official address such as
`...1號四樓之12` can match the `...1號` base doorplate. Approximate or malformed
tails such as `附近`, `隔壁巷`, or an incomplete floor/unit marker remain
unresolved. If retained official rows share one base key, exact lookup is
allowed only when every row has exactly identical latitude and longitude;
coordinate-conflicting keys remain unresolved instead of selecting an
arbitrary row. This is matching normalization, not evidence destruction: every
indexed transaction retains the original address and the full
`LocationEvidence` (`normalizedAddress`, `matchedAddress`, method, coordinate,
uncertainty, confidence, and dataset version). Missing structural address parts
are never inferred from marketing prose.

Normalization assigns each usable official row one production class before
selection:

- `reliable-eligible`: `住家用`, exactly one transferred building, and all
  existing general-market, building-type, freehold, floor/area/price/date,
  location, unit-price, and separable-parking checks pass. Only this class can
  count toward a reliable estimate or the held-out coverage denominator.
- `review-only`: `住商用` or a transaction containing multiple transferred
  buildings. The row remains in the local index as explicit audit evidence but
  never fills the three-comparable reliable minimum. If these are the only
  otherwise matching rows, the estimate is `review` with no computed
  median/P25/P75.
- `excluded`: blank or non-residential primary use, government sale, explicit
  special/non-freehold transaction, unsupported type, unresolved location,
  invalid or contradictory required values, inseparable parking, and other
  hard failures. Excluded rows do not enter the transaction index.

The schema-2 manifest publishes only aggregate normalization totals:
`rawRows`, `reliableEligible`, `reviewOnly`, `excluded`, and
`excludedByReason`. Full rows and addresses remain only in git-ignored local
evidence.

Run an explicit initial build (or a manual refresh) with network access:

```bash
npm run market-data -- update --city taipei
```

The command prints the published build ID, source check timestamps, publication
metadata when available, record counts, and freshness. A production build is
published only after index, coordinate, checksum, minimum-count, complete
backtest, and acceptance validation. The candidate directory and its
checksum-bound schema-2 acceptance are promoted transactionally; the published
pair therefore has the same transaction-index checksum, active policy id,
estimator policy version, and latest eligible transaction-date coverage.
Unchanged source checks may use the lightweight `not-modified` path only when
the active build already has matching current-policy acceptance. Missing,
outdated, or otherwise invalid acceptance forces a full rebuild and gate even
when source bytes are unchanged, because eligibility/location semantics may
have changed without changing the downloaded source files.

Enrichment also calls the same updater once per run before estimates are
attached. It performs a lightweight online source check without credentials:
the doorplate resource and the current/prior transaction seasons use HTTP
validators, while unchanged historic seasons are reused from the active raw
build when their checksum matches. Thus the first enrichment attempts to build
the index automatically; it is not an offline-only operation. Run the explicit
command first when you want to establish or inspect a build deliberately.

The current MOI season is allowed to be temporarily unpublished only in one
fail-closed branch: that season has no prior source in the active manifest and
the official ZIP download ends with the explicit `FILE_ENDED` signal. The
updater emits `market-data.current-season-unavailable`, skips only that current
season, and builds from completed seasons. Any other current-season error—or
the same signal when an old source exists—remains a refresh failure. When the
completed-season source checks succeed, either a completed-season candidate can
pass validation/acceptance and publish or the previously accepted unchanged
build can revalidate with advanced successful check timestamps. Both can remain
fresh; this explicit warning is neither silent stale data nor a last-known-good
refresh failure.

If a download, source layout, ZIP, CSV, or validation check fails, no staged
data is published. A valid active build remains the last-known-good build; if
none exists, enrichment continues with independent fields and sets
`marketEstimate.status` to `unavailable`. The active manifest describes the
last successful build, not an error log. Pipeline enrichment journals the
current refresh outcome. When the standalone `market-data update` retains an
existing build after a refresh failure, it prints a redacted warning with the
retained build identity and exits `3`; it must not be interpreted as a fresh
publication. The active build and its previously matching acceptance remain
unchanged. If no active build exists, the command fails and enrichment keeps
market evidence unavailable rather than publishing an unaccepted candidate.

Freshness is measured from successful source checks at the report's target
date: transaction data is stale after 30 days and doorplate data after 60 days.
A stale source makes affected estimates review-only, prevents automatic
recommendations, and requires notification status `warn`.

### Recovering from a bad refresh

Do not edit indexes or `manifest.json` in place. A failed refresh automatically
keeps the prior active directory. Accepted publication durably records a fixed
sibling `.taipei-publication-journal.json`, a publication-ID-scoped build
backup, and (when present) an on-disk old-acceptance backup before any active
rename. Update and production backtest entrypoints recover that journal under
the same writer lock before loading the active build. Journal phase, UUID,
basenames, build IDs, and checksums are validated before deriving any path;
restart recovery then completes a validated new build/acceptance pair or
restores the validated old pair. A reader in an intermediate window still
fails closed because mismatched acceptance is never attached.

After pair validation—the commit point—backup/journal cleanup is best effort;
a cleanup failure does not roll back the committed pair, and the next locked
entry retries recovery. These temporary recovery files are not durable rollback
archives. Before an intentional refresh that needs a manual rollback point,
stop concurrent runs and make a local copy of the validated directory outside
the active path, for example:

```bash
cp -a state/market-data/taipei state/market-data/taipei.snapshot-2026-07-26
```

Keep that snapshot under `state/` (still untracked). If a newly published build
is later found unsuitable, stop enrich jobs, move the active directory aside,
and restore the previously validated snapshot as the active
`state/market-data/taipei/` directory. Re-run the offline backtest below before
resuming. Never use an incomplete staging directory as a rollback candidate.

## Daily report evidence

After a normal pipeline run, open the relevant
`state/runs/<profile>/<label>/enriched.json`. Each listing's `marketEstimate`
contains the selected stage, median/P25/P75 unit prices, confidence, freshness,
included comparables, excluded candidates, distance bounds, location precision,
and every weight component. Inspect it locally; source addresses and individual
transactions are evidence, not notification content.

For example, the following prints one listing's valuation evidence without
modifying the run artifact:

```bash
node --input-type=module -e 'import { readFileSync } from "node:fs"; const [file, id] = process.argv.slice(1); const { listings } = JSON.parse(readFileSync(file, "utf8")); const listing = listings.find((item) => String(item.id) === id); if (!listing) throw new Error(`listing ${id} not found`); console.log(JSON.stringify({ id: listing.id, title: listing.title, buildingType: listing.buildingType, marketEstimate: listing.marketEstimate }, null, 2));' state/runs/example-investment/2026-07-26/enriched.json 123
```

Use `askingPremiumConservative` (the P25-based premium) for the investment
gate. A transaction index without a matching passing backtest acceptance is
forced to `review` even when its comparable evidence would otherwise be
`reliable`. `review`, `unavailable`, low confidence, stale sources, unreliable
coordinates, missing type provenance, and inseparable listing parking do not
qualify for automatic recommendation. Limited external review is permitted
only under the reporting rules; it must not overwrite `marketEstimate` and must
write the required `valuation-review.json` when it changes a report bucket.

## Backtesting

The production refresh evaluates a freshly staged candidate before publication.
For an explicit fresh-data calibration, run the non-publishing `candidate`
command:

```bash
npm run market-data -- candidate --city taipei --policy baseline
```

`candidate` downloads or reuses public official sources, builds and validates
new indexes in staging, runs the complete backtest, emits aggregate
normalization diagnostics plus the held-out report, then removes staging. It
never changes the active build or acceptance. Stdout is the full report and can
contain held-out `cases`; do not retain or commit raw stdout. If a local
diagnostic is required, capture it only as a transient input, immediately
rewrite/redact it to aggregate diagnostics, report slices, and gate results
under `state/market-data/backtests/taipei/`, then delete the raw input. Never
retain cases, transaction/address rows, or listing details.

The policy decision is deliberately sequential:

1. Evaluate `baseline` (the five production stages) first.
2. Evaluate `48-month` only if baseline's sole acceptance problem is eligible
   estimate coverage below 70%.
3. Evaluate `1000-meter` only if an otherwise acceptable 48-month policy still
   misses that same coverage target.

Any accuracy, confidence-slice, confidence-ordering, or completeness failure
stops expansion. A fallback becomes active only when all gates pass; changing
the active policy requires an `ESTIMATOR_POLICY_VERSION` compatibility bump,
tests, and the normal `update` command so the accepted candidate is published
transactionally. Thresholds are never lowered. If no policy passes, retain the
last-known-good active pair.

The 2026-07-29 policy-v4 recalibration selected `baseline`: 73,803 raw rows
produced 33,667 reliable-eligible and 629 review-only retained transactions.
Eligible held-out coverage was 93.09%; reliable-cohort median/P75 APE were
7.66%/14.03%; high/medium confidence had 5,105/12,729 scored cases; and high
median APE was 1.56 absolute percentage points lower than medium. The gate
passed without reasons, so the 48-month and 1,000-meter policies were not
evaluated. The active policy stayed baseline, schema stayed 2, and compatibility
version advanced from 3 to 4 for the stricter address/location eligibility
semantics.

That full candidate measured a peak resident set of 2,781,609,984 bytes
(2.59 GiB). Count validation no longer creates `.flat()` copies of complete
indexes, but the candidate still retains validated indexes and the held-out
case report concurrently. Further meaningful reduction requires an
architecture change such as streaming/spillable index construction and
aggregate-only evaluation; do not weaken checksum, full-index, or held-out
validation to fit a smaller runner.

The `backtest` command reads the active validated local build only; it never
refreshes sources or exposes a held-out sale to its estimator. Supply a
historical date when reproducing an active-build baseline:

```bash
npm run market-data -- backtest --city taipei --as-of 2026-07-26
```

The JSON report contains overall metrics plus slices by building type,
confidence, and status. Interpret them as follows:

- `estimateCoverage` is the share of `reliable-eligible` held-out sales that
  received a score. `review-only` and excluded transactions are outside the
  denominator; a policy cannot improve coverage by reclassifying hard failures.
- `medianApe` and `p75Ape` are absolute percentage errors; lower is better.
- `bias` is signed `(estimate - actual) / actual`; a persistent positive or negative value signals calibration drift.
- `intervalCoverage` is the fraction of actual prices inside the P25--P75 interval.
- `latestEligibleTransactionDate` is computed from the complete deduplicated active index before `--as-of` filtering.
- `cases` is local audit evidence, including the strictly earlier comparable dates used for each held-out sale.

Held-out eligibility is intrinsic to each sale and is evaluated at that
subject's transaction date, including building completion consistency.
`--as-of` only limits which eligible subjects become cases. The same
subject-date predicate determines both case population and
`latestEligibleTransactionDate`, so coverage cannot count a transaction that
the backtest would exclude.

The quality gate targets the `reliable` cohort's median APE at or below 12% and
P75 APE at or below 20%, plus overall eligible estimate coverage of at least
70%. It also requires at least 20 scored high-confidence cases and 20 scored
medium-confidence cases. With those sufficient slices, high-confidence median
APE must be at least one absolute percentage point lower than medium-confidence
median APE. This fixed margin prevents tiny floating-point differences from
being treated as measurable confidence calibration.

A gated run is incomplete—and exits non-zero—when overall APE metrics are
missing, either confidence slice lacks its 20 scored cases, or `--as-of`
precedes the complete index's `latestEligibleTransactionDate`. Historical
cutoffs remain useful with `--no-gate`, but they cannot approve a newer active
index. A completed run also exits non-zero when any accuracy/calibration target
fails. Only a completed passing active-policy gated run atomically writes
`state/market-data/taipei-backtest-acceptance.json`. That aggregate-only artifact
uses schema 2 and records the exact `transactions-index.json` SHA-256, active
policy id, estimator policy version, `evaluatedThrough`,
`latestEligibleTransactionDate`, thresholds, slice counts, and reliable-cohort
summary metrics. Enrichment treats estimates as review-only until this artifact
matches the active transaction checksum, runtime estimator policy, and complete
index's latest eligible date. Publishing a different transaction index or
adding a newer eligible transaction therefore invalidates prior acceptance
automatically.

`ESTIMATOR_POLICY_VERSION` is the intentional valuation compatibility
contract. Any change to transaction eligibility, comparable selection stages,
weights, outlier handling, confidence, estimate status, coverage, or backtest
semantics must bump it and obtain a new passing acceptance. The market-data
schema version is not a substitute for this policy bump.

The acceptance artifact's `asOf`, `evaluatedThrough`, and
`latestEligibleTransactionDate` values must be real, zero-padded calendar dates;
format-shaped impossible dates such as `2026-02-30` are rejected. During
enrichment, acceptance and complete-index coverage are evaluated once for the
loaded bundle before listings are mapped, not once per listing.

`--no-gate` is for diagnosing a baseline; it returns a full diagnostic report
without writing or updating acceptance and does not make failed or incomplete
quality acceptable:

```bash
npm run market-data -- backtest --city taipei --as-of 2026-07-26 --no-gate
```

The CLI prints the full `BacktestReport` to stdout, including `cases`; only the
one-line stderr summary is aggregate. Do not retain or commit raw stdout. If a
diagnostic must be preserved, use the raw output only as a transient input,
rewrite/redact it to aggregate-only JSON under
`state/market-data/backtests/taipei/`, and delete the raw input. The
automatically managed acceptance file remains aggregate-only and separate, and
the diagnostics path stays outside the checksum-closed active build. Summarize
only aggregate metrics in handoff. If targets are missed or high-confidence
cases do not outperform weaker evidence, keep results in review and
recalibrate selection/weight constants with tests and backtest evidence.

## Troubleshooting

| Symptom | Safe response |
| --- | --- |
| Source schema drift or missing CSV headers | Do not map a changed field by guesswork. The staged build will not publish; retain the active build, record only header/error metadata, update the adapter and sanitized fixture, then rerun tests before retrying. |
| `market-data-unavailable` | Confirm a validated local build exists with `npm run market-data -- update --city taipei`. If the public source is unreachable, continue the report with market estimates unavailable and use `warn`; do not substitute a guessed price. |
| `listing-coordinate-unavailable` or `listing-coordinate-unreliable` | Use the existing listing location-triage procedure. Do not force a coordinate into the market index; the listing stays unavailable until reliable. |
| `no-comparables`, low confidence, or `review` | Read included and excluded evidence. Fewer than three retained comparables, a wide interval, stale data, or a hard conflict is review-only; do not relax criteria in report prose. |
| `listing-parking-not-separable` | Do not estimate a parking adjustment. The listing stays review-only unless the asking building and parking amounts/areas can be separated according to the reporting rules. |
| Active build appears corrupt | Do not edit it. Use a previously verified local snapshot if one was retained, otherwise rerun the updater and let atomic validation publish a new build. |
