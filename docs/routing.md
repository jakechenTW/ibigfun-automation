# Enrichment and routing operations

Read this guide before enrichment, walking triage, route trials, or route benchmarks.
Paths in commands and inline code are relative to the repository root.
Use [reporting-rules.md](reporting-rules.md) for walking decisions and display rules.
Use [running.md](running.md#daily-run-sequence) for report order and route-trial request selection.

## Enrichment

- `npm run enrich -- --profile <profile> --date <target>` — reads
  `state/runs/<profile>/<label>/listings.json` and adds walking distance to the nearest MRT exit (needs `ORS_API_KEY` in `.env`;
  results cached in `state/route-cache.json`), mortgage, parsed numbers, a
  reliability gate for walking distance, read-only estimates from the active
  validated market-data pair, and the advisory auction-keyword
  signal → `state/runs/<profile>/<label>/enriched.json`. Profile-specific
  estimation and final include/exclude judgment stay with the agent. The walk
  decision is `withinWalk` (true ≤10-min walk / false too far / null
  unreliable→manual). This command never refreshes official sources, rebuilds
  indexes, runs a full backtest, or publishes market data.

## Routing commands

- `npm run route -- --lat <> --lng <>` — deterministic nearest-walk exit for one
  coordinate (shared ORS cache). Used during triage (step 5 in [running.md](running.md#daily-run-sequence)) to get a trustworthy
  walking distance after re-locating a listing from its address.
- `npm run route-trial -- --profile <profile> [--date <target> | --from <a>
  --to <b>]` — report-owned, display-only Valhalla trial for the selected
  positive/candidate/risk indexes in
  `state/runs/<profile>/<label>/route-trial-request.json`. It reads the existing
  listing/enriched artifacts, uses the isolated git-ignored
  `state/valhalla-trial-cache.json`, and writes detailed local evidence to
  `state/runs/<profile>/<label>/route-trial.json`. It never mutates production
  ORS decisions or `state/route-cache.json`. Provider failures degrade per
  listing. Show the reliable primary route alone, or `步行時間待確認` when it is unavailable.
  Trial failures do not change notification status.
  The Valhalla base URL is read from `VALHALLA_URL` in `.env`; leave it blank
  to use the default FOSSGIS demo. An already-exported `VALHALLA_URL` (including
  a command-scoped override) takes precedence over `.env`. Non-empty overrides
  must be absolute HTTP(S) base URLs without credentials, query, or fragment.
- `npm run route-benchmark -- --profile <profile> --date <target> [--limit <1-200>]`
  or `npm run route-benchmark -- --profile <profile> --from <a> --to <b>
  [--limit <1-200>]` — evaluation-only Valhalla comparison. It reads the existing
  bare daily `state/runs/<profile>/<date>/listings.json` files and
  `state/route-cache.json`, then sends coordinate-only requests sequentially to
  the configured Valhalla endpoint (the default is the FOSSGIS fair-use demo).
  The limit defaults to 25 and is capped at 200.
  Timestamped detailed local evidence is written under `state/route-benchmarks/`
  and may contain privacy-sensitive per-case listing IDs, coordinates, exit IDs,
  and provider distances; keep it local and never notify or commit it. Only
  stdout and stderr are aggregate-only. Before sensitive input reads or routing,
  the artifact directory is preflighted for atomic hard-link publication;
  unsupported filesystems fail early. If a detailed temporary artifact cannot be
  removed after publication, the command fails and requires local cleanup. The
  benchmark never affects enrich, report, or notify and cannot justify a provider
  switch without a separate design and walking-policy revalidation.
