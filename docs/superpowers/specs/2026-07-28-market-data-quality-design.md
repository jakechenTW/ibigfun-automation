# Taipei Market-Data Quality and Coverage Design

**Date:** 2026-07-28  
**Status:** Approved design  
**Scope:** Taipei official market-data normalization, comparable coverage,
backtest acceptance, and atomic publication

## Goal

Improve official market-price availability without weakening the investment
profile's safety rules.

The release succeeds only when both conditions hold:

1. At least 70% of eligible listings receive an official market estimate.
2. The production-eligible `reliable` backtest cohort has median APE at or
   below 12% and P75 APE at or below 20%.

An eligible listing has a supported server-side building type, a reliable
Taipei coordinate, usable floor and area fields, freehold ownership evidence,
and separable or explicitly absent parking. Listings that fail those
prerequisites are outside the coverage denominator rather than counted as
missing comparable coverage.

The design does not lower the existing accuracy thresholds, mix building
types, or use first-floor transactions to value ordinary upper-floor homes.

## Evidence and Root Cause

The active raw transaction set contains 73,820 rows, but only 2,180 rows enter
the transaction index, an inclusion rate of 2.95%.

The largest exclusion reason is `location-unresolved`:

- 40,100 rows are excluded for unresolved locations.
- 36,772 of those rows have a parsed exact door number on a road present in
  the doorplate index.
- These rows fail because the doorplate build stores a base address such as
  `台北市士林區格致路20巷1號`, while transaction lookup uses the full address,
  such as `台北市士林區格致路20巷1號四樓之12`.

The active indexed transactions also mix residential and non-residential use:

- 1,339 are `住家用`.
- 71 are `住商用`.
- The remaining 770 include commercial, industrial, office, other, and blank
  uses.

An offline diagnostic slice demonstrated that residential eligibility is a
material accuracy control:

| Backtest slice | Medium median APE | Medium P75 APE | Medium bias |
|---|---:|---:|---:|
| Current mixed-use index | 11.96% | 22.61% | +10.99% |
| `住家用` only | 9.97% | 19.50% | +1.13% |
| `住家用`, one building, no government sale | 9.96% | 18.89% | +1.12% |

These diagnostics establish the implementation order: repair address
canonicalization and transaction eligibility before relaxing comparable
selection.

## Architecture

The public pipeline remains:

```text
fetch -> enrich -> report -> notify
```

The market-data subsystem becomes a candidate-build pipeline:

```text
official doorplate CSV
  -> address normalization
  -> baseDoorplateKey
  -> doorplate index

official transaction CSV
  -> schema and special-transaction validation
  -> baseDoorplateKey location
  -> eligibility classification
       -> reliable-eligible
       -> review-only
       -> excluded
  -> candidate transaction index

candidate index
  -> deterministic backtest
  -> acceptance decision
       -> pass: atomically publish build + matching acceptance
       -> fail: retain last-known-good active build + acceptance
```

No candidate build becomes active before its acceptance decision completes.
The active transaction index and acceptance therefore cannot represent
different policies or checksums.

## Address Normalization

### Shared base key

Introduce one shared `baseDoorplateKey(address)` operation. Both doorplate
index construction and transaction lookup must use it.

The key consists only of validated address components:

```text
city + district + road + section? + lane? + alley? + number + sub-number?
```

Examples that resolve to the same key:

```text
台北市文山區萬盛街89號之6七樓
台北市文山區萬盛街89之6號七樓
台北市文山區萬盛街89號之6
```

### Accepted normalization

The parser must:

- normalize `臺`/`台`, Unicode width, whitespace, and supported Chinese
  numerals;
- accept both `N號之M` and `N之M號`;
- remove a floor or unit suffix only after city, district, road, and door
  number have been structurally validated;
- continue supporting masked official number ranges;
- retain the original and fully normalized input address in evidence.

### Fail-closed behavior

The parser must not:

- infer a missing city, district, road, or number from arbitrary prose;
- cross roads, sections, lanes, alleys, or districts for a masked range;
- silently treat an ambiguous sub-number as a main number;
- turn an unresolved address into an exact coordinate through nearest-neighbor
  guessing.

## Transaction Eligibility

Every structurally valid transaction receives exactly one eligibility class and
one or more audit reasons.

### `reliable-eligible`

A transaction is eligible to support a `reliable` estimate only when all
existing hard data-quality checks pass and it is:

- `主要用途 = 住家用`;
- one transferred building;
- a general-market transaction;
- a supported official building type;
- freehold;
- located by exact doorplate or bounded masked range;
- backed by valid floor, total-floor, building-area, price, and date fields;
- free of inseparable parking.

### `review-only`

The following evidence may be retained for manual review but must never count
toward the three comparables required for `reliable`:

- `主要用途 = 住商用`;
- a transaction combining more than one building.

Review-only evidence is stored separately or carries an explicit eligibility
field so the reliable selector cannot consume it accidentally.

### `excluded`

Exclude:

- commercial, industrial, office, other, or blank primary use;
- government agency tender or sale;
- related-party, special-disposition, accident, unfinished, non-freehold, or
  other existing explicit special transactions;
- unsupported building type;
- unresolved or conflicting location;
- invalid required values;
- inseparable parking;
- contradictory official and derived unit prices.

The transaction normalizer must ingest and validate `主要用途` and `交易筆棟數`.
It may ingest `電梯` as cross-check evidence, but the official building-type
field remains authoritative unless a contradiction requires exclusion or
review.

## Comparable Selection

### Hard gates

Reliable selection never relaxes:

- district;
- normalized building type;
- ownership class;
- reliable-eligible transaction status;
- valid building-only price and area;
- first-floor isolation;
- location availability.

Review-only transactions cannot fill a reliable comparable shortage.

### Default stages

The existing five stages remain the baseline:

1. 300 m, 12 months, area ±20%, same floor group.
2. 500 m, 12 months, area ±20%, same floor group.
3. 500 m, 36 months, area ±20%, same floor group.
4. 500 m, 36 months, area ±30%, adjacent non-first floor group allowed.
5. 800 m, 36 months, area ±30%, adjacent non-first floor group allowed.

Selection stops at the first stage with at least three retained comparables.

### Experimental fallback stages

Fallback stages are policy experiments, not automatically enabled defaults:

6. 800 m, 48 months, area ±30%, adjacent non-first floor group allowed.
7. 1,000 m, 48 months, area ±30%, adjacent non-first floor group allowed.

Evaluate stage 6 only when the corrected default policy remains below 70%
coverage. Adopt it only if all acceptance requirements continue to pass.
Evaluate stage 7 only when adopted stage 6 remains below 70% coverage, and
apply the same acceptance requirement.

Stop relaxation when median or P75 APE exceeds its threshold, bias materially
worsens, interval calibration regresses, or confidence ordering fails.

Cross-building-type and first-floor relaxation are explicitly out of scope.

## Estimate Status

### `reliable`

An estimate is `reliable` only when:

- at least three retained reliable-eligible comparables exist;
- confidence is medium or high;
- sources are fresh;
- no listing-side location, ownership, parking, or field conflict exists;
- the active build has a matching passing acceptance.

### `review`

Use `review` when evidence exists but one or more conditions prevent automatic
use, including:

- only review-only evidence is available;
- fewer than three reliable-eligible comparables;
- the interval is too wide;
- the selected evidence produces low confidence;
- listing location is range-based or otherwise uncertain;
- acceptance is missing, failed, expired, or mismatched.

### `unavailable`

Use `unavailable` when the listing cannot be safely located or has no usable
official transaction evidence, or when required listing fields such as
building type, floor, or area are unavailable.

## Backtest and Acceptance

Backtest output must report separate cohorts:

- all eligible held-out listings, for estimate coverage;
- production-eligible `reliable`, for the primary accuracy gate;
- high confidence;
- medium confidence;
- review/low confidence, for diagnostics only;
- building-type slices.

Acceptance requires all of:

- reliable-cohort median APE at or below 12%;
- reliable-cohort P75 APE at or below 20%;
- at least 20 scored high-confidence cases;
- at least 20 scored medium-confidence cases;
- high-confidence median APE at least one absolute percentage point better
  than medium-confidence median APE;
- estimate coverage of at least 70% across eligible held-out listings;
- complete coverage through the active candidate index's latest eligible
  transaction date;
- matching transaction-index checksum and estimator policy version.

Review-cohort error metrics remain visible but do not block an otherwise valid
reliable acceptance.

Coverage uses the same eligibility predicate in production and backtest.
Unsupported listings do not dilute the denominator, and a policy cannot improve
coverage by silently reclassifying hard failures as eligible.

Any change to eligibility, selector stages, weights, outliers, confidence,
status, coverage semantics, or backtest acceptance must bump
`ESTIMATOR_POLICY_VERSION`.

## Candidate Publication and Failure Handling

Market-data refresh builds into staging:

1. Download or reuse official source artifacts.
2. Build and validate the candidate doorplate index.
3. Classify and build the candidate transaction index.
4. Validate checksums, counts, coordinates, sorting, and closed artifact list.
5. Run the complete candidate backtest.
6. Create candidate acceptance only on a pass.
7. Atomically promote the candidate build and acceptance together.

On refresh, normalization, validation, or backtest failure:

- keep the active build and its matching acceptance unchanged;
- record a redacted failure reason and candidate aggregate diagnostics;
- never leave a candidate acceptance attached to the active index;
- if no active build exists, keep estimates review-only or unavailable.

Published aggregate diagnostics include raw row count, eligibility counts,
exclusion reasons, address resolution rate, estimate coverage, accuracy,
confidence calibration, and interval coverage. They exclude raw addresses,
transaction rows, and listing details.

## Testing

### Address unit tests

Cover:

- exact base doorplates;
- floor and unit suffixes;
- both sub-number orders;
- Unicode width and Chinese-number normalization;
- sections, lanes, and alleys;
- masked ranges;
- malformed and ambiguous addresses;
- prevention of cross-road or cross-district range matches.

Each lookup fixture must assert the real resolved evidence, not source text.

### Transaction classification tests

Assert:

- residential single-building transactions are reliable-eligible;
- mixed residential-commercial and multi-building transactions are
  review-only;
- commercial, industrial, office, blank-use, and government-sale transactions
  are excluded;
- existing parking, ownership, special-transaction, field, and unit-price
  checks remain fail-closed;
- review-only rows cannot enter reliable comparable selection.

### Integration tests

Run sanitized raw doorplate and transaction CSV fixtures through:

```text
normalization -> indexing -> classification -> selection -> estimate
```

Repeated builds from identical inputs must produce identical indexes,
diagnostics, and checksums.

### Backtest and publication tests

Cover:

- reliable-cohort accuracy gating;
- 70% eligible-listing coverage gating;
- separate review diagnostics;
- high/medium minimum slice counts and confidence ordering;
- candidate failure retaining the active build and acceptance;
- atomic candidate build plus acceptance promotion;
- checksum or policy mismatch invalidating reliability;
- crash and concurrent-refresh behavior.

## Rollout

1. Implement shared base-doorplate lookup and eligibility classification without
   changing selector stages.
2. Build a candidate index and compare address resolution, transaction
   inclusion, classification, and exclusion counts with the active build.
3. Run the complete backtest with stages 1–5.
4. Publish when accuracy, confidence, completeness, and 70% coverage pass.
5. If coverage remains below 70%, evaluate stage 6 as a separate policy.
6. If an accepted stage 6 remains below 70%, evaluate stage 7 separately.
7. After publication, run one same-day fetch/enrich smoke check without report
   generation or notification.
8. Resume scheduled use only after the smoke check confirms expected
   `reliable`/`review`/`unavailable` distributions and no regression in
   non-market enrichment.

## Non-Goals

- Lowering the 12% or 20% accuracy targets.
- Mixing apartment, midrise, and highrise comparables.
- Using first-floor sales for ordinary upper-floor valuation.
- Replacing official evidence with external AVM output.
- Adding an opaque regression model before deterministic data quality and
  coverage are repaired.
- Expanding beyond Taipei City in this change.

