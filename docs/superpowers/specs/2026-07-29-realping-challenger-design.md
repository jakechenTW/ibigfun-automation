# RealPing Challenger Benchmark Design

## Goal

Evaluate whether RealPing's cleaned transaction feed improves Taipei market
estimates when it is used by an isolated reduced-feature geospatial challenger.
The challenger uses the repository's existing distance, time, building-type,
area, building-age, outlier, weighting, and confidence concepts, but it cannot
apply floor-group matching because RealPing's public records do not expose the
transferred floor or total floors. The experiment must not change daily
enrichment, reporting, notification, recommendation buckets, or the
authoritative `marketEstimate`.

RealPing may replace the official production estimator only in a later,
separately approved change after the challenger improves both median APE and P75
APE without reducing eligible-case coverage.

## Scope

The first phase adds one standalone benchmark command. It:

- reads `REALPING_API_KEY` from the environment or project-local `.env`;
- obtains RealPing transaction records through its documented
  `GET /transactions` endpoint;
- validates the live response against the observed public API contract;
- adapts eligible RealPing records into a dedicated challenger transaction
  model;
- applies GPS, distance, time, area, age, building-type, outlier, weighting,
  and confidence logic without inventing floor evidence;
- evaluates the challenger and current official estimator on identical held-out
  cases; and
- writes an aggregate-only diagnostic report.

This phase does not call `GET /comps-estimate`, `GET /area-stats`, or
`GET /value-check`. Those endpoints use same-building or area-level aggregates
and, in some cases, an "actual interior ping" price basis that cannot be
compared directly with iBigFun's registered-building-area unit price.

## Command and Isolation

The experiment is exposed as a dedicated package command:

```bash
npm run realping-benchmark -- --city taipei [--as-of YYYY-MM-DD]
```

It does not run from `fetch`, `enrich`, `pipeline`, or `market-data update`.
Failure, missing credentials, quota exhaustion, schema drift, or an unavailable
RealPing service affects only the benchmark command.

No estimator policy version is bumped in this phase because no production
estimator semantics change.

## Price Basis

The challenger uses RealPing's `去車位單價_萬元坪`, which remains measured per
registered building ping after parking is removed. It must not substitute
`實坪單價_萬元坪`, because iBigFun listings do not reliably provide the
main-building and accessory areas needed to convert registered ping to actual
interior ping.

The held-out actual and both predictions therefore use the same unit:
ten-thousand New Taiwan dollars per registered building ping, excluding
separable parking.

Transactions whose parking contribution cannot be separated remain ineligible,
matching the existing conservative production rule.

## Live Contract Validation

RealPing's public OpenAPI document does not describe its response body schema.
An authenticated schema-only probe on 2026-07-29 established that
`GET /transactions` returns the envelope fields `count`, `total`, `limit`,
`offset`, `data`, and `source`. Each `data` record exposes:

- `縣市`, `區`, `門牌`, `交易日`, `建物型態`, and `主要用途`;
- `屋齡`, `總價`, `淨建坪`, and `去車位單價_萬元坪`;
- `實坪`, `實坪單價_萬元坪`, `原始單價_萬元坪`, and `公設比`;
- `房`, `廳`, and `衛`;
- `是否特殊`, `含車位無價`, `多物件`, `單價可用`, `實坪可用`, and
  `日期異常`; and
- `來源期別`.

The endpoint does not expose a transaction identifier, transferred floor, total
floors, completion date, parking area, or parking price. The challenger must not
guess those fields or coerce a record into the production `MarketTransaction`
type.

Before downloading a benchmark corpus, the command performs a small
authenticated request and validates the envelope and record keys against this
observed contract. Each usable challenger record requires:

- a valid transaction date;
- Taipei city, district, and a locatable disclosed doorplate or address range;
- a supported building type and residential primary use;
- finite, nonnegative reported age;
- positive registered net building area;
- positive `去車位單價_萬元坪`;
- `是否特殊 === false`, `含車位無價 === false`,
  `多物件 === false`, `單價可用 === true`, and
  `日期異常 === false`; and
- a nonempty source period.

The command stops with a concise contract error if any required field is absent,
malformed, or semantically ambiguous. It must not silently substitute an
area-level median, actual-interior-ping price, zero, or guessed value.

## Data Acquisition and Cache

Requests are grouped by Taipei district, building type, and bounded date window
instead of making one API call per held-out case. Pagination follows the
documented `limit`, `offset`, `total`, and `count` contract.

The client:

- sends the key only in the `X-API-Key` header;
- uses an explicit request timeout;
- handles HTTP 401/403 as credential failures;
- handles HTTP 429 as quota exhaustion and reports the provider's response
  without retrying indefinitely;
- applies a small bounded retry only to transient 5xx/network failures; and
- never logs headers or the API key.

Raw responses may be cached only under git-ignored
`state/market-data/realping-cache/`. Cache entries record the request parameters,
fetch time, response checksum, and provider schema fingerprint. They contain no
secret. Schema mismatch invalidates the cache.

Raw provider records are never written to stdout, committed, or copied into the
aggregate report.

## Adapter and Geospatial Selection

A focused adapter converts validated provider records to a new
`RealPingComparable` interface. Address disclosure is resolved using the active
Taipei doorplate index and the same uncertainty representation used by official
transactions.

Because the provider omits floor evidence, the challenger has a separate
estimator rather than weakening or adding optional branches to the production
selector. It uses the active policy's search radii, date windows, area
tolerances, distance weights, time weights, and confidence-class boundaries.
It applies these candidate checks:

- same district and building type;
- transaction date on or before the case cutoff;
- distance within the current stage radius, including address uncertainty;
- net building area within the current stage tolerance; and
- for midrise/highrise, building age at the held-out date within the current
  10/15-year tolerance.

For age comparison, the provider's reported age at sale is advanced by the
elapsed whole months between the comparable transaction and held-out date.
Apartment candidates retain the production rule that does not require building
age. No floor weight is applied and no synthetic floor group is assigned.

The challenger reuses the production weighted-MAD outlier and weighted-quantile
helpers. Its total candidate weight is distance × time × location precision ×
area × building age. Confidence and status use the same comparable-count, IQR,
fallback-stage, and freshness thresholds as production, except that the
benchmark report always labels this as a reduced-feature challenger.

Since RealPing does not expose its internal transaction ID, the adapter creates
a deterministic local key from the complete provider record. Exact duplicate
records collapse to one. A key collision with unequal records is a contract
error and makes the run inconclusive; records must never silently overwrite one
another.

Provider records remain excluded when their address cannot be located,
district/building type is inconsistent, parking is inseparable, the transaction
is special or multi-property, or another existing reliable-eligibility rule
fails.

## Held-Out Evaluation and Leakage Prevention

The benchmark uses the active official eligible transaction index as the
held-out case source so both estimators see identical subjects and actual
prices.

For each held-out case:

1. The as-of cutoff is the calendar day before that transaction.
2. Both estimators may use only transactions on or before that cutoff.
3. All transactions on the held-out transaction date are absent from both
   historical corpora. This prevents target leakage without needing RealPing's
   unexposed source identifier and matches the production backtest's existing
   same-date isolation.
4. Existing production eligibility rules determine which cases belong in the
   denominator.

A command-level `--as-of` may limit the maximum held-out date but cannot approve
or modify a production acceptance file.

## Metrics and Decision

The output reports, separately for the current official estimator and the
RealPing challenger:

- eligible held-out case count;
- estimated case count;
- coverage;
- median absolute percentage error;
- P75 absolute percentage error;
- high-, medium-, and low-confidence case counts; and
- unestimated reason counts.

It also reports paired deltas on cases estimated by both systems. The challenger
passes only when:

```text
challenger median APE < official median APE
AND challenger P75 APE < official P75 APE
AND challenger coverage >= official coverage
```

Equality is not an accuracy improvement. The report labels the outcome
`pass`, `fail`, or `inconclusive`. Contract errors, insufficient overlapping
cases, or missing required confidence slices produce `inconclusive`, never
`pass`.

Passing the benchmark is evidence for a later design discussion; it does not
automatically change production behavior or authorize removal of official
evidence.

## Output and Privacy

The aggregate report is written under:

```text
state/market-data/backtests/taipei/realping/
```

It contains configuration, provider freshness, response checksums, aggregate
metrics, gate results, and aggregate failure reasons. It does not contain
addresses, transaction rows, listing details, API responses, or case-level
predictions.

Console output is an aggregate summary only. The API key is never printed,
stored in cache, serialized into errors, or included in test fixtures.

## Testing

Tests use injected HTTP dependencies and synthetic records; the automated test
suite never calls RealPing.

Coverage includes:

- API key and request-header handling without secret leakage;
- pagination and bounded transient retry;
- 401/403, 429, 5xx, timeout, and malformed JSON behavior;
- live-contract validation and schema fingerprinting;
- exact mapping to `RealPingComparable`;
- rejection of ambiguous price basis, address, age, quality, and parking
  records;
- deterministic local keys, exact deduplication, and collision rejection;
- cutoff enforcement and exclusion of the complete held-out date;
- absence of synthetic floor evidence and floor weights;
- age-at-held-out-date adjustment for midrise/highrise candidates;
- identical evaluation denominators;
- metric and gate calculations;
- cache invalidation after schema drift; and
- aggregate report redaction.

A manual smoke command with a real key is required before interpreting benchmark
results.

## Documentation and Credential Setup

`.env.example` documents:

```dotenv
REALPING_API_KEY=
```

The real key remains only in `.env` or the process environment. Project
documentation explains how to obtain a free key from
`https://realping.tw/developers`, how to run the standalone benchmark, how to
interpret `pass`/`fail`/`inconclusive`, and why no production change occurs
automatically.
