# GPS-Based Market Estimation Design

**Date:** 2026-07-26  
**Status:** Approved design  
**Initial scope:** `example-investment`, Taipei City

## Goal

Replace the report agent's ad-hoc market-price lookup with a reproducible hybrid
valuation flow:

1. Official transaction and doorplate data produce a deterministic baseline
   estimate from the listing GPS coordinate.
2. The agent reviews low-confidence and threshold-boundary listings with 好時價
   or 樂居.
3. Every estimate retains its comparable transactions, source versions,
   uncertainty, and decision rationale.

The first release supports Taipei City only. Interfaces and stored metadata must
permit adding other cities later without changing the listing-facing estimate
shape.

## Current Problem

`fetch` obtains listing fields and `enrich` computes deterministic finance and
walking signals, but market estimation remains entirely in the agent-owned
report step. The normalized iBigFun API result always has
`realPriceUrl: null`, so the documented iBigFun real-price link is not available
to the automated run. Comparable selection has no enforceable time, distance,
area, floor, parking, or confidence rules, and the report does not preserve
structured valuation evidence.

The existing premium formula remains unchanged:

```text
asking premium =
  (listing asking unit price - transaction market unit price)
  / transaction market unit price
  * 100
```

## Chosen Approach

Build versioned, local spatial indexes before daily estimation. This was chosen
over scanning raw CSV files on every run and over introducing a SQLite-backed
or regression-based valuation system.

The index is transparent, dependency-light, reproducible, and appropriate for
the current Taipei-only volume. A database or calibrated statistical model may
replace its internals later without changing the estimator interface.

## Official Data Sources

### Taipei doorplates

Use the Taipei City Government `臺北市門牌位置數值資料` dataset as the primary
forward and reverse geocoder:

- Dataset page:
  `https://data.taipei/dataset/detail?id=b7c8e724-1e98-45ee-a0bd-f3840623ed97`
- Published fields include city/district codes, village, neighborhood, road,
  area, lane, alley, number, and horizontal/vertical coordinates.
- The dataset is public, free, and published monthly.
- Convert its TWD97 coordinates to WGS84 during index construction.

This local dataset is the sole required geocoder for the first release. TGOS
may be implemented later behind a provider interface, but no TGOS key or
online geocoder is required for normal operation.

### Official transaction data

Use the Ministry of the Interior real-price open data download for sale
transactions:

- Download entry point: `https://plvr.land.moi.gov.tw/DownloadOpenData`
- Government dataset description:
  `https://data.gov.tw/dataset/139700`
- Required inputs include district, masked location/building address,
  transaction date, transferred floor, total floors, building type, completion
  date, building area, total price, unit price, parking type, parking area,
  parking price, notes, and record ID.

The updater must resolve and store the exact resource URL used for each version
in the local manifest. Raw source data and derived indexes remain under
git-ignored `state/`.

## Architecture

### 1. Market-data updater

Provide an explicit command:

```bash
npm run market-data -- update --city taipei
```

At the beginning of `enrich`, perform a lightweight source-version check and
download only when a source changed. On the first run, build the required
indexes automatically.

Store all artifacts under:

```text
state/market-data/taipei/
  manifest.json
  raw/
  doorplates-index.json
  transactions-index.json
```

`manifest.json` records:

- format/schema version;
- source dataset and resolved resource URLs;
- source publication/update timestamps when available;
- last successful check and download timestamps;
- content checksums;
- record counts;
- coordinate systems;
- build timestamp;
- stale status and last failure summary.

### 2. Address normalizer and local locator

Normalize:

- `臺` and `台`;
- full-width and half-width characters;
- Arabic and Chinese address numbers;
- section, lane, alley, sub-alley, number, and attached-number forms;
- insignificant whitespace and punctuation;
- masked number ranges such as `1~30號`.

Supported location results:

- `exact-doorplate`: one matched doorplate coordinate;
- `address-range`: all plausible doorplates inside a masked number range,
  represented by a centroid and an uncertainty radius covering the candidates;
- `nearest-doorplate`: the nearest local doorplate to an input GPS coordinate;
- `unresolved`: no sufficiently safe result.

Every result includes the normalized and matched addresses, method, confidence,
uncertainty in metres, doorplate dataset version, and WGS84 coordinate.

For transaction positioning, exact and range matches are allowed. A range match
is never presented as an exact point and is down-weighted by its uncertainty.
Spatial eligibility for a range match uses the nearest plausible point in the
range, while distance weighting uses the farthest plausible point. This permits
a genuinely nearby masked transaction without granting it optimistic weight.
For listing validation, reverse lookup checks the listing GPS against the text
district/address. A conflict makes automatic valuation unavailable until the
existing agent location-triage process supplies a reliable coordinate.

### 3. Transaction index builder

Parse and validate official transactions, normalize their monetary and area
units, geolocate them with the doorplate index, and group them into compact
spatial grid cells.

Each indexed transaction retains:

- official record ID and transaction date;
- source dataset version;
- original masked address and normalized address;
- location method, coordinate, and uncertainty;
- district;
- transaction and ownership type;
- normalized building type;
- building and parking areas;
- total and parking prices;
- normalized building-only unit price;
- transferred floor, total floors, and derived floor group;
- completion date and derived age where available;
- notes and normalized exclusion flags.

The index format is versioned. Daily queries load only the listing's nearby grid
cells rather than scanning the complete raw datasets.

### 4. Market estimator

For each listing with a reliable Taipei GPS coordinate, query nearby
transactions, apply hard comparability gates, progressively relax bounded
criteria, calculate weights and robust statistics, and attach a structured
`marketEstimate` to the enriched listing.

The report agent consumes this baseline. It no longer invents a market unit
price when deterministic evidence is available.

## Transaction Normalization

### Building types

Normalize official and listing labels into at least:

- `apartment`（公寓）;
- `midrise`（華廈）;
- `highrise`（住宅大樓）.

These types are never compared across categories. Unrecognized or conflicting
types yield `review`.

### Floor groups

All three building types treat the first floor as an independent group.

For apartments:

- first floor: `first`;
- floors 2–3: `low`;
- the top floor: `top`;
- floor 4 through the floor below the top: `middle`.

A four-floor apartment therefore has no middle group; its fourth floor is
`top`. A five-floor apartment has floor 4 as `middle` and floor 5 as `top`.

For midrise and highrise buildings:

- first floor: `first`;
- floors 2–4: `low`;
- floors 5–7: `middle`;
- floors 8 and above: `high`.

When building age is needed, compare ages at the listing target date, derived
from completion dates. Do not compare a subject's current age with a
comparable's historical age on its transaction date.

### Parking normalization

The estimator compares building-only prices:

- no parking: derive unit price from building total price and building area,
  and cross-check the official unit-price field;
- separable parking: subtract both parking price and parking area before
  calculating building-only unit price;
- parking exists but either parking price or parking area cannot be separated:
  exclude the transaction from automatic valuation.

If the listing itself includes parking but iBigFun does not expose a separable
asking parking price and area, the listing cannot be automatically recommended.
It receives `review` for an agent-side parking adjustment.

### Special transactions

Exclude records whose structured fields or notes reliably identify:

- relatives or related-party transactions;
- urgent/special-disposition terms;
- accident properties;
- unfinished shell transactions;
- superficies, use-right, or other non-freehold ownership;
- another explicit condition that makes the price non-market.

Rules must match explicit evidence. Ambiguous note text is retained with a
review flag rather than silently excluded.

## Comparable Selection

Selection stops relaxing once a stage yields at least three comparables. All
qualifying comparables at that selected stage are retained.

The stages are:

1. within 300 m, transaction age at most 12 months, area difference at most
   20%, same floor group, and—for midrise/highrise only—building-age difference
   at most 10 years;
2. expand radius to 500 m;
3. expand transaction age to 36 months;
4. expand area difference to 30%, midrise/highrise building-age difference to
   15 years, and permit an adjacent floor group;
5. finally expand radius to 800 m.

Hard gates that never relax:

- same district;
- same normalized building type;
- same freehold/non-freehold ownership class;
- valid building-only unit price;
- transaction no older than 36 months;
- listing coordinate reliability.

Apartment age is recorded but never gates or weights comparability.
The `first` floor group remains isolated even at the relaxed stage; it is never
treated as adjacent to `low`.

## Weighting

Use transparent multiplicative weights. Initial constants are:

### Distance

- up to 300 m: `1.0`;
- over 300 m through 500 m: `0.75`;
- over 500 m through 800 m: `0.5`.

### Transaction age

- up to 12 months: `1.0`;
- 13–24 months: `0.7`;
- 25–36 months: `0.4`.

### Location precision

- exact doorplate: `1.0`;
- address range: `max(0.5, 1 / (1 + uncertaintyMeters / 400))`.

Relaxed matches receive these initial additional factors:

- area outside 20% through 30%: `0.85`;
- midrise/highrise age outside 10 years through 15 years: `0.85`;
- adjacent floor group: `0.7`.

All constants must be centralized and covered by tests; they may not be
embedded only in agent prose.

The first version does not apply opaque price adjustments or regression
coefficients. Future calibration may change weights using backtest evidence.

## Estimation and Outliers

Calculate:

- weighted median market unit price;
- weighted P25 and P75;
- middle estimate asking premium using the weighted median;
- conservative asking premium using P25, the market-price outcome least
  favorable to the listing.

When at least five pre-outlier comparables exist, use weighted median absolute
deviation to identify extreme unit prices. Excluded outliers remain in evidence
with their exclusion reason. Do not perform statistical outlier removal with
only three or four comparables.

## Confidence and Status

`marketEstimate.status` is one of:

- `reliable`;
- `review`;
- `unavailable`.

Confidence is `high`, `medium`, or `low`.

Status mapping is explicit:

- `reliable`: at least three retained comparables, high or medium confidence,
  fresh sources, and no hard conflict;
- `review`: evidence exists but confidence is low, a source is stale, or a
  listing-side conflict needs agent judgment;
- `unavailable`: no valid local index, no usable location, or no usable
  comparable evidence.

### High

- at least five retained comparables;
- final 800 m relaxation not used;
- IQR width no greater than 15% of the weighted median;
- source data fresh;
- no listing coordinate, type, ownership, or parking conflict.

### Medium

- at least three retained comparables;
- IQR width no greater than 25% of the weighted median;
- no hard conflict.

### Low/review

Any of:

- fewer than three comparables;
- IQR width greater than 25%;
- unreliable/conflicting listing GPS;
- unresolvable listing parking;
- stale sources;
- conflicting property metadata.

Transaction data is stale when a new version has not been successfully checked
for more than 30 days. Doorplate data is stale after 60 days without a
successful version check. Stale estimates cannot be high confidence or support
an automatic recommendation.

## Recommendation Semantics

The profile's existing `p*` premium thresholds remain unchanged.

- Recommend only when estimate status is reliable, confidence is high or
  medium, and the conservative premium calculated from P25 still satisfies the
  recommendation threshold.
- If the median premium qualifies but conservative premium crosses the
  threshold, place the listing in near-threshold and require external review.
- Low, review, or unavailable estimates cannot support recommendation.
- The existing suspicious-listing, region, walk, ownership, and data-quality
  rules continue to apply independently.

## Agent Review Evidence

For low-confidence or boundary listings, the agent may query 好時價 or 樂居.
It must not silently replace the official-data estimate.

When external valuation evidence is used, write:

```text
state/runs/<profile>/<label>/valuation-review.json
```

Each review entry contains:

- listing ID;
- external source name and URL;
- checked-at timestamp;
- returned unit and total prices when available;
- official estimate and interval;
- numeric difference;
- whether the external evidence was accepted;
- acceptance/rejection rationale;
- resulting report bucket.

The file is optional when no external review occurs. Report notes summarize the
same source and confidence without needing to expose every comparable.

## Enriched Output Shape

The exact TypeScript names may be refined during implementation, but the
contract must carry:

```text
marketEstimate:
  status
  confidence
  marketUnitPriceMedian
  marketUnitPriceP25
  marketUnitPriceP75
  askingPremiumMedian
  askingPremiumConservative
  selectedStage
  sourceFreshness
  unavailableReasons[]
  comparables[]
  excludedCandidates[]
```

Each comparable includes enough normalized source fields, distance, location
precision, weight components, and inclusion/exclusion reasons to reproduce the
estimate.

## Update Safety and Failure Handling

Use last-known-good and atomic publication:

1. download into a temporary directory;
2. validate HTTP status, required headers, minimum plausible row counts,
   coordinate bounds, and checksums;
3. build and fully validate new indexes;
4. atomically replace the active manifest/index set only after success.

On download, parsing, or schema failure:

- retain the previous active version;
- journal a redacted, actionable warning;
- mark freshness correctly;
- never guess how a changed official field maps.

If no valid index exists, `enrich` still completes finance, walk, region, and
other independent fields. Market estimates become `unavailable`, and the final
notification must be at least `warn`.

## Testing

Tests never require live network access.

### Unit tests

Cover:

- Chinese/Taiwan address normalization;
- sections, lanes, alleys, attached numbers, and masked ranges;
- TWD97/WGS84 conversion;
- exact, range, nearest, and unresolved location results;
- building-type and floor-group normalization;
- parking separation;
- special-transaction rules;
- distance/time/precision weights;
- weighted quantiles and weighted MAD;
- confidence and conservative premium.

### Selection tests

Cover every stage transition:

- 12 to 36 months;
- 300 to 500 to 800 m;
- 20% to 30% area tolerance;
- applicable building-age relaxation;
- adjacent floor groups;
- district, type, ownership, and coordinate hard gates;
- apartment age non-gating.

### Integration tests

Use small sanitized doorplate and transaction fixtures to run raw CSV through
normalization, spatial indexing, selection, and final `marketEstimate`.
Repeated builds from the same sources must produce identical estimates and
stable checksums.

### Failure tests

Cover interrupted downloads, bad CSV, schema drift, stale cache, coordinate
conflicts, insufficient comparables, parking ambiguity, and atomic rollback to
last-known-good.

## Backtesting and Acceptance

Provide:

```bash
npm run market-data -- backtest --city taipei
```

For each historical transaction selected as a held-out subject, use only
transactions whose dates precede the subject transaction. Report metrics
overall and by building type:

- estimate coverage;
- median absolute percentage error;
- P75 absolute percentage error;
- signed bias;
- actual coverage of the predicted P25–P75 interval;
- error by high, medium, and low confidence.

The first real-data run establishes and stores a local baseline. Initial
acceptance targets are:

- overall median absolute percentage error no greater than 12%;
- P75 absolute percentage error no greater than 20%;
- high-confidence estimates measurably outperform medium-confidence estimates.

If targets are missed, keep affected results in review and recalibrate
selection/weight constants using backtest evidence. Do not weaken recommendation
safety to improve apparent coverage.

## Non-Goals

The first release does not:

- support cities outside Taipei;
- build a black-box AVM or regression model;
- scrape or reverse-engineer 好時價 endpoints;
- require Google, Mapbox, OSM Nominatim, or TGOS;
- auto-resolve unreliable iBigFun coordinates;
- estimate an inseparable listing parking value;
- change the profile's negotiation-rate or premium thresholds;
- commit official raw data, derived local indexes, or run evidence.
