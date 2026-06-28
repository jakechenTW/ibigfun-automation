# Data Files

Static reference data used by the iBigFun monitoring workflow lives here.

## `ibigfun-filter-mappings.md`

Coded id → name key for iBigFun's search filters (`city`, `house_type`, `town`,
`parking`) and the `/api/search/list` request-body encoding. Captured from the
filter UI on 2026-06-27. Profiles store the ids; this file is the human key.

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

## `negotiation-rate.md`

各縣市成交議價率（中古屋）參考表，investment profile 用來把開價校準到成交行情、
計算開價溢價門檻。每市一列，附 `p* = r/(1−r)` 換算與來源季別。資料來自永慶房屋
每季公布的七都成交議價率，每季手動更新。詳見該檔檔頭與 `docs/reporting-rules.md`。

## `region-allowlist.md`

投資 profile 的目標捷運站白名單與 `regionGate` 規則（站外 / 站內走路過遠 /
待人工）。`profiles/example-investment/evaluation.md` 與 enrich 的 `regionGate`
判定依此清單。每次調整目標捷運範圍時更新。
