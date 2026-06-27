# Investment Profile

Use this profile for rental-yield-oriented investment screening.

## Criteria

- Mortgage assumption: 80% loan-to-value, 2.6% annual interest, 30-year principal and interest repayment.
- Recommended listing: below market by at least 10% and rent coverage at least 1.0.
- Near-threshold listing: rent coverage at least 0.8.
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
- `前置排除`: objective reliable walking-distance exclusion.
- `可疑/待查`: suspicious or likely-auction listings that should be down-ranked.
- `目標日排除物件`: remaining listings worth summarizing under the investment rules.
