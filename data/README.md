# Data Files

Static reference data used by the iBigFun monitoring workflow lives here.

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
