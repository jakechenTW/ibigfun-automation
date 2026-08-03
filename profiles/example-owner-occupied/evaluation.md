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

## Official Scenario Gate

This profile does not add the investment profile's asking-premium threshold. For the shared unknown-use decision,
its conservative P25 gate is an evidence-usability gate applied separately to every scenario. Do not infer
acceptance from `status`: every computed `role: unknown-use-scenario` remains at most `review`. Building P25 must be
non-null; a listing with flat parking must also have non-null whole-property `bundleValue.p25Ntd`; confidence must
be medium/high; and both official sources must be fresh. `reasons` must not contain `use-cohort-not-accepted`,
`parking-cohort-not-accepted`, `parking-estimate-unavailable`, `parking-family-unknown`, `parking-count-unknown`,
`parking-count-family-conflict`, `invalid-parking-count`, or `bundle-evidence-conflicts`.
`registered-use-unverified` and non-conflicting `bundle-evidence-corroborates`/`bundle-evidence-insufficient` may
remain. The listing's `<= 8000 萬` asking-price cap remains the separate hard criterion above; passing this evidence
gate does not claim that the asking price is cheap.

- Verified use (`registeredUse.source` is `official`/`manual` and value is not `unknown`): the accepted same-use
  `role: primary` scenario controls. A residential comparison cannot replace a failed or unsupported non-residential
  primary scenario.
- Unknown or unverified use: `符合條件` is allowed only as `條件式符合（用途未確認）` when at least two
  supported acceptance-enabled scenarios, including residential, all pass this profile's P25 evidence gate and no
  rejected/disabled scenario with otherwise usable required P25 yields the opposite gate result. Determine that
  rejection from the exact reason strings above, never from a status label; a quantile-bearing unknown-use scenario
  is expected to remain `review`. Because this profile's P25 gate is evidence usability rather than an invented
  asking-premium threshold, a cohort/component rejection is a failing diagnostic result even when its numerical P25
  remains visible. All other unknown-use outcomes follow the shared order in `docs/reporting-rules.md`:
  mixed/insufficient → `候選/需確認`, every supported scenario fails with no contrary usable diagnostic →
  exclusion, and no supported scenario or bundle conflict → `候選/需確認` as human review.
- A-grade parking is direct evidence. Accepted B-grade causal imputation may support the gate at its capped weight.
  C-grade evidence is bundle-only; it cannot enter building-unit-price quantiles, and a bundle conflict forces human
  review. Do not impose the former blanket "inseparable parking" rejection on every parking listing.

## Agent Judgment

- Put strong matches in `符合條件`.
- Put close matches or listings with missing fields in `候選/需確認`.
- Summarize exclusions by count and main reason instead of listing every excluded property.
- Treat suspicious, likely-auction, low-information, or blocked-detail listings as risk notes or exclusion reasons.
- Walking distance is a preference and sorting signal, not a disqualifier, unless this profile later adds an explicit walking threshold.
- A verified-use controlling scenario with `review`/`unavailable`/`diagnostic-only`/`insufficient-sample`, stale
  sources, low confidence, or unresolved conflicts cannot support automatic `符合條件`; keep it in `候選/需確認`
  with the compact evidence reason. Unknown-use scenario status remains `review`; the conditional exception is
  decided by the quantiles/P25/reasons procedure above. It may retain `registered-use-unverified` and a
  non-conflicting bundle label, but no listed cohort/component rejection, stale/low-quality reason, missing required
  P25, or conflict.
- A title or description containing `工業宅`, `住辦`, or similar prose never verifies registered use. An unknown-use
  candidate must ask the user to confirm legal registered use/use-license compatibility, lending and appraisal,
  applicable tax treatment, and resale/marketability risk. Keep these confirmations even for a conditional match.

## Notification Status

- Use `warn` when there is any match, candidate, manual review, stale data,
  or unverified coded filter mapping (including any remaining `待驗證` entry).
- Use `ok` only when there are no matches or candidates and coded filter mappings are verified.
- Use `fail` only when the monitor cannot complete.
