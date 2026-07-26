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
```

`state/` must never be committed. It contains raw public source files,
derived indexes, manifests, checksums, aggregate backtest acceptance, and any local backtest captures; it can
also contain listing evidence elsewhere under `state/runs/`. Do not paste raw
transactions or a listing's full comparable set into notifications.

Run an explicit initial build (or a manual refresh) with network access:

```bash
npm run market-data -- update --city taipei
```

The command prints the published build ID, source check timestamps, publication
metadata when available, record counts, and freshness. A production build is published only after index,
coordinate, checksum, and minimum-count validation. The active directory is
replaced atomically only after the staging directory validates.

Enrichment also calls the same updater once per run before estimates are
attached. It performs a lightweight online source check without credentials:
the doorplate resource and the current/prior transaction seasons use HTTP
validators, while unchanged historic seasons are reused from the active raw
build when their checksum matches. Thus the first enrichment attempts to build
the index automatically; it is not an offline-only operation. Run the explicit
command first when you want to establish or inspect a build deliberately.

If a download, source layout, ZIP, CSV, or validation check fails, no staged
data is published. A valid active build remains the last-known-good build; if
none exists, enrichment continues with independent fields and sets
`marketEstimate.status` to `unavailable`. The active manifest describes the
last successful build, not an error log. Pipeline enrichment journals the
current refresh outcome. The standalone `market-data update` CLI currently has
no logger: when it retains an existing build after a refresh failure, it prints
that old build and exits successfully without the failure reason. Treat a
standalone update's output as build identity/freshness only; use a pipeline
enrichment journal to inspect a retained-refresh failure.

Freshness is measured from successful source checks at the report's target
date: transaction data is stale after 30 days and doorplate data after 60 days.
A stale source makes affected estimates review-only, prevents automatic
recommendations, and requires notification status `warn`.

### Recovering from a bad refresh

Do not edit indexes or `manifest.json` in place. A failed refresh automatically
keeps the prior active directory. During a successful replacement the updater
uses a sibling `.taipei-backup-<build-id>` directory briefly and normally
removes it after cleanup (a cleanup failure can leave it as a recoverable
backup); it is not a durable rollback archive. Before an intentional
refresh that needs a manual rollback point, stop concurrent runs and make a
local copy of the validated directory outside the active path, for example:

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

Backtesting reads the active validated local build only; it never refreshes
sources or exposes a held-out sale to its estimator. Supply a historical date
when reproducing a baseline:

```bash
npm run market-data -- backtest --city taipei --as-of 2026-07-26
```

The JSON report contains overall metrics plus slices by building type and
confidence. Interpret them as follows:

- `estimateCoverage` is the share of eligible held-out sales that received a score; it must not be increased by relaxing safety rules without evidence.
- `medianApe` and `p75Ape` are absolute percentage errors; lower is better.
- `bias` is signed `(estimate - actual) / actual`; a persistent positive or negative value signals calibration drift.
- `intervalCoverage` is the fraction of actual prices inside the P25--P75 interval.
- `cases` is local audit evidence, including the strictly earlier comparable dates used for each held-out sale.

The quality gate targets median APE at or below 12% and P75 APE at or below
20%. It also requires at least 20 scored high-confidence cases and 20 scored
medium-confidence cases. With those sufficient slices, high-confidence median
APE must be at least one absolute percentage point lower than medium-confidence
median APE. This fixed margin prevents tiny floating-point differences from
being treated as measurable confidence calibration.

A gated run is incomplete—and exits non-zero—when overall APE metrics are
missing or either confidence slice lacks its 20 scored cases. A completed run
also exits non-zero when any accuracy/calibration target fails. Only a completed
passing gated run atomically writes
`state/market-data/taipei-backtest-acceptance.json`. That aggregate-only artifact
records the exact `transactions-index.json` SHA-256, thresholds, slice counts,
and summary metrics. Enrichment treats estimates as review-only until this
artifact exists and matches the active transaction checksum. Publishing a
different transaction index therefore invalidates prior acceptance
automatically.

`--no-gate` is for recording or diagnosing a baseline; it returns diagnostic
metrics without writing or updating acceptance and does not make failed or
incomplete quality acceptable:

```bash
mkdir -p state/market-data/taipei/backtests
npm run market-data -- backtest --city taipei --as-of 2026-07-26 --no-gate \
  > state/market-data/taipei/backtests/2026-07-26.json
```

The CLI prints the full report to standard output. Redirect it as above when
preserving per-case diagnostic evidence; the automatically managed acceptance
file remains aggregate-only and separate. Keep both under git-ignored `state/`,
summarize only aggregate metrics in handoff, and never commit transaction rows.
If targets are missed or high-confidence cases do not outperform weaker
evidence, keep results in review and recalibrate selection/weight constants
with tests and backtest evidence.

## Troubleshooting

| Symptom | Safe response |
| --- | --- |
| Source schema drift or missing CSV headers | Do not map a changed field by guesswork. The staged build will not publish; retain the active build, record only header/error metadata, update the adapter and sanitized fixture, then rerun tests before retrying. |
| `market-data-unavailable` | Confirm a validated local build exists with `npm run market-data -- update --city taipei`. If the public source is unreachable, continue the report with market estimates unavailable and use `warn`; do not substitute a guessed price. |
| `listing-coordinate-unavailable` or `listing-coordinate-unreliable` | Use the existing listing location-triage procedure. Do not force a coordinate into the market index; the listing stays unavailable until reliable. |
| `no-comparables`, low confidence, or `review` | Read included and excluded evidence. Fewer than three retained comparables, a wide interval, stale data, or a hard conflict is review-only; do not relax criteria in report prose. |
| `listing-parking-not-separable` | Do not estimate a parking adjustment. The listing stays review-only unless the asking building and parking amounts/areas can be separated according to the reporting rules. |
| Active build appears corrupt | Do not edit it. Use a previously verified local snapshot if one was retained, otherwise rerun the updater and let atomic validation publish a new build. |
