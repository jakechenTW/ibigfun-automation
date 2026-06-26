# Reporting Rules

## Investment Criteria

- Mortgage assumption: 80% loan-to-value, 2.6% annual interest, 30-year principal and interest repayment.
- Recommended listing: below market by at least 10% and rent coverage at least 1.0.
- Near-threshold listing: rent coverage at least 0.8.

## Hard Exclusions

Apply these exclusions before ranking recommended, near-threshold, and excluded listings:

- Exclude listings that are clearly more than 800 meters from the nearest MRT station.
- Do not exclude a listing for MRT distance when the listing data does not clearly show distance or enough station/location evidence to determine it.
- Exclude auction and special-disposition listings, including foreclosure, court auction, bank auction, tender, bidding, and similar cases.
- Treat title, source labels, listing notes, tags, and visible listing metadata as evidence for these exclusions.
- Keep hard-exclusion counts and main reasons visible in the report summary when any are found.

## Calculations

- Market discount percentage must use: `(market_unit_price - listing_unit_price) / market_unit_price * 100`.
- A positive discount means the listing is below estimated market price.
- A negative discount means the listing is above estimated market price.
- A listing satisfies `below market by at least 10%` only when discount percentage is `>= 10`.
- Rent coverage must use: `estimated_monthly_rent / monthly_mortgage_payment`.
- Monthly mortgage payment must use total price, 80% loan-to-value, 2.6% annual interest, and 30-year principal and interest repayment.

## Manual Checks

- Actual achievable rent and expected vacancy period.
- Property condition, leaks, roof waterproofing, and repair cost.
- Loan-to-value, bank appraisal, and interest-rate terms.
- Illegal additions, rooftop additions, title issues, or zoning/use issues.
- Whether comparable transaction data is close enough by area, age, floor, and property type.

## Data Quality Rules

- Prefer fresh iBigFun listing and real-price data from the target report date.
- If market data is stale, cached, timed out, or sourced from another site, say so in the quick summary and the affected listing notes.
- Do not label a listing as recommended when its market comparison depends only on stale, timed-out, or weak comparable data. Put it in near-threshold or excluded status and mark it for manual confirmation.
- Keep the source used for each market estimate visible in the listing notes.
- Track seen listing IDs using `docs/automation-state.md` so reposts, edited listings, and cross-day duplicates can be handled consistently.

## Notification Format

- Send with `ai-notify --details-file <markdown-file>`. See `docs/daily-workflow.md` for the full command shape and status selection.
- Use Markdown.
- Do not use tables.
- Put the quick summary before listing details.
- Add a Markdown link to every listing title.
- Render each listed property with a 1-based `rank` value inside its section.
- If the target-date new-listing count is 10 or lower, list all excluded properties.
- If the target-date new-listing count is above 10, list only the 5 excluded properties closest to the threshold.
- Sort recommended listings by discount percentage, highest first.
- Sort near-threshold listings by rent coverage, highest first.
- Sort excluded listings by rent coverage, discount percentage, then lower total price.
- Keep a single notification around 3,500 Chinese characters when possible. Compress excluded listings first; keep core numbers for recommended and near-threshold listings.

## Rule Ownership

Keep durable investment, sorting, notification, and data-quality rules in this file. Keep daily execution steps in `docs/daily-workflow.md`. Keep recent run history and one-off operational observations in automation memory.
