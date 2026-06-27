# Investment Profile

Use this profile for rental-yield-oriented investment screening.

## Criteria

- Mortgage assumption: 80% loan-to-value, 2.6% annual interest, 30-year principal and interest repayment.
- Recommended listing: below market by at least 10% and rent coverage at least 1.0.
- Near-threshold listing: rent coverage at least 0.8.
- Hard-exclude listings only when walking distance is reliable and over a
  10-minute walk: `withinWalk === false`, or an agent triage reroute returns a
  labelled `likely-far` verdict with a deterministic route over 10 minutes.
- Do not hard-exclude for walk when `withinWalk === null`; send it through
  labelled walking-distance triage or manual review.
- Market discount percentage: `(market_unit_price - listing_unit_price) / market_unit_price * 100`.
- Rent coverage: `estimated_monthly_rent / monthly_mortgage_payment`.

## Estimation

- Prefer iBigFun real-price data when available.
- Otherwise use comparable transactions matched on area, age, floor, and property type.
- If only stale, weak, timed-out, or cross-site data is available, do not label the listing recommended.
- Estimate rent from comparable rental listings for the same area and property type.

## Report Buckets

- `推薦物件`: meets discount and rent-coverage thresholds with usable data.
- `接近門檻候選`: rent coverage is at least 0.8 or the listing is promising but needs manual confirmation.
- `前置排除`: reliable walking route is over 10 minutes.
- `可疑/待查`: suspicious or likely-auction listings that should be down-ranked.
- `目標日排除物件`: remaining listings worth summarizing under the investment rules.

## Notification Format

Use `templates/investment-notify-template.md` for structure. These details are
investment-specific and should not be applied to owner-occupied reports:

- Each listing section header is `#### {rank}. [title](url)`; do not emit a `- 狀態：...` line because the section heading already names the bucket.
- Append inline metrics to the header: recommended `｜ 低於行情 {discount_percent}%・覆蓋率 {rent_coverage}`; near-threshold `｜ 覆蓋率 {rent_coverage}・差在 {near_threshold_reason}`; suspicious `｜ \`{suspicious_label}\`` where suspicious_label is `clean` / `suspicious` / `likely-auction`.
- Do not emit the old raw `刊登日` / `publishedDate` line in recommended or
  near-threshold listings; do emit `{{tenure_line}}` exactly as shown in the
  template.
- Recommended and near-threshold use the full compact layout: walk line, one
  tenure line `{{tenure_line}}`, one basics line
  `總價／坪數／單價・樓層・屋齡・地址`, one financial line
  `行情・月租・房貸・現金流`, then reason/risk or manual-check.
- Pre-excluded, suspicious, and excluded listings use the shorter layouts shown in the template.
- Emit the 🚶 walk line in 前置排除, 推薦, and 接近門檻 only; do not emit it in 可疑/待查 or 目標日排除.
- If the target-date new-listing count is 10 or lower, list all excluded properties. If it is above 10, list only the 5 excluded properties closest to the threshold.
- Sort recommended listings by discount percentage, highest first.
- Sort near-threshold listings by rent coverage, highest first.
- Sort excluded listings by rent coverage, discount percentage, then lower total price.
