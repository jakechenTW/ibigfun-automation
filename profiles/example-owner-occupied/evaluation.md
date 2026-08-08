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

- Apply tenure first: `tenureGate === 'expired'` is always excluded;
  `review` can never be an automatic match and a clean listing goes to
  `候選／資料待確認`; `eligible` continues through the remaining criteria.
- After the expired hard exclusion, a suspicious/likely-auction verdict or other
  verified material ownership, use, or information-quality risk takes
  precedence and goes to `風險物件／待查`.
- Put clean `eligible` listings that pass the hard criteria and market-data
  quality gates in `符合條件`.
- Put only clean listings with resolvable missing or weak evidence in
  `候選／資料待確認`.
- Summarize exclusions by count and main reason instead of listing every excluded property;
  the summary must include `tenureGate === 'expired'` listings and name the profile age limit.
- Keep suspicious, likely-auction, material ownership/use risk, low-information,
  or blocked-detail listings in the explicit `風險物件／待查` bucket rather than hiding them in exclusions.
- Walking distance is a preference and sorting signal, not a disqualifier, unless this profile later adds an explicit walking threshold.
- A `marketEstimate` with `review`/`unavailable`, stale source data, low confidence, or inseparable parking cannot support an automatic `符合條件` judgment; keep a clean, otherwise qualifying listing in `候選／資料待確認` with the compact evidence reason.

## Notification Status

- Use `ok` when the run has no unresolved actionable warnings; fully supported matches may use `ok`.
- Use `warn` for candidates, risk listings, unresolved actionable manual review, stale data,
  unverified coded filter mappings (including any remaining `待驗證` entry), or other weak evidence affecting safe interpretation.
- A fresh market `review`/`unavailable` result on a confirmed hard exclusion does not force `warn`.
- Use `fail` only when the monitor cannot complete.

## Notification Format

- Use `notify-template.md` and the shared concise contract in `docs/reporting-rules.md`.
- Render all `符合條件`, `候選／資料待確認`, and `風險物件／待查`; never render excluded listings individually.
- Sort each rendered bucket by known `daysOnMarket` ascending and then total price ascending. Unknown tenure follows known tenure; verified risk still remains in the risk bucket.
- Core facts are total price, area, asking unit price, floor, building age, address/area, room layout, flat parking, and building type when available.
- Show `walk_line`, `tenure_line`, `market_summary_line`, and one listing-specific self-use fit, review action, or risk phrase.
- Do not show investment-only mortgage, rent, cash-flow, coverage, or financing fields.
- Put an unverified coded filter mapping in `data_warning`; it still forces `warn` and blocks a clean `ok` conclusion.
- Summarize the configured tenure limit, self-use hard-criteria failures, and other confirmed hard failures by count.
