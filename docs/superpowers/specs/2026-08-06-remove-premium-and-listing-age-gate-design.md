# Remove Asking Premium and Add a Profile Listing-Age Gate — Design

## Goal

Remove the asking-premium mechanism from the repository and prevent listings
older than a profile-defined number of days from being recommended. All four
current profiles use a 365-day limit. Listings whose tenure cannot be computed
remain reviewable candidates but can never be automatically recommended.

## Scope

This change applies to all current profiles:

- `example-investment`
- `example-owner-occupied`
- `investment-taipei.local`
- `owner-occupied-taipei.local`

The two `.local` profiles remain uncommitted local configuration. The committed
examples and profile-authoring documentation define the durable schema.

## Profile Configuration

Each `profile.json` gains a required evaluation block:

```json
"evaluation": {
  "maxDaysOnMarket": 365
}
```

`evaluation.maxDaysOnMarket` is a required non-negative integer. Profile
loading fails before fetch when it is missing, negative, fractional, or not a
number. There is no implicit default or unlimited fallback.

Ad-hoc `--set` and `--unset` flags remain limited to `fetch.*`; they do not
override evaluation policy.

## Deterministic Tenure Gate

Enrichment continues to compute `tenure.daysOnMarket` from the earliest
cross-source listing-history record, anchored to the run range's end date. It
also emits a profile-aware `tenureGate`:

- `eligible`: `daysOnMarket <= maxDaysOnMarket`
- `expired`: `daysOnMarket > maxDaysOnMarket`
- `review`: `daysOnMarket` is `null`

The boundary is inclusive: day 365 is eligible and day 366 is expired when the
profile limit is 365.

The gate is separate from `hardExclusion`. The existing `hardExclusion`
contains walking-distance behavior that profiles consume differently, whereas
the tenure gate has the same meaning for every profile.

Invalid or missing history is never guessed. It produces `review`, including
when history rows exist but no valid tenure can be derived. Old enriched
artifacts without `tenureGate` are not treated as eligible; the enrich step must
be rerun before report generation. Pipeline report completion validates that
every enriched listing has a valid gate, so a resumed pre-change run cannot be
marked complete with a stale artifact.

## Shared Bucket Precedence

Both profile families apply these tenure rules before their ordinary positive
matching logic:

1. `expired` goes to exclusion and can never appear as recommended or a
   candidate.
2. A verified risk verdict goes to the risk bucket, even when other data is
   missing.
3. `review` goes to the data-review candidate bucket and can never be
   automatically recommended.
4. `eligible` continues through the profile's remaining criteria.

This yields clear report vocabulary:

- Investment: `推薦物件`, `候選／資料待確認`, `風險物件／待查`, `排除物件`
- Owner-occupied: `符合條件`, `候選／資料待確認`, `風險物件／待查`, `排除摘要`

The candidate bucket means the listing appears normal and may qualify after
missing or weak evidence is resolved. The risk bucket means the listing itself
has suspicious, auction-like, ownership, use, or information-quality signals.
Risk takes precedence when both descriptions apply.

Quick summaries show separate counts for listings over the configured age
limit and listings whose tenure needs review.

## Investment Recommendation After Premium Removal

Asking premium is no longer a gate, explanatory metric, suspicious-low-price
signal, or sort key. An investment listing may be recommended when all of the
following hold:

- `tenureGate === "eligible"`
- the existing investment region and walking requirements pass
- the agent verdict is clean rather than suspicious or likely-auction
- the official market estimate is reliable and fresh with confidence other
  than `low`
- parking, ownership, and other existing data-quality requirements pass

Official market evidence remains visible as market context and a reliability
check. The asking price is not compared with the official estimate to decide
whether the listing is a bargain.

Investment recommendations, candidates, and listed exclusions sort by:

1. known `daysOnMarket`, ascending
2. total price, ascending

Unknown tenure appears only in the candidate bucket and sorts after candidates
with known tenure.

## Complete Asking-Premium Removal

Remove all repository-owned asking-premium machinery:

- `askingPremiumMedian` and `askingPremiumConservative` output fields
- `askingPremiumPercent`
- the unused inverse `discountPercent`, which represents the same comparison
- estimator and scenario-estimator premium calculations
- tests and fixtures that assert premium values
- premium placeholders, headings, bucket thresholds, suspicious-low-premium
  rules, and premium sorting in reports
- `p*`, negotiation-rate references, and `data/negotiation-rate.md`
- premium instructions in operational prompts and market-data documentation

Retain the listing's asking price and unit price. Retain asking-price input
validity checks in market estimation because they are general listing-data
quality checks, not premium outputs. Retain official market median and P25–P75,
confidence, comparable count, selected stage, source freshness, and evidence.

Retain the external-versus-official `differencePercent` in bounded valuation
reviews. It compares two valuation sources rather than the listing asking price
and therefore is not asking premium.

Estimator selection, weighting, confidence, status, eligibility, and backtest
semantics do not change. This design therefore does not bump
`ESTIMATOR_POLICY_VERSION` or require a market-data rebuild. If implementation
would change any of those semantics, it must stop and revise this design before
proceeding.

## Report and Operational Documentation Changes

Update both profile templates, both committed evaluation rule files, shared
reporting rules, the daily-run prompt, `AGENTS.md`, `docs/market-data.md`,
`profiles/README.md`, and the data-file index.

Investment's former `接近門檻` bucket becomes `候選／資料待確認`. Template
headers no longer display premium. Empty-state text refers to the current
profile and data-quality criteria rather than a price threshold.

The owner-occupied template adds an explicit risk section so the shared
candidate-versus-risk distinction is visible instead of being compressed into
an exclusion reason.

The existing tenure line remains in listing details. An expired listing may be
summarized or displayed according to each profile's existing exclusion-detail
policy, but it must be counted as excluded with a reason that names the profile
limit.

## Errors and Compatibility

- Invalid evaluation configuration fails profile loading before any network
  request.
- Missing or malformed tenure evidence fails closed to `review`, not
  `eligible` or `expired`.
- Multi-day runs continue to anchor tenure at the inclusive range end.
- Existing local run artifacts are not migrated in place. Rerunning enrich
  regenerates them with the new output contract.
- Pipeline report completion rejects an enriched artifact with a missing or
  invalid `tenureGate` and directs the operator to rerun enrich.
- Removed premium fields are a deliberate local artifact contract break. No
  compatibility aliases or deprecated duplicate fields remain.

## Verification

Automated tests cover:

- valid and invalid `evaluation.maxDaysOnMarket` profile values
- schema tests using committed fixtures, plus a direct load check for all four
  profiles currently present in this workspace
- the inclusive boundary: 365 eligible, 366 expired
- null tenure producing `review`
- range-end anchoring
- enriched output carrying the correct profile-aware gate
- report completion rejecting a legacy enriched artifact without the gate
- market and scenario estimates containing no `askingPremium*` fields
- the remaining market estimate values and statuses staying unchanged
- report-rule and template terminology after bucket renaming

Repository checks include the full test suite and TypeScript type checking. A
targeted repository search must find no live asking-premium, `p*`, or
negotiation-rate references outside historical design and implementation-plan
documents. Historical records under `docs/superpowers/` remain unchanged.

## Acceptance Criteria

- All four profiles set `maxDaysOnMarket` to 365.
- A listing at 365 days can still be recommended if every other profile rule
  passes.
- A listing at 366 days is excluded by both profile families.
- A listing with unknown tenure can appear only under
  `候選／資料待確認`, unless a risk verdict routes it to
  `風險物件／待查`.
- Investment recommendation no longer depends on or displays any comparison
  between asking price and market estimate.
- Runtime artifacts and current source documentation contain no asking-premium
  fields or negotiation-rate mechanism.
- Official market evidence and its reliability gates continue to work without
  a policy-version change.
