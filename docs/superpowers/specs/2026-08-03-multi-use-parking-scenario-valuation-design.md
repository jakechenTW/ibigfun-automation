# Multi-Use and Parking Scenario Valuation Design

**Date:** 2026-08-03
**Status:** Approved design
**Scope:** Taipei official transaction normalization, multi-use scenario
valuation, parking imputation, report evidence, and production acceptance

## Goal

Replace the current residential-only, no-listing-parking valuation gate with an
auditable scenario estimator that:

1. values residential, mixed-use, office, commercial, industrial, and
   residential-industrial official transaction segments separately;
2. never guesses a listing's market use or silently mixes official primary-use
   segments;
3. retains official transactions with incomplete parking separation as graded
   evidence instead of discarding all of them;
4. estimates an on-market listing with parking even when iBigFun exposes only
   the parking family and not the parking price or area; and
5. exposes official-search links and enough transaction details for a person to
   locate each comparable on the Ministry of the Interior site.

The change succeeds when it increases usable scenario coverage while preserving
the existing residential accuracy and calibration gates. A newly supported use
or parking cohort cannot be labeled reliable until that cohort independently
passes its acceptance requirements.

## Current Problem

The production estimator was intentionally narrowed to reliable residential
evidence. It currently:

- makes only `住家用`, single-building transactions reliable-eligible;
- makes `住商用` transactions review-only;
- excludes office, commercial, industrial, residential-industrial, blank, and
  other primary uses;
- excludes an official transaction when parking exists but price and area are
  not both present; and
- refuses a listing-side market estimate unless the listing is explicitly
  `無車位`.

The listing-side restriction is stricter than the official transaction rule.
iBigFun exposes `parking_type`, but not an independently stated parking price,
parking area, or parking count. The current pipeline therefore converts an
absence of separable listing fields into a complete estimate refusal.

This also means the current estimator is not a general property estimator.
Listings marketed for residential occupation may legally be mixed-use, office,
commercial, or industrial property. It is unsafe to value those records with a
single blended residential index, but it is also unnecessarily lossy to remove
their same-use official market evidence.

## Design Principles

1. **Official use, not marketing prose.** `主要用途` from official data is a
   comparable dimension. Listing titles such as `工業宅`, `住辦`, or `可住家`
   may be shown as a risk signal, but never prove registered use and never choose
   a primary estimate.
2. **Unknown stays unknown.** The pipeline must not invent a listing registered
   use. Until verified evidence exists, it produces every independently
   supported use scenario.
3. **No cross-use blending.** Each estimate uses one exact normalized official
   use. Any future compatibility grouping requires a separately approved,
   independently backtested policy change.
4. **Parking quality is graded.** Complete direct evidence receives more weight
   than imputed evidence. Incomplete parking does not automatically erase an
   otherwise usable total-price transaction.
5. **No imputation cascade.** Only direct, separable official parking evidence
   trains the parking model. An imputed transaction can support valuation at a
   capped weight but can never train another imputation.
6. **Conservative recommendations remain explicit.** Unknown-use listings may
   be conditionally recommended only under the rules below; they cannot be
   presented as fully verified recommendations.
7. **Every value carries provenance.** Reports distinguish official values,
   derived values, and imputed ranges.

## Normalized Use Model

Introduce the exact normalized official use values:

```text
residential             <- 住家用
mixed-residential       <- 住商用
office                  <- 辦公用
commercial              <- 商業用
industrial              <- 工業用
mixed-industrial        <- 住工用
unknown                 <- blank, missing, or unsupported text
```

The transaction normalizer retains the original official text in evidence and
stores one normalized value. `unknown` transactions remain review evidence and
cannot enter a reliable unit-price distribution.

The listing carries a separate `registeredUse` evidence object:

```ts
interface SubjectUseEvidence {
  value: NormalizedPrimaryUse | 'unknown';
  source: 'official' | 'manual' | 'unknown';
  detail: string | null;
}
```

The initial release does not scrape or infer registered use. Existing listings
therefore default to `unknown` unless a future official integration or explicit
manual override supplies it. There is deliberately no `marketUse` or
`marketedUse` decision field.

## Official Transaction Parking Grades

Every structurally valid official transaction receives one parking evidence
grade in addition to its general transaction eligibility.

### Grade A: direct building-only evidence

A transaction is grade A when it:

- explicitly has no parking with zero or empty parking price and area; or
- has a positive parking price and positive parking area that are both smaller
  than the transaction total price and total building area.

For parking transactions, building-only price and area are calculated directly
by subtracting the official parking pair. Grade A transactions may train the
parking model and receive normal comparable weight.

### Grade B: imputed building-only evidence

A transaction is grade B when it is otherwise structurally eligible, clearly
contains parking, and has a usable parking family but is missing parking price,
parking area, or both. The parking model supplies a bounded joint price/area
distribution. The normalizer preserves official totals and stores the imputed
building-only P25/P50/P75 values plus the imputation evidence.

Grade B may enter a scenario's building-only estimate only when:

- the parking model has passed its cohort acceptance gate;
- the imputation has at least the minimum direct comparable count;
- the imputed interval is not wider than the configured maximum; and
- the grade-B comparable weight is capped below grade A.

The grade-B observation uses its imputed P50 building-only price and area for
selection and weighted quantiles; its P25/P75 imputation bounds remain attached
as uncertainty evidence and contribute to the weight cap and status decision.
Grade B never trains the parking model.

### Grade C: bundle-only evidence

A transaction is grade C when total price and total area remain usable but the
parking evidence is contradictory, the parking family is unknown, or a bounded
imputation cannot be produced. Grade C supports only a whole-property bundle
cross-check. It cannot enter a building-only unit-price distribution and cannot
train the parking model.

### Excluded

A transaction remains excluded when total price, total area, date, location,
building type, ownership, or special-transaction evidence is invalid, or when
the transaction is otherwise not comparable even as a bundle.

Parking grade does not override the existing special-transaction, ownership,
location, or structural quality controls.

## Parking Families and Imputation

Normalize official and listing parking labels into:

```text
flat       <- 坡道平面, 升降平面, and listing 平面
mechanical <- 坡道機械, 升降機械, 機械, and equivalent labels
none       <- 無車位 or consistent empty parking evidence
unknown    <- blank, contradictory, or unsupported labels
```

The model estimates paired parking price and area rather than two unrelated
averages. Candidate direct parking records are selected in this order:

1. exact doorplate/building, same parking family;
2. same building type and parking family within 500 meters; and
3. a later fallback policy only after independent backtest approval.

Candidates must be grade A, precede the valuation as-of date, meet the active
time window, and pass existing official transaction quality gates. Distance,
time, and location precision contribute deterministic weights. Weighted P25,
P50, and P75 price and area values are reported together with count, stage, and
spread.

When a listing has a known parking family but no price or area, the subject is
valued under a one-space scenario:

```text
estimated net building area = listing total ping - imputed parking area
estimated bundle value      = net building area * use-scenario unit price
                              + imputed parking price
```

The P25/P50/P75 bundle interval must be calculated from deterministic paired
observations or a deterministic weighted resampling method; it must not combine
independent extreme quantiles in a way that creates impossible price/area
pairs. The output labels the one-space assumption. A second scenario is added
only when structured listing data or an explicit override establishes two
spaces. Title prose alone does not establish parking count.

If parking imputation fails, the estimator may still publish a building-only
scenario when the subject net area is independently known. With current iBigFun
fields it is normally unknown, so the output becomes a low-confidence bundle
review rather than `unavailable` solely because parking is present.

## Scenario Estimation

### Scenario selection

If `registeredUse` is verified, calculate:

1. the exact same-use scenario, designated primary; and
2. a residential scenario as a clearly labeled market comparison when the
   verified use is not residential.

If `registeredUse` is unknown, calculate every normalized use scenario with
enough independent comparable evidence. A missing cohort is reported as
`insufficient-sample`; the estimator does not borrow transactions from another
use to fill it.

### Comparable selection

Within each use scenario, retain the current hard dimensions and staged search:

- district and normalized building type;
- ownership compatibility;
- first-floor isolation;
- area, age, floor-group, distance, and transaction-time rules;
- candidate transaction date on or before the as-of cutoff; and
- exact normalized primary use.

Grade A receives the normal weight. Accepted grade B receives a separately
configured weight cap. Grade C is selected through a separate bundle selector
and never contributes to the building-only weighted quantiles.

The building-only estimator produces P25/P50/P75 unit prices for each use.
Where parking is present, the parking model converts those into a whole-property
P25/P50/P75 value interval. The bundle selector then reports whether grade-C
whole-property observations corroborate, conflict with, or lack enough evidence
to assess that interval. It does not silently move the interval.

### Status and recommendations

Each scenario has its own status and confidence. `reliable` requires:

- a verified and accepted use cohort;
- at least three retained grade-A or accepted grade-B comparables;
- passing use and parking acceptance for every model component used;
- medium or high confidence;
- fresh sources; and
- no unresolved subject location, ownership, area, or bundle conflict.

Unknown-use listings cannot receive an unconditional recommendation:

- **conditional recommendation:** every reasonably supported scenario passes
  the profile's conservative P25 price gate. This requires at least two
  acceptance-enabled use scenarios, including residential, and no conflicting
  diagnostic scenario;
- **use confirmation candidate:** at least one scenario passes and at least one
  fails, conflicts, or lacks sufficient data;
- **not recommended:** every supported scenario fails the price gate; and
- **human review:** no scenario has enough evidence or the bundle cross-check
  materially conflicts.

For a verified non-residential use, the same-use scenario controls the profile
decision. The residential scenario is comparison-only.

## Report Evidence and Official Links

Each listing report includes a scenario table with:

- exact official use scenario;
- building-only unit-price P25/P50/P75;
- whole-property value P25/P50/P75, including the parking assumption;
- grade A/B/C counts;
- selected search and parking stages;
- confidence, status, acceptance state, and conclusion; and
- an explicit registered-use verification state.

Each displayed comparable includes disclosed address or road range,
transaction month, floor, area, total price, official primary use, building
type, parking family, parking price/area when present, parking grade, distance,
and a provenance label for every imputed value.

The local official feed does not expose a stable public deep-link identifier.
Reports therefore link to the official Ministry of the Interior query entry at
<https://lvr.land.moi.gov.tw/> and print the district, road/address range,
transaction period, floor, total price, and area needed to locate the record.
If a future official source supplies a stable transaction URL, it may replace
the query-entry link without changing valuation semantics.

Reports must not claim that the query-entry URL opens the exact transaction.

## Backtest and Acceptance

The held-out backtest remains leakage-safe: each case uses only transactions
before the case cutoff, and the target transaction cannot train its parking
imputation or use-scenario estimate.

Acceptance reports separate cohorts for:

- normalized official primary use;
- building type;
- no parking, grade-A parking, and grade-B-imputed parking;
- direct-only estimates versus direct-plus-imputed estimates;
- high, medium, and low confidence; and
- verified-use versus unknown-use scenario coverage where a held-out proxy can
  be evaluated without revealing the target.

Residential production quality may not regress:

- reliable median APE remains at or below 12%;
- reliable P75 APE remains at or below 20%;
- existing confidence ordering and interval calibration gates continue to
  pass; and
- eligible coverage may not fall below the active accepted baseline.

Each new use cohort needs enough scored cases to support the same accuracy and
calibration checks before it may emit `reliable`. A cohort with too few cases
is `diagnostic-only`, even if its observed error looks favorable. Exact minimum
sample counts and parking weight caps are estimator policy, must be explicit in
configuration, and may be activated only through a policy-version bump and a
normal candidate/update gate.

Grade B is adopted only when direct-plus-imputed coverage improves over
direct-only coverage without failing accuracy, bias, calibration, or confidence
ordering. Grade C is evaluated as a bundle conflict detector and never improves
the building-only accuracy cohort by construction.

## Publication and Rollout

This change modifies normalization, eligibility, index schema, selection,
confidence, status, and backtest semantics. It therefore requires:

- a transaction/index schema bump;
- an `ESTIMATOR_POLICY_VERSION` bump;
- a full local `market-data update` rebuild rather than a standalone backtest
  acceptance; and
- atomic publication of the new build and matching acceptance under the
  existing journal and recovery contract.

Roll out in three gated increments:

1. **Index and diagnostics:** retain normalized uses, parking families, grades,
   and aggregate cohort metrics without changing daily `marketEstimate`.
2. **Scenario and parking candidate:** run the new estimator through candidate
   and full backtest paths; keep the current residential estimator authoritative.
3. **Production activation:** only after all applicable gates pass, make
   scenario output authoritative and update profile reporting and recommendation
   rules.

A failure in a new use cohort does not invalidate an otherwise passing
residential build. It leaves that cohort diagnostic-only. A failure in the
residential or shared parking component blocks production activation and keeps
the last-known-good active build.

## Privacy and Artifact Rules

Raw transactions, per-case backtest output, and disclosed address evidence stay
under git-ignored local state. Standard output from backtest/candidate commands
may contain case evidence and must not be retained or committed. Preserved
diagnostics remain aggregate-only under
`state/market-data/backtests/taipei/`.

Committed fixtures must be synthetic. Reports generated under `state/runs/`
remain local unless the user explicitly requests otherwise.

## Out of Scope

- Inferring legal or market use from a listing title or free-form description.
- Scraping building registration or use-license data without a separately
  approved source and provenance design.
- Combining official primary-use cohorts to solve sparse data.
- Treating the official query-entry URL as a stable per-transaction deep link.
- Replacing conservative profile gates with the residential comparison value
  for a verified non-residential property.
- Letting RealPing or another external estimate silently overwrite official
  scenario values.
