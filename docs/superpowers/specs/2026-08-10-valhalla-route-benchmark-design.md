# Valhalla Route Benchmark Design

## Goal

Evaluate whether the public FOSSGIS Valhalla service produces more useful
Taipei walking routes than the current openrouteservice (ORS) integration,
without changing any production enrichment, profile decision, report, or
notification behavior.

The experiment uses historical run artifacts and the existing ORS route cache.
It sends coordinate-only one-to-many pedestrian matrix requests to Valhalla,
records detailed local evidence, and prints aggregate comparison metrics. A
separate future decision is required before Valhalla may affect `withinWalk`.

## Selected Approach

Add a standalone `route-benchmark` command backed by a small Valhalla client.
The command compares cached ORS distances with fresh Valhalla distances for a
bounded, deterministic sample from one existing profile run or inclusive run
range.

This is preferred over immediately adding a selectable production routing
provider because it keeps the daily pipeline deterministic while producing the
evidence needed to decide whether a provider change is worthwhile. It is also
preferred over self-hosting during evaluation because the FOSSGIS public demo
already exposes the required full-planet matrix API and the historical workload
can be tested with a small, rate-limited sample.

Rejected alternatives:

- Replace ORS in `enrich` immediately: route differences would silently change
  region gates and hard exclusions before they were validated.
- Dual-call ORS and Valhalla during every daily enrich: this makes an experiment
  part of the production critical path and creates unnecessary public-service
  traffic.
- Self-host Valhalla before benchmarking: this adds map-build and operational
  work before route quality has demonstrated value.

## Command Contract

Add this package command:

```text
npm run route-benchmark -- --profile <profile> --date <YYYY-MM-DD> [--limit <n>]
npm run route-benchmark -- --profile <profile> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--limit <n>]
```

The profile remains explicit, matching the repository's run contract. The
command reads only existing artifacts; it never fetches listings or runs
enrichment. `--date` reads that bare daily run label. `--from`/`--to` reads the
bare daily run label for every date in the inclusive range; it does not read a
merged pipeline range artifact. Every included date must have `listings.json`.
A missing daily artifact is a clear input error so a partial range cannot be
mistaken for a complete benchmark.

`--limit` defaults to 25 for a conservative public-server smoke test and has a
hard maximum of 200. Cases are ordered by run date, listing ID, and route-cache
key, then deduplicated by route-cache key before the limit is applied. This
makes repeated invocations over unchanged input select the same cases.

The Valhalla base URL defaults to `https://valhalla1.openstreetmap.de` and may
be overridden with `VALHALLA_URL` for a local or paid hosted deployment. The
client sends a stable, non-personal `X-Client-Id` identifying this repository's
benchmark command. It requires no API key for the default FOSSGIS endpoint.

## Components

### Valhalla client

Add an isolated client that accepts one origin and an aligned destination
array, then calls `/sources_to_targets` with:

- `costing: "pedestrian"`;
- `walking_speed: 4.8` km/h, matching the current 80 m/min reporting
  convention;
- `units: "kilometers"`;
- compact matrix output.

It returns `(number | null)[]` in meters aligned to the destinations, matching
the existing `routeWalkDistances` boundary. The client validates HTTP status,
the compact `sources_to_targets.distances` response shape, source/target
alignment, finite non-negative distances, and timeout behavior. It does not
accept a top-level `distances` fallback and does not know about profiles,
listings, MRT exits, caches, or report rules.

### Historical case loader

The command loads each selected `listings.json`, runs the existing pure
`enrichOffline` logic to recreate its three candidate MRT exits, and builds the
existing route-cache key. It reads the matching ORS distance array from
`state/route-cache.json` without mutating that cache.

A case is comparable only when it has a coordinate, at least one candidate
exit, a coordinate that is not known to conflict with the listing district,
and a cached ORS array with the correct candidate count. Other cases are
counted by skip reason and never trigger a Valhalla request.

Only latitude/longitude pairs are sent to FOSSGIS. Addresses, titles, listing
IDs, prices, profile criteria, credentials, and source URLs are never included
in requests or request headers.

### Comparator

For each comparable case, run the existing `pickWalk` function independently
on the cached ORS array and the Valhalla array. This intentionally reuses the
current 800 m threshold and route/straight-line plausibility gate rather than
inventing benchmark-only decision semantics.

Aggregate metrics include:

- selected, comparable, skipped, completed, and failed cases;
- ORS and Valhalla usable-route and plausible-route counts;
- nearest MRT exit agreement;
- `withinWalk` agreement;
- `true -> false`, `false -> true`, and null-state transitions;
- cases where either provider's selected route lies in the 700-900 m boundary
  band;
- absolute and percentage distance deltas when both providers select the same
  exit;
- Valhalla HTTP, timeout, rate-limit, and response-shape failures.

The aggregate alone does not declare a winner. Provider selection requires
manual review of boundary flips, nearest-exit disagreements, and cases where
only one provider passes the plausibility gate.

## Output and Privacy

Write one detailed JSON artifact below using a UTC basic-format timestamp:

```text
state/route-benchmarks/<profile>/<label>/valhalla-<timestamp>.json
```

`state/` is already git-ignored. The artifact contains the benchmark version,
timestamp, input run labels, Valhalla base URL, aggregate metrics, and per-case
comparison evidence. Per-case evidence may contain the local listing ID,
coordinates, candidate exit IDs, provider distances, selected walk result, and
transition classification because it remains local workflow state.

The command creates a new artifact rather than replacing an earlier benchmark.
It writes through a temporary sibling and renames atomically so an interrupted
run cannot leave a file that looks complete.

Standard output is aggregate-only. It must not print listing coordinates,
addresses, IDs, titles, source URLs, credentials, or raw response bodies.
Benchmark artifacts are not report artifacts and are never sent through
`ai-notify`.

## Public-Service Behavior and Errors

Requests are sequential and separated by a configurable internal delay with a
conservative default of at least one second. The client has a finite timeout.
It retries a transient `429` or `5xx` response at most once after honoring a
bounded `Retry-After` value when present; it never loops indefinitely.

An individual Valhalla failure is recorded and comparison continues. Invalid
CLI arguments, missing historical artifacts, an unreadable ORS cache, or an
unwritable output path fail the command before or at persistence. The command
does not mark a pipeline run failed because it is outside the production
pipeline.

The FOSSGIS endpoint is a fair-use demo service without an SLA. The initial
live verification uses the default 25-case limit. Larger experiments remain
explicit operator actions and are capped at 200 cases per command.

## Tests

Use test-driven implementation with no live network dependency in automated
tests:

- Valhalla request body, endpoint, client ID, timeout, and kilometer-to-meter
  conversion;
- ordered response alignment, null destinations, malformed responses, HTTP
  errors, timeouts, and bounded retry behavior;
- deterministic historical selection and route-cache-key deduplication;
- skipped-case accounting for missing coordinates, district conflicts, missing
  cache entries, and cache-shape mismatches;
- nearest-exit and `withinWalk` agreement/transition metrics;
- boundary-band and same-exit distance delta metrics;
- aggregate-only stdout and output artifact placement;
- proof that the ORS cache and enriched run artifacts are not modified.

After unit tests and the full `npm test` suite pass, run a five-case live smoke
test against FOSSGIS to validate the deployed response shape. If that succeeds,
run the default 25-case benchmark and report its aggregate findings. Live
service failures do not invalidate the implementation tests and do not alter
production state.

## Decision Gate After the Experiment

This work ends with benchmark evidence. It does not add a routing provider flag
to `enrich`, change `ORS_API_KEY`, change route-cache semantics, or modify
`withinWalk`, `regionGate`, hard exclusions, reports, notifications, schedules,
or profile policies.

If the evidence favors Valhalla, a separate design must choose among the
FOSSGIS demo, a paid hosted Valhalla API, and self-hosting; define production
availability and cache behavior; and revalidate all walking-dependent policy
outcomes before switching providers.
