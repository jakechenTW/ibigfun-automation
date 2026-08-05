# Data Files

Static reference data used by the iBigFun monitoring workflow lives here.

## Local official market-data state (git-ignored)

The deterministic Taipei estimate does not add a credential requirement. Run
`npm run market-data -- update --city taipei` to stage and atomically publish
`state/market-data/taipei/`; run `npm run market-data -- backtest --city taipei
[--as-of YYYY-MM-DD]` to evaluate its active build without a refresh. This local
state holds raw downloads, indexes, and a checksum manifest and must not be
committed.

Sources are the [Taipei City doorplate dataset](https://data.taipei/dataset/detail?id=b7c8e724-1e98-45ee-a0bd-f3840623ed97)
and [Ministry of the Interior real-price registration downloads](https://plvr.land.moi.gov.tw/DownloadSeason).
Doorplates refresh from the dataset's current CSV resource; transactions cover
the recent 36-month seasonal window. A transaction source check is stale after
30 days and a doorplate source check after 60 days. A failed refresh keeps the
last-known-good build; stale data remains visible to enrich/reporting and forces
notification `warn` rather than a silent recommendation.

## `ibigfun-filter-mappings.md`

Complete catalog of every `/api/search/list` body param a profile's `fetch` map
can set — value/id tables for `city`, `town`, `house_type`, `parking`,
`price_segment`, and the free-range filters (floor / 坪數 / 屋齡 / 單價 / …) —
plus the request-body encoding. Captured from the authenticated filter UI on
2026-06-29. Profiles store the ids; this file is the human key.

## `taipei_mrt_exits.csv`

Taipei MRT exit coordinates for distance checks against iBigFun listing coordinates.

- Source: TDX MRT exit data fetched by the user with Claude assistance.
- Added: 2026-06-26.
- Rows: MRT exits, not station centroids.
- Intended use: calculate straight-line distance from an iBigFun listing coordinate to the nearest active Taipei MRT exit.

Columns:

- `station_id`: MRT station code, such as `BL01`.
- `line`: MRT line name.
- `name_zh`: station name in Chinese.
- `exit_id`: exit identifier.
- `latitude`: exit latitude.
- `longitude`: exit longitude.

Distance rules:

- Use the nearest exit distance for the primary MRT-distance signal.
- For iBigFun listings, use the coordinate embedded in the listing address Google Maps link as the listing location when it is available and credible.
- Treat straight-line distance greater than 800m as a hard-exclusion candidate only when the listing coordinate is available and credible.
- Mark 700m-900m results for manual walking-distance confirmation.
- Straight-line distance is not walking distance.
- When a walking-time estimate is needed, first choose the nearest exit by straight-line distance, then call OpenStreetMap foot routing only for that exit.
- This file currently represents active MRT exits. Construction/planned stations should be tracked separately if used as future-upside notes.
- Retired and canceled stations should not be used in MRT-distance checks.

## `region-allowlist.md`

投資 profile 的目標捷運站白名單與 `regionGate` 規則（站外 / 站內走路過遠 /
待人工）。`profiles/example-investment/evaluation.md` 與 enrich 的 `regionGate`
判定依此清單。每次調整目標捷運範圍時更新。
