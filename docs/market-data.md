# Taipei Market-Data Operations

This guide operates the local, evidence-carrying market-price baseline used by
enrichment. It currently supports **Taipei City only** and is designed for the
`example-investment` profile. It does not replace the report rules in
[`reporting-rules.md`](reporting-rules.md): an estimate with weak evidence stays
in review rather than becoming an automatic recommendation.

## Current production contract

The activated contract is build schema 5, estimator policy 7, and acceptance
schema 3. `marketEstimate` remains the conservative report authority;
`marketScenarios` supplies approved exact-use and parking-family evidence only
when the matching acceptance authorizes those cohorts. The earlier safe-stop
design remains as historical rationale for the fail-closed boundary.

## Sources, scope, and credentials

The build uses two public official sources:

- Taipei City Government's [臺北市門牌位置數值資料](https://data.taipei/dataset/detail?id=b7c8e724-1e98-45ee-a0bd-f3840623ed97), the local doorplate geocoder. Check the dataset page for its current release terms and comply with the official [Government Open Data License, version 1.0](https://data.gov.tw/license) when that is the release's stated license.
- Ministry of the Interior [real-price open-data download](https://plvr.land.moi.gov.tw/DownloadOpenData) and its [data.gov.tw dataset record](https://data.gov.tw/dataset/139700), for official sale transactions. The official [Government Open Data License, version 1.0](https://data.gov.tw/license) is the license text; confirm the dataset record's current license and attribution requirement before reuse.

No API key, TGOS key, or online geocoder is required. Update and candidate evaluation use
the public sources directly. iBigFun
credentials and `ORS_API_KEY` are unrelated to either command. Do not add a
market-data credential to `.env`.

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

- `reliable-eligible`: `住家用`, exactly one transferred building, direct
  Grade-A parking evidence (including explicit no-parking), and all general-
  market, building-type, freehold, floor/area/price/date, location, and unit-
  price checks pass. This is the conservative residential coverage denominator.
- `review-only`: a known non-residential use (`住商用`, office, commercial,
  industrial, or mixed-industrial), multiple transferred buildings, or Grade-B
  partial parking evidence. These rows stay indexed for exact-use and parking
  scenarios, but contribute only when the matching schema-3 acceptance cohort
  or family is approved; they never masquerade as residential reliable rows.
- `excluded`: blank/unknown primary use, government sale, explicit special or
  non-freehold transaction, unsupported type, unresolved location, invalid or
  contradictory required values, Grade-C parking, and other hard failures.

The schema-5 manifest publishes aggregate normalization totals: `rawRows`,
`reliableEligible`, `reviewOnly`, `excluded`, `excludedByReason`, exact counts
by normalized primary use and parking grade, Grade-B missing-component counts,
and Grade-B imputed/unresolved counts. The strict loader recomputes those totals
from persisted rows and checks building/parking arithmetic even when file
checksums match. For every Grade-B row it also replays the policy derivation in
date order from only strictly earlier, eligible Grade-A observations, then
requires an exact match for comparable IDs/order, count scaling, joint pairs,
quantiles, IQRs, official partial components, and derived building values. Full
rows and addresses remain only in git-ignored local evidence.

Refresh and validate the production pair with:

```bash
npm run market-data -- update --city taipei
```

The command recovers an interrupted publication, refreshes public sources,
builds schema-5/policy-7 indexes in staging, runs every global, use-cohort,
Grade-B comparison, and parking-family gate, then atomically publishes the
build with its schema-3 acceptance. Failure retains the last-known-good pair
and exits `3`; an invalid older build is never silently promoted.

Enrichment calls this update path once per run before estimates are attached.
If refresh fails it may use only a still-valid accepted pair; otherwise
`marketEstimate` is unavailable.

Candidate downloads, parsing, indexing, and validation occur under the
explicit `candidate` command in a disposable sibling staging directory. Gate
failure or success both remove that directory without calling a production
publisher. The active manifest, transaction checksum, acceptance bytes, build
ID, and recorded source check times remain unchanged.

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

For an explicit fresh-data candidate evaluation, run the non-publishing
`candidate` command:

```bash
npm run market-data -- candidate --city taipei --policy baseline
```

`candidate` downloads or reuses public official sources, builds and validates
new indexes in staging, runs the complete backtest, emits aggregate
normalization diagnostics plus aggregate held-out slices, then removes staging.
It never changes the active build or acceptance, and never emits held-out
cases, transaction/address rows, or listing details. Preserved aggregate
diagnostics belong under `state/market-data/backtests/taipei/`.

The policy decision is deliberately sequential:

1. Evaluate `baseline` (the five production stages) first.
2. Evaluate `48-month` only if baseline's sole acceptance problem is eligible
   estimate coverage below 70%.
3. Evaluate `1000-meter` only if an otherwise acceptable 48-month policy still
   misses that same coverage target.

Any accuracy, confidence-slice, confidence-ordering, or completeness failure
stops expansion. A fallback policy requires an explicit policy-version change;
the `candidate` command never publishes. Thresholds are never lowered.

The 2026-07-29 policy-v4 recalibration selected `baseline`: 73,803 raw rows
produced 33,667 reliable-eligible and 629 review-only retained transactions.
Eligible held-out coverage was 93.09%; reliable-cohort median/P75 APE were
7.66%/14.03%; high/medium confidence had 5,105/12,729 scored cases; and high
median APE was 1.56 absolute percentage points lower than medium. The gate
passed without reasons, so the 48-month and 1,000-meter policies were not
evaluated. That initial rollout kept the baseline policy, used manifest/index
schema 2, and advanced the compatibility version from 3 to 4 for the stricter
address/location eligibility semantics. The subsequent provenance migration
rebuilt those same policy-v4 semantics into manifest/index schema 3; the
independent acceptance artifact used schema 2. That paragraph is historical:
current loading rejects the old pair, while publication recovery validates it
only to restore exact predecessor bytes after an interrupted upgrade.

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
- Held-out cases remain internal to evaluation; CLI output is aggregate-only.

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
uses schema 3 and records the exact `transactions-index.json` SHA-256, active
policy id, estimator policy version, `evaluatedThrough`,
`latestEligibleTransactionDate`, thresholds, global/use-cohort metrics,
Grade-B comparison, and parking-family decisions. Enrichment treats estimates as review-only until this artifact
matches the active transaction checksum, runtime estimator policy, manifest's
index-policy provenance, and complete index's latest eligible date. Publishing
a different transaction index or adding a newer eligible transaction therefore
invalidates prior acceptance automatically.

Standalone `backtest` checks the active manifest's schema-5 policy provenance
before held-out evaluation or case output; `--no-gate` cannot bypass this
compatibility check. The acceptance writer repeats the active manifest,
transaction-artifact checksum, acceptance policy/version, and complete-index
coverage checks immediately before its atomic write. A provenance failure never
creates or replaces acceptance. `update` repairs that state only through a new
fully gated atomic publication.

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

The CLI emits aggregate-only JSON and a one-line aggregate stderr summary; it
never emits held-out cases. A preserved diagnostic belongs under
`state/market-data/backtests/taipei/`. The
automatically managed acceptance file remains aggregate-only and separate, and
the diagnostics path stays outside the checksum-closed active build. Summarize
only aggregate metrics in handoff. If targets are missed or high-confidence
cases do not outperform weaker evidence, keep results in review and
recalibrate selection/weight constants with tests and backtest evidence.

## Troubleshooting

| Symptom | Safe response |
| --- | --- |
| Source schema drift or missing CSV headers | Do not map a changed field by guesswork. The staged build will not publish; retain the active build, record only header/error metadata, update the adapter and sanitized fixture, then rerun tests before retrying. |
| `market-data-unavailable` | Run `npm run market-data -- update --city taipei`. If rebuilding or any gate fails and no valid prior pair exists, continue with market estimates unavailable and use `warn`, without substituting a guessed price. |
| `listing-coordinate-unavailable` or `listing-coordinate-unreliable` | Use the existing listing location-triage procedure. Do not force a coordinate into the market index; the listing stays unavailable until reliable. |
| `no-comparables`, low confidence, or `review` | Read included and excluded evidence. Fewer than three retained comparables, a wide interval, stale data, or a hard conflict is review-only; do not relax criteria in report prose. |
| `listing-parking-not-separable` | The conservative base estimate stays review-only. A policy-7 scenario may show an approved parking-family adjustment only when listing family/count and all other evidence are verified; it does not independently authorize automatic recommendation. |
| Active build appears corrupt | Do not edit it. Run the updater so journal recovery and a fresh fully gated build can replace it atomically; if that fails, keep market evidence unavailable. |
