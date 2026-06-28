# Owner-Occupied Profile

Use this profile for self-use screening. The goal is to notify on homes worth personally reviewing, not to estimate rental yield.

## Source Filter

The first profile version is based on this saved iBigFun URL:

`https://www.ibigfun.com/lists/latest?page=1&expand=0&method=all_case&on_market=1&city=1&town=1%2C4&price_segment=%2C8000&house_type=17&floor_segment=7%2C&main_ping_number=30%2C&house_age_segment=%2C25&parking=%E5%B9%B3%E9%9D%A2`

Fetch filters are enabled. All coded mappings were verified on 2026-06-27:
town id→name from a live fetch (1→中正區, 4→中山區) and `house_type=17`→`電梯大樓` from the iBigFun filter UI
(`house_type_caption_17`). `house_type` and `main_ping >= 30` are applied
server-side and cannot be re-verified per-result from the API response
(it returns `typeLayout` room layout, not a building-type category, and
`total_ping`, not 主建物 ping) — they are trusted server-side-only filters.
See `data/ibigfun-filter-mappings.md` for the full id→name reference.

## Hard Criteria

- City: 台北市.
- District ids: `1`, `4` (中正區, 中山區; verified 2026-06-27).
- Total price: <= 8000 萬.
- House type: `house_type=17` (電梯大樓; verified 2026-06-27).
- Floor: >= 7.
- Main ping: >= 30.
- Age: <= 25 years.
- Parking: includes `平面`.

Room, living-room, and bathroom counts are displayed but are not hard criteria in this first profile.

## Agent Judgment

- Put strong matches in `符合條件`.
- Put close matches or listings with missing fields in `候選/需確認`.
- Summarize exclusions by count and main reason instead of listing every excluded property.
- Treat suspicious, likely-auction, low-information, or blocked-detail listings as risk notes or exclusion reasons.
- Walking distance is a preference and sorting signal, not a disqualifier, unless this profile later adds an explicit walking threshold.

## Notification Status

- Use `warn` when there is any match, candidate, manual review, stale data,
  or unverified coded filter mapping (including any remaining `待驗證` entry).
- Use `ok` only when there are no matches or candidates and coded filter mappings are verified.
- Use `fail` only when the monitor cannot complete.
