# Daily Dual-Route Trial Design

## Goal

During a temporary trial, show both cached/production ORS and experimental
Valhalla walking times for every property rendered individually in a daily
notification. The comparison must not change eligibility, exclusion, sorting,
notification status, or any other production decision.

## Decision Boundary

ORS remains authoritative. Existing `enriched.walk`, `withinWalk`,
`regionGate`, reliability, hard-exclusion, and report buckets continue to come
only from the production ORS enrichment path.

Valhalla is display-only trial evidence:

- it never changes a bucket or order;
- it never fills an unreliable ORS decision;
- its failure never changes notification status;
- it never writes `state/route-cache.json`; and
- no automatic provider switch is permitted from trial output.

## Selected-Listing Workflow

The agent first evaluates the enriched run and decides the positive,
candidate, and risk listings that will be rendered individually. Hard-excluded
listings represented only by counts are not selected.

The report substep writes a local handoff file:

`state/runs/<profile>/<label>/route-trial-request.json`

```json
{
  "schemaVersion": 1,
  "profileId": "investment-taipei.local",
  "rangeLabel": "2026-08-10",
  "listingIndexes": [0, 3, 7]
}
```

`listingIndexes` refer to the ordered `enriched.json` array. The command binds
the request to the current run by requiring exact profile/range metadata,
unique safe integer indexes, in-range entries, and at most 25 selected
listings. Index selection supports listings whose source ID is null without
inventing an identity. The detailed result records both index and source ID so
the agent can bind the output back to the same listing.

The agent then runs:

```bash
npm run route-trial -- --profile <profile> [--date <d> | --from <a> --to <b>]
```

The command reads the request, `enriched.json`, the original `listings.json`,
and the committed MRT exit dataset. It recomputes the canonical three candidate
exits with `enrichOffline`, verifies that the indexed original and enriched
records refer to the same listing, routes only the selected unique route keys,
and writes:

`state/runs/<profile>/<label>/route-trial.json`

It never edits the request, listings, enriched data, report, ORS cache, pipeline
manifest, or journal.

## Trial Result

The result schema is local and detailed:

```json
{
  "schemaVersion": 1,
  "profileId": "investment-taipei.local",
  "rangeLabel": "2026-08-10",
  "generatedAt": "2026-08-11T00:00:00.000Z",
  "valhallaEndpoint": "https://valhalla1.openstreetmap.de",
  "comparisons": [
    {
      "listingIndex": 0,
      "listingId": 123,
      "ors": {
        "status": "reliable",
        "stationZh": "松江南京",
        "exitId": "4",
        "distanceM": 720,
        "minutes": 9
      },
      "valhalla": {
        "status": "reliable",
        "stationZh": "松江南京",
        "exitId": "3",
        "distanceM": 800,
        "minutes": 10
      },
      "error": null
    }
  ],
  "summary": {
    "requested": 1,
    "completed": 1,
    "cacheHits": 0,
    "apiCalls": 1,
    "unavailable": 0
  }
}
```

Provider records use `status: reliable | unavailable`. A provider is reliable
only when the existing walk reliability rules accept its selected route. An
unreliable coordinate, missing coordinate/candidates, malformed response,
implausible route ratio, timeout, HTTP error, or transport error becomes
`unavailable`; no raw provider response or sensitive error is stored.

## Time Calculation and Notification Format

Both displayed times use the current common walking speed:

```text
minutes = round(distanceM / 80)
```

This is 4.8 km/h and matches the existing 800 m = 10 minute production rule.
Valhalla's provider-specific duration is not used. Each provider may select a
different candidate exit, so the compact line retains the selected station and
exit for both sides:

```text
🚶 ORS 松江南京 4號出口・9分｜Valhalla 松江南京 3號出口・10分（試行）・[地圖](...)
```

Missing exit IDs omit the exit segment. Unavailable states render explicitly:

```text
🚶 ORS 松江南京 4號出口・9分｜Valhalla 暫無（試行）・[地圖](...)
🚶 ORS 待確認｜Valhalla 松江南京 3號出口・10分（試行）・[地圖](...)
```

When no coordinate exists, keep `🚶 無位置資訊`; there is no useful route
comparison or map link. The comparison is folded into the existing
`walk_line`, so committed and local profile templates require no structural
change.

Every positive, candidate, and risk listing must have one of these dual-source
lines during the trial. A missing Valhalla result is visible as `暫無` rather
than silently omitted. Excluded listings remain count-only.

## Cache and Fair Use

Daily trial results use a separate git-ignored cache:

`state/valhalla-trial-cache.json`

The schema stores aligned distance arrays by a SHA-256 endpoint key and the
existing canonical route key. Hashing the normalized full base URL prevents
cross-deployment cache reuse without persisting endpoint paths. Values are
strictly validated before use. Cache writes use a unique temporary sibling and
atomic replacement. This cache is never read by enrich or the production route
tool.

Only cache misses call Valhalla. Calls are sequential, request starts remain at
least 1,000 ms apart, the existing one-retry/timeout/safe-error client contract
is retained, and one run accepts no more than 25 selected listings. Duplicate
route keys are routed once and fan out to their selected listings.

## Failure Behavior

Provider-level failures are recorded per listing as fixed safe unavailable
evidence. The command continues with other selected listings, writes the trial
artifact when possible, and exits successfully. These failures do not change
`ok`/`warn`/`fail` notification status.

Invalid or inconsistent local input, malformed cache, inability to persist the
cache/result, or an invalid endpoint is a command error. The report agent still
completes the daily report with `Valhalla 暫無（試行）` for each rendered
listing and keeps the original notification status. It records concise local
diagnostics but never copies paths, coordinates, listing IDs, endpoint paths,
raw responses, or stack traces into the notification.

## Daily Pipeline Integration

The report-generation instructions in `AGENTS.md`, `docs/reporting-rules.md`,
and `prompts/daily-run.md` gain a trial substep after bucketing and before the
final `report.md` write:

1. collect the enriched indexes for every individually rendered property;
2. write and validate `route-trial-request.json`;
3. run `route-trial` once;
4. bind each result by listing index and ID;
5. compose the dual-source `walk_line`; and
6. fall back visibly to `Valhalla 暫無（試行）` without changing status.

The pipeline manifest gains no new durable step. Trial comparison is part of
the agent-owned report step, which keeps existing resume and notification
contracts intact.

## Testing

Tests cover:

- strict request binding, duplicate/out-of-range indexes, and the 25-listing
  cap before routing;
- selection by index when listing ID is null;
- original/enriched mismatch rejection;
- ORS values copied only from authoritative enriched `walk`;
- candidate recomputation and Valhalla `pickWalk` reliability;
- common 80 m/min rounding and different-exit output;
- cache hit, miss, endpoint isolation, malformed cache, duplicate route-key
  fan-out, atomic cache persistence, and no ORS-cache mutation;
- sequential 1,000 ms miss-only rate limiting and per-listing failure
  continuation;
- fixed safe command-level failures and no sensitive console output;
- detailed result persistence without modifying inputs;
- exact notification lines for both reliable providers, either unavailable
  provider, missing exits, and no coordinate; and
- report/prompt documentation requiring dual lines only for positive,
  candidate, and risk listings.

Focused tests, the complete `npm test` suite, `npx tsc --noEmit`, and
`git diff --check` must pass. A five-listing live smoke may validate the final
wire integration, but it must use only selected historical cases, preserve all
input/cache bytes except the dedicated Valhalla trial cache, and must not send a
notification.

## Success Criteria

- Every individually rendered daily property shows ORS and Valhalla trial time
  or an explicit unavailable label.
- Formal decisions and notification status remain ORS-only.
- Excluded/count-only properties generate no Valhalla work.
- Repeated routes use the dedicated Valhalla cache and respect fair-use limits.
- Trial failures never block the daily notification.
- No detailed comparison evidence or sensitive route data is committed or
  notified.
