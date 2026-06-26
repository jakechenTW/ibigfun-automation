# Reporting Rules

## Investment Criteria

- Mortgage assumption: 80% loan-to-value, 2.6% annual interest, 30-year principal and interest repayment.
- Recommended listing: below market by at least 10% and rent coverage at least 1.0.
- Near-threshold listing: rent coverage at least 0.8.

## Manual Checks

- Actual achievable rent and expected vacancy period.
- Property condition, leaks, roof waterproofing, and repair cost.
- Loan-to-value, bank appraisal, and interest-rate terms.
- Illegal additions, rooftop additions, title issues, or zoning/use issues.
- Whether comparable transaction data is close enough by area, age, floor, and property type.

## Notification Format

- Send with `ai-notify --details-file <markdown-file>`.
- Use Markdown.
- Do not use tables.
- Put the quick summary before listing details.
- Add a Markdown link to every listing title.
- If the daily new-listing count is 10 or lower, list all excluded properties.
- If the daily new-listing count is above 10, list only the 5 excluded properties closest to the threshold.
- Sort recommended listings by discount percentage, highest first.
- Sort near-threshold listings by rent coverage, highest first.
- Sort excluded listings by rent coverage, discount percentage, then lower total price.
- Keep a single notification around 3,500 Chinese characters when possible. Compress excluded listings first; keep core numbers for recommended and near-threshold listings.
