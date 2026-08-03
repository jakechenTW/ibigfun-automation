# Multi-Use and Parking Scenario Valuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add separately backtested official-use valuation scenarios and graded parking imputation, then activate them for daily reports only after residential and new-cohort quality gates pass.

**Architecture:** Extend official transaction normalization with exact primary-use and parking-evidence dimensions while retaining the existing residential estimator as the production baseline during development. Build a causal parking model from direct grade-A records, use it to create lower-weight grade-B evidence, calculate exact-use scenarios without cross-use blending, and persist aggregate cohort acceptance. Daily enrichment receives scenario evidence in parallel first; report rules switch only after a full candidate build proves the residential baseline does not regress.

**Tech Stack:** TypeScript 5.6, Node.js 22 test runner, `tsx`, local Ministry of the Interior CSVs, existing geospatial grid/doorplate index, deterministic weighted statistics, Markdown reports.

## Global Constraints

- Never infer registered or market use from listing titles or descriptions.
- Keep official primary-use cohorts separate; do not pool sparse cohorts.
- Only direct grade-A parking records may train parking imputation.
- Grade B uses causal, prior-date-only imputation and a capped comparable weight; grade C never enters building-only unit-price quantiles.
- Preserve the current residential median APE `<= 12%`, P75 APE `<= 20%`, estimate coverage `>= 70%`, and confidence-ordering gate.
- Keep raw transactions, per-case backtests, addresses, and generated reports under git-ignored `state/`; committed fixtures must be synthetic.
- The official link is `https://lvr.land.moi.gov.tw/`; never describe it as a permanent per-transaction deep link.
- Do not make the new scenario result authoritative until the full candidate/update gate passes and the schema/policy bump is published atomically.
- Execute Tasks 1–7 in an isolated worktree created with `superpowers:using-git-worktrees`; the current main worktree must remain usable by the daily job until activation passes.

---

## File Structure

- `scripts/lib/market-data/types.ts` — shared use, parking, scenario, backtest, and acceptance contracts.
- `scripts/lib/market-data/transactions.ts` — pure official field normalization and A/B/C parking classification.
- `scripts/lib/market-data/parking.ts` — causal parking selection, imputation, and paired bundle distributions.
- `scripts/lib/market-data/selector.ts` — exact-use, grade-aware comparable selection.
- `scripts/lib/market-data/estimator.ts` — retain the production residential baseline and expose reusable weighted building observations.
- `scripts/lib/market-data/scenario-estimator.ts` — multi-use scenario orchestration and bundle cross-checks.
- `scripts/lib/market-data/backtest.ts` — use/parking cohorts, masked-parking evaluation, and activation gates.
- `scripts/lib/market-data/update.ts` — causal grade-B augmentation and candidate build diagnostics.
- `scripts/lib/market-data/store.ts` — schema/acceptance validation and atomic persistence.
- `scripts/lib/market-data/evidence.ts` — official query URL and comparable locator fields.
- `scripts/lib/steps.ts` — listing parking-family mapping and scenario attachment.
- `scripts/lib/types.ts` — enriched-listing scenario field.
- `docs/reporting-rules.md`, `profiles/*/evaluation.md`, `profiles/*/notify-template.md`, and `AGENTS.md` — authoritative report and run semantics.

---

### Task 1: Normalize Official Use and Parking Evidence Without Changing the Daily Authority

**Files:**
- Modify: `scripts/lib/market-data/types.ts`
- Modify: `scripts/lib/market-data/transactions.ts`
- Modify: `scripts/lib/market-data/transactions.test.ts`
- Modify: `scripts/lib/market-data/fixtures/transactions.csv`

**Interfaces:**
- Produces: `NormalizedPrimaryUse`, `ParkingFamily`, `ParkingGrade`, `ParkingEvidence`, `normalizePrimaryUse(raw: string)`, `normalizeParkingFamily(raw: string)`, and `classifyParkingEvidence(input: RawParkingEvidence): ParkingEvidence`.
- Preserves: existing `eligibility` behavior for the legacy production selector; non-residential and incomplete-parking records are retained as `review-only`, not made legacy `reliable-eligible`.
- Changes: add `MarketTransaction.totalAreaPing`; make `parkingPriceNtd`, `parkingAreaPing`, `buildingPriceNtd`, `buildingAreaPing`, and `buildingUnitPriceWan` `number | null` for grade-C and not-yet-imputed grade-B records. Change `TransactionEligibilityEvidence.transferredBuildingCount` to `number | null` so malformed counts remain explicit review evidence.

- [ ] **Step 1: Write failing primary-use normalization tests**

Add table-driven cases to `transactions.test.ts`:

```ts
for (const [raw, expected] of [
  ['住家用', 'residential'],
  ['住商用', 'mixed-residential'],
  ['辦公用', 'office'],
  ['商業用', 'commercial'],
  ['工業用', 'industrial'],
  ['住工用', 'mixed-industrial'],
  ['', 'unknown'],
] as const) {
  test(`normalizes official primary use ${raw || 'blank'}`, () => {
    assert.equal(normalizePrimaryUse(raw), expected);
  });
}
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --import tsx --test scripts/lib/market-data/transactions.test.ts`

Expected: FAIL because `normalizePrimaryUse` is not exported.

- [ ] **Step 3: Add the exact-use and parking contracts**

Add to `types.ts`:

```ts
export type NormalizedPrimaryUse =
  | 'residential'
  | 'mixed-residential'
  | 'office'
  | 'commercial'
  | 'industrial'
  | 'mixed-industrial'
  | 'unknown';

export type ParkingFamily = 'flat' | 'mechanical' | 'none' | 'unknown';
export type ParkingGrade = 'A' | 'B' | 'C';

export interface ParkingImputationEvidence {
  asOf: string;
  stage: 'same-building' | 'nearby-500m';
  comparableIds: string[];
  comparableCount: number;
  priceP25Ntd: number;
  priceP50Ntd: number;
  priceP75Ntd: number;
  areaP25Ping: number;
  areaP50Ping: number;
  areaP75Ping: number;
}

export interface ParkingEvidence {
  grade: ParkingGrade;
  family: ParkingFamily;
  originalType: string;
  officialPriceNtd: number | null;
  officialAreaPing: number | null;
  imputation: ParkingImputationEvidence | null;
  reasons: string[];
}

export interface RawParkingEvidence {
  originalType: string;
  areaSqM: number | null;
  priceNtd: number | null;
  areaWasZeroOrEmpty: boolean;
  priceWasZeroOrEmpty: boolean;
  totalAreaSqM: number;
  totalPriceNtd: number;
}

export interface BundleValueQuantiles {
  p25Ntd: number;
  p50Ntd: number;
  p75Ntd: number;
  observationCount: number;
}
```

Change `MarketTransaction.primaryUse` to `NormalizedPrimaryUse`, retain
`originalPrimaryUse`, add `totalAreaPing` and `parkingEvidence`, and make the
parking and building-only values listed in the task interface nullable.

- [ ] **Step 4: Implement exact use and parking-family normalization**

Add pure exported functions to `transactions.ts`:

```ts
export function normalizePrimaryUse(raw: string): NormalizedPrimaryUse {
  switch (raw.normalize('NFKC').replace(/\s+/gu, '')) {
    case '住家用': return 'residential';
    case '住商用': return 'mixed-residential';
    case '辦公用': return 'office';
    case '商業用': return 'commercial';
    case '工業用': return 'industrial';
    case '住工用': return 'mixed-industrial';
    default: return 'unknown';
  }
}

export function normalizeParkingFamily(raw: string): ParkingFamily {
  const value = raw.normalize('NFKC').replace(/\s+/gu, '');
  if (value === '' || value === '無車位') return 'none';
  if (value.includes('平面')) return 'flat';
  if (value.includes('機械')) return 'mechanical';
  return 'unknown';
}
```

- [ ] **Step 5: Write failing A/B/C classification tests**

Cover these exact rows:

```ts
const parkingCases = [
  { patch: { '車位類別': '無車位', '車位移轉總面積平方公尺': '0', '車位總價元': '0' }, grade: 'A' },
  { patch: { '車位類別': '坡道平面', '車位移轉總面積平方公尺': '20', '車位總價元': '3000000' }, grade: 'A' },
  { patch: { '車位類別': '坡道平面', '車位移轉總面積平方公尺': '', '車位總價元': '3000000' }, grade: 'B' },
  { patch: { '車位類別': '坡道平面', '車位移轉總面積平方公尺': '20', '車位總價元': '' }, grade: 'B' },
  { patch: { '車位類別': '坡道平面', '車位移轉總面積平方公尺': '', '車位總價元': '' }, grade: 'B' },
  { patch: { '車位類別': '', '車位移轉總面積平方公尺': '20', '車位總價元': '' }, grade: 'C' },
  { patch: { '車位類別': '無車位', '車位移轉總面積平方公尺': '20', '車位總價元': '3000000' }, grade: 'C' },
] as const;
```

Assert the row is retained, its `parkingEvidence.grade` matches, and only grade
A has direct building-only values.

- [ ] **Step 6: Run the focused test and verify failure**

Run: `node --import tsx --test scripts/lib/market-data/transactions.test.ts`

Expected: FAIL because incomplete parking still returns `parking-not-separable`.

- [ ] **Step 7: Retain non-residential and A/B/C transactions**

Refactor `classifyTransactionEligibility` so single-building, known-use records
carry exact use evidence while legacy eligibility remains:

```ts
const normalizedUse = normalizePrimaryUse(primaryUseRaw);
const legacyReliable = normalizedUse === 'residential' && count === 1;
return {
  eligibility: legacyReliable ? 'reliable-eligible' : 'review-only',
  reasons: legacyReliable ? [] : [
    ...(normalizedUse === 'unknown' ? ['primary-use-unavailable'] : ['scenario-only-primary-use']),
    ...(count !== 1 ? ['multiple-buildings'] : []),
  ],
  primaryUse: normalizedUse,
  transferredBuildingCount: count,
};
```

Implement parking classification with these invariants:

- grade A no-parking yields zero parking and direct building values;
- grade A parking subtracts official price/area and checks the 5% official unit-price tolerance;
- grade B retains official totals, leaves unavailable building-only values null,
  and records which component is missing;
- grade C retains official totals, leaves building-only values null, and records
  contradictory/unknown-family reasons;
- invalid total price/area remains excluded.

- [ ] **Step 8: Run normalization tests**

Run: `node --import tsx --test scripts/lib/market-data/transactions.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the normalization slice**

```bash
git add scripts/lib/market-data/types.ts scripts/lib/market-data/transactions.ts scripts/lib/market-data/transactions.test.ts scripts/lib/market-data/fixtures/transactions.csv
git commit -m "feat: retain multi-use parking evidence"
```

---

### Task 2: Build the Direct-Only Causal Parking Model

**Files:**
- Create: `scripts/lib/market-data/parking.ts`
- Create: `scripts/lib/market-data/parking.test.ts`
- Modify: `scripts/lib/market-data/config.ts`

**Interfaces:**
- Consumes: grade-A `MarketTransaction` records with direct positive parking pairs.
- Produces: `estimateParking(subject, candidates, asOf) -> ParkingEstimate | null`.
- Produces: `bundleValueQuantiles(totalAreaPing, buildingObservations, parkingPairs) -> BundleValueQuantiles | null`.
- Guarantees: candidates on the subject date or later are excluded; grade B/C never train the model.

- [ ] **Step 1: Write failing causal-selection tests**

Create `parking.test.ts` with synthetic grade-A records and assert:

```ts
const result = estimateParking({
  coordinate: { lat: 25.033, lng: 121.565 },
  matchedAddress: '台北市信義區測試路1號',
  buildingType: 'highrise',
  family: 'flat',
}, transactions, '2026-01-15');

assert.equal(result?.stage, 'same-building');
assert.deepEqual(result?.comparableIds, ['old-a', 'old-b', 'old-c']);
assert.ok(!result?.comparableIds.includes('same-date'));
assert.ok(!result?.comparableIds.includes('grade-b'));
assert.ok(!result?.comparableIds.includes('mechanical'));
```

Add a second case that falls back to same-building-type, same-family records
within 500 meters and returns null with fewer than three direct records.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --import tsx --test scripts/lib/market-data/parking.test.ts`

Expected: FAIL because `parking.ts` does not exist.

- [ ] **Step 3: Add explicit parking policy constants**

Add to `config.ts`:

```ts
export const PARKING_POLICY = {
  minimumDirectComparables: 3,
  nearbyRadiusM: 500,
  maximumAgeMonths: 36,
  imputedComparableWeightCap: 0.60,
  maximumPriceIqrRatio: 0.50,
  maximumAreaIqrRatio: 0.35,
} as const;
```

- [ ] **Step 4: Implement deterministic parking selection and quantiles**

Define in `parking.ts`:

```ts
export interface ParkingSubject {
  coordinate: Coordinate;
  matchedAddress: string | null;
  buildingType: BuildingType;
  family: Exclude<ParkingFamily, 'none' | 'unknown'>;
}

export interface ParkingEstimate extends ParkingImputationEvidence {
  family: 'flat' | 'mechanical';
  directPairs: Array<{ id: string; priceNtd: number; areaPing: number; weight: number }>;
}
```

Reuse `haversineMeters` and `weightedQuantile`. Exact-address selection wins
only with at least three records. Otherwise select same building type/family
within 500 meters and 36 months. Use existing distance/time bands and location
precision; sort ids before quantiles so output is stable.

- [ ] **Step 5: Write failing paired-bundle tests**

Assert bundle quantiles are calculated from valid parking pairs, not independent
price/area extremes:

```ts
const bundle = bundleValueQuantiles(40, [
  { id: 'u1', unitPriceWan: 80, weight: 1 },
  { id: 'u2', unitPriceWan: 100, weight: 1 },
], [
  { id: 'p1', priceNtd: 2_000_000, areaPing: 10, weight: 1 },
  { id: 'p2', priceNtd: 3_000_000, areaPing: 12, weight: 1 },
]);

assert.ok(bundle);
assert.ok(bundle.p25Ntd <= bundle.p50Ntd);
assert.ok(bundle.p50Ntd <= bundle.p75Ntd);
assert.equal(bundle.observationCount, 4);
```

- [ ] **Step 6: Implement paired Cartesian observations**

For every building observation and valid parking pair calculate:

```ts
const netAreaPing = totalAreaPing - pair.areaPing;
const valueNtd = netAreaPing * building.unitPriceWan * 10_000 + pair.priceNtd;
const weight = building.weight * pair.weight;
```

Discard non-positive net area/value/weight, then use weighted P25/P50/P75. Cap
the combination count deterministically by taking the 50 highest-weight records
from each side, ordered by weight descending then id ascending.

- [ ] **Step 7: Run parking tests**

Run: `node --import tsx --test scripts/lib/market-data/parking.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the parking model**

```bash
git add scripts/lib/market-data/config.ts scripts/lib/market-data/parking.ts scripts/lib/market-data/parking.test.ts
git commit -m "feat: add causal parking estimator"
```

---

### Task 3: Causally Augment Grade-B Transactions and Persist Diagnostics

**Files:**
- Modify: `scripts/lib/market-data/update.ts`
- Modify: `scripts/lib/market-data/update.test.ts`
- Modify: `scripts/lib/market-data/types.ts`
- Modify: `scripts/lib/market-data/store.ts`
- Modify: `scripts/lib/market-data/store.test.ts`

**Interfaces:**
- Consumes: all normalized transaction records from Task 1 and `estimateParking` from Task 2.
- Produces: `augmentParkingEvidenceCausally(transactions) -> MarketTransaction[]`.
- Produces: diagnostics keyed by use and parking grade.
- Invariant: a grade-B record dated `D` uses only grade-A records dated before `D`.

- [ ] **Step 1: Write a failing no-leakage augmentation test**

In `update.test.ts`, construct date groups with two prior grade-A pairs, one
same-date grade-A pair, one future pair, and one grade-B transaction. Assert the
grade-B record remains without imputation when only two prior pairs exist. Add
a third prior pair and assert its `imputation.comparableIds` excludes same-date
and future ids.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --import tsx --test scripts/lib/market-data/update.test.ts`

Expected: FAIL because `augmentParkingEvidenceCausally` is not exported.

- [ ] **Step 3: Implement chronological augmentation**

Export this shape from `update.ts`:

```ts
export function augmentParkingEvidenceCausally(
  transactions: readonly MarketTransaction[],
): MarketTransaction[];
```

Sort by transaction date then id. Process all records sharing one date as a
group. For each grade-B record, call `estimateParking(..., transactionDate)`
against only the previously accumulated grade-A records. If accepted, set:

```ts
{
  parkingEvidence: { ...parkingEvidence, imputation },
  parkingPriceNtd: imputation.priceP50Ntd,
  parkingAreaPing: imputation.areaP50Ping,
  buildingPriceNtd: totalPriceNtd - imputation.priceP50Ntd,
  buildingAreaPing: totalAreaPing - imputation.areaP50Ping,
  buildingUnitPriceWan:
    (totalPriceNtd - imputation.priceP50Ntd)
      / (totalAreaPing - imputation.areaP50Ping) / 10_000,
}
```

Reject the imputation when derived price/area is non-positive or either IQR
ratio exceeds `PARKING_POLICY`. Add current-date grade-A records to training
only after every current-date B record is processed.

- [ ] **Step 4: Replace one-pass cell insertion with collect/augment/index**

Change `addTransactionCsv` to append normalized transactions to an array rather
than final cells. After every season is parsed, call causal augmentation, then
insert records into grid cells and sort deterministically. Preserve exclusion
counts from parsing and add aggregate diagnostics:

```ts
byPrimaryUse: Record<NormalizedPrimaryUse, number>;
byParkingGrade: Record<ParkingGrade, number>;
gradeBImputed: number;
gradeBUnresolved: number;
```

- [ ] **Step 5: Write failing manifest validation tests**

In `store.test.ts`, assert validation rejects diagnostics when:

- use counts do not sum to retained records;
- parking grades do not sum to retained records;
- `gradeBImputed + gradeBUnresolved` does not equal the grade-B count; or
- keys are missing or not in stable order.

- [ ] **Step 6: Implement diagnostics validation**

Extend `validateTransactionBuildDiagnostics` to validate exact keys from the
union types and all count equalities. Do not include addresses or ids in the
manifest.

- [ ] **Step 7: Run update and store tests**

Run:

```bash
node --import tsx --test scripts/lib/market-data/update.test.ts
node --import tsx --test scripts/lib/market-data/store.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit causal persistence**

```bash
git add scripts/lib/market-data/update.ts scripts/lib/market-data/update.test.ts scripts/lib/market-data/types.ts scripts/lib/market-data/store.ts scripts/lib/market-data/store.test.ts
git commit -m "feat: persist graded parking evidence"
```

---

### Task 4: Add Exact-Use Scenario Selection and Estimation

**Files:**
- Create: `scripts/lib/market-data/scenario-estimator.ts`
- Create: `scripts/lib/market-data/scenario-estimator.test.ts`
- Modify: `scripts/lib/market-data/selector.ts`
- Modify: `scripts/lib/market-data/selector.test.ts`
- Modify: `scripts/lib/market-data/estimator.ts`
- Modify: `scripts/lib/market-data/estimator.test.ts`
- Modify: `scripts/lib/market-data/types.ts`

**Interfaces:**
- Produces: `selectScenarioComparables(subject, candidates, asOf, options)`.
- Produces: `estimateMarketScenarios(subject, index, freshness, asOf, acceptance)`.
- Preserves: `estimateMarket` as the authoritative legacy residential baseline until Task 7 activation.

- [ ] **Step 1: Add scenario result contracts**

Define in `types.ts`:

```ts
export interface SubjectUseEvidence {
  value: NormalizedPrimaryUse;
  source: 'official' | 'manual' | 'unknown';
  detail: string | null;
}

export interface UseScenarioEstimate {
  primaryUse: Exclude<NormalizedPrimaryUse, 'unknown'>;
  role: 'primary' | 'residential-comparison' | 'unknown-use-scenario';
  status: EstimateStatus | 'diagnostic-only' | 'insufficient-sample';
  confidence: EstimateConfidence;
  marketUnitPriceP25: number | null;
  marketUnitPriceMedian: number | null;
  marketUnitPriceP75: number | null;
  askingPremiumConservative: number | null;
  bundleValue: BundleValueQuantiles | null;
  parkingEstimate: ParkingImputationEvidence | null;
  gradeCounts: Record<ParkingGrade, number>;
  selectedStage: number | null;
  comparables: ComparableEvidence[];
  bundleComparables: ComparableEvidence[];
  reasons: string[];
}

export interface MarketScenarioEstimate {
  registeredUse: SubjectUseEvidence;
  parkingFamily: ParkingFamily;
  parkingCountAssumption: 0 | 1 | 2 | null;
  sourceFreshness: SourceFreshness;
  scenarios: UseScenarioEstimate[];
  reasons: string[];
}

export interface ScenarioMarketSubject {
  listingId: number | null;
  coordinate: Coordinate;
  matchedAddress: string | null;
  district: string;
  ownership: 'freehold' | 'non-freehold' | 'unknown';
  ownershipEvidence?: SubjectOwnershipEvidence;
  buildingType: BuildingType;
  totalAreaPing: number;
  askingTotalPriceNtd: number;
  floor: number;
  totalFloors: number;
  floorGroup: FloorGroup;
  ageYears: number | null;
  registeredUse: SubjectUseEvidence;
  parkingFamily: ParkingFamily;
  parkingCount: 0 | 1 | 2 | null;
}
```

- [ ] **Step 2: Write failing selector isolation tests**

Add `selector.test.ts` cases proving:

- a residential scenario never includes office/industrial transactions;
- grade A receives its normal weight;
- accepted grade B weight is `Math.min(baseWeight, 0.60)`;
- unresolved grade B and every grade C record are absent from building-only
  quantiles; and
- grade C is returned only by the bundle-evidence path.

- [ ] **Step 3: Run selector tests and verify failure**

Run: `node --import tsx --test scripts/lib/market-data/selector.test.ts`

Expected: FAIL because selector options do not include primary use or parking
grade.

- [ ] **Step 4: Implement exact-use grade-aware selection**

Add:

```ts
export interface ScenarioSelectionOptions {
  primaryUse: Exclude<NormalizedPrimaryUse, 'unknown'>;
  allowImputedParking: boolean;
  bundleOnly?: boolean;
}
```

The building-only hard gate requires exact `primaryUse`, grade A or an accepted
imputed grade B, exactly one transferred building, and positive non-null
building values. The bundle-only gate requires exact use, exactly one
transferred building, positive total price/area, and grade C. Keep all current
district, type, ownership, date, distance, area, age, and floor gates.

- [ ] **Step 5: Write failing scenario orchestration tests**

In `scenario-estimator.test.ts`, assert:

```ts
const unknown = estimateMarketScenarios(unknownUseSubject, index, freshness, '2026-01-31', acceptance);
assert.deepEqual(unknown.scenarios.map((scenario) => scenario.primaryUse), [
  'residential', 'mixed-residential', 'office', 'commercial', 'industrial', 'mixed-industrial',
]);
assert.ok(unknown.scenarios.every((scenario) => scenario.role === 'unknown-use-scenario'));

const verifiedOffice = estimateMarketScenarios(officeSubject, index, freshness, '2026-01-31', acceptance);
assert.deepEqual(verifiedOffice.scenarios.map((scenario) => [scenario.primaryUse, scenario.role]), [
  ['office', 'primary'],
  ['residential', 'residential-comparison'],
]);
```

Also assert insufficient cohorts remain visible with null quantiles and
`insufficient-sample`. Assert an unknown-use subject never receives a scenario
status above `review`, even when its exact-use cohort is acceptance-enabled.

- [ ] **Step 6: Implement scenario estimation**

For each requested use:

1. select exact-use grade A plus acceptance-enabled grade B;
2. apply existing weighted-MAD outlier filtering;
3. compute weighted unit-price P25/P50/P75;
4. estimate listing parking from grade-A candidates only;
5. calculate paired whole-property quantiles with `bundleValueQuantiles`;
6. retrieve grade-C bundle comparables separately and label their relationship
   `corroborates`, `conflicts`, or `insufficient`; and
7. downgrade to review when bundle median lies outside the scenario P25-P75
   interval with at least three grade-C observations.

Use a stable use order matching the test. Do not alter legacy `estimateMarket`.
Verified registered use plus an accepted cohort is required for `reliable`;
unknown-use scenarios remain at most `review` and support only the report's
conditional recommendation classification.

- [ ] **Step 7: Run scenario, selector, and legacy estimator tests**

Run:

```bash
node --import tsx --test scripts/lib/market-data/selector.test.ts
node --import tsx --test scripts/lib/market-data/estimator.test.ts
node --import tsx --test scripts/lib/market-data/scenario-estimator.test.ts
```

Expected: PASS, including every pre-existing legacy test.

- [ ] **Step 8: Commit scenario estimation**

```bash
git add scripts/lib/market-data/types.ts scripts/lib/market-data/selector.ts scripts/lib/market-data/selector.test.ts scripts/lib/market-data/estimator.ts scripts/lib/market-data/estimator.test.ts scripts/lib/market-data/scenario-estimator.ts scripts/lib/market-data/scenario-estimator.test.ts
git commit -m "feat: estimate exact-use market scenarios"
```

---

### Task 5: Attach Listing Parking Scenarios and Auditable Official Locators

**Files:**
- Create: `scripts/lib/market-data/evidence.ts`
- Create: `scripts/lib/market-data/evidence.test.ts`
- Modify: `scripts/lib/types.ts`
- Modify: `scripts/lib/steps.ts`
- Modify: `scripts/lib/market-data/integration.test.ts`

**Interfaces:**
- Produces: `listingParkingFamily(raw) -> ParkingFamily`.
- Produces: `officialComparableLocator(transaction) -> OfficialComparableLocator`.
- Adds: `EnrichedListing.marketScenarios: MarketScenarioEstimate` while retaining `marketEstimate` during the candidate phase.

- [ ] **Step 1: Write failing listing parking-family tests**

Add integration cases:

```ts
assert.equal(listingParkingFamily('平面'), 'flat');
assert.equal(listingParkingFamily('機械'), 'mechanical');
assert.equal(listingParkingFamily('無車位'), 'none');
assert.equal(listingParkingFamily(null), 'unknown');
```

Assert a listing with `平面` no longer receives only
`listing-parking-not-separable`; it receives a scenario result with
`parkingCountAssumption: 1` while the legacy estimate remains review during the
candidate phase. Add a no-parking case with assumption `0` and an unknown
parking-label case with assumption `null`, low confidence, and
`parking-family-unknown` evidence rather than an invented price.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --import tsx --test scripts/lib/market-data/integration.test.ts`

Expected: FAIL because `marketScenarios` and `listingParkingFamily` do not
exist.

- [ ] **Step 3: Implement subject construction and parallel attachment**

In `steps.ts`, retain the legacy `marketEstimate` call unchanged, then call
`estimateMarketScenarios` with:

```ts
{
  listingId: listing.id,
  coordinate: listing.coordinate,
  district: listing.district ?? '',
  ownership: ownership.ownership,
  ownershipEvidence: ownership.evidence,
  buildingType: listing.buildingType,
  totalAreaPing: listing.totalPingNum ?? Number.NaN,
  askingTotalPriceNtd: (listing.totalPriceWan ?? Number.NaN) * 10_000,
  floor,
  totalFloors,
  floorGroup: subjectFloorGroup,
  ageYears: listing.ageNum,
  registeredUse: { value: 'unknown', source: 'unknown', detail: null },
  parkingFamily: listingParkingFamily(listing.parking),
  parkingCount: listing.parking === '無車位' ? 0 : 1,
  matchedAddress: locationEvidence.address.matchedAddress,
}
```

`unknown` parking yields scenario reasons and no invented parking count.

- [ ] **Step 4: Write failing official-locator tests**

Create `evidence.test.ts` and assert the output contains:

```ts
assert.deepEqual(officialComparableLocator(transaction), {
  queryUrl: 'https://lvr.land.moi.gov.tw/',
  district: '信義區',
  addressOrRoad: transaction.originalAddress,
  transactionMonth: '2025-12',
  floor: transaction.floor,
  totalPriceNtd: transaction.totalPriceNtd,
  totalAreaPing: transaction.totalAreaPing,
});
```

Define the matching public contract in `evidence.ts`:

```ts
export interface OfficialComparableLocator {
  queryUrl: 'https://lvr.land.moi.gov.tw/';
  district: string;
  addressOrRoad: string;
  transactionMonth: string;
  floor: number;
  totalPriceNtd: number;
  totalAreaPing: number;
}
```

- [ ] **Step 5: Implement locator evidence**

Add `officialLocator` to displayed comparable evidence. Keep the original
address only in local enriched/report artifacts; do not add locators to
aggregate manifests or acceptance.

- [ ] **Step 6: Run integration and evidence tests**

Run:

```bash
node --import tsx --test scripts/lib/market-data/evidence.test.ts
node --import tsx --test scripts/lib/market-data/integration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit listing integration**

```bash
git add scripts/lib/types.ts scripts/lib/steps.ts scripts/lib/market-data/evidence.ts scripts/lib/market-data/evidence.test.ts scripts/lib/market-data/integration.test.ts
git commit -m "feat: attach listing valuation scenarios"
```

---

### Task 6: Backtest Use Cohorts and Parking Imputation, Then Persist Acceptance

**Files:**
- Modify: `scripts/lib/market-data/backtest.ts`
- Modify: `scripts/lib/market-data/backtest.test.ts`
- Modify: `scripts/lib/market-data/types.ts`
- Modify: `scripts/lib/market-data/config.ts`
- Modify: `scripts/lib/market-data/store.ts`
- Modify: `scripts/lib/market-data/store.test.ts`
- Modify: `scripts/lib/market-data/cli.test.ts`

**Interfaces:**
- Produces: `BacktestReport.byPrimaryUse`, `byParkingGrade`, `directOnly`, `directPlusImputed`, and `parkingMaskedHoldout` aggregate metrics.
- Produces: schema-3 `BacktestAcceptance` with per-use activation decisions and `parkingImputationAccepted`.
- Preserves: existing residential global gate as mandatory for any publication.

- [ ] **Step 1: Write failing cohort-report tests**

Add synthetic residential, office, and industrial grade-A cases plus grade-B
comparables. Assert `BacktestReport` contains all exact use keys, each cohort
count is independent, and per-case records never appear in the acceptance
artifact.

- [ ] **Step 2: Add explicit cohort gate configuration**

Add:

```ts
export const SCENARIO_BACKTEST_GATE = {
  minimumUseCohortCases: 20,
  medianApeMax: 0.12,
  p75ApeMax: 0.20,
  maximumAbsoluteBiasRegression: 0.01,
  maximumIntervalCoverageRegression: 0.05,
} as const;
```

- [ ] **Step 3: Implement exact-use held-out scenarios**

For each grade-A, single-building, known-use held-out transaction:

- set subject registered use to the transaction's exact use;
- use only strictly earlier transactions;
- score the exact-use primary scenario against the official direct building
  unit price; and
- aggregate by use, building type, confidence, and parking grade.

Run the estimator twice: direct-only and direct-plus-causally-imputed grade B.

- [ ] **Step 4: Implement masked-parking diagnostics**

For every grade-A transaction with parking, create a diagnostic copy with its
official parking price/area hidden. Estimate parking using only prior-date
grade-A records, then report aggregate price APE, area APE, and interval hits by
parking family. Never persist masked cases or ids in acceptance.

- [ ] **Step 5: Write failing acceptance decision tests**

Assert:

- residential gate failure blocks the whole candidate;
- a use cohort with 19 scored cases is `diagnostic-only`;
- a cohort with 20 cases and median/P75 within 12%/20% is accepted;
- grade B is rejected unless coverage strictly improves;
- grade B is rejected when bias worsens by more than one percentage point;
- grade B is rejected when interval coverage falls by more than five percentage
  points; and
- a non-residential failure does not invalidate a passing residential build.

- [ ] **Step 6: Implement schema-3 aggregate acceptance**

Persist:

```ts
interface ScenarioCohortAcceptance {
  status: 'accepted' | 'diagnostic-only' | 'failed';
  scoredCases: number;
  estimateCoverage: number;
  medianApe: number | null;
  p75Ape: number | null;
  bias: number | null;
  intervalCoverage: number | null;
  reasons: string[];
}

interface BacktestAcceptance {
  schemaVersion: 3;
  estimatorPolicyVersion: number;
  policyId: EstimatorPolicy['id'];
  transactionArtifactSha256: string;
  approvedAt: string;
  asOf: string;
  evaluatedThrough: string;
  latestEligibleTransactionDate: string;
  thresholds: {
    medianApeMax: number;
    p75ApeMax: number;
    minimumEstimateCoverage: number;
    minimumConfidenceSliceCases: number;
    minimumHighConfidenceImprovement: number;
    minimumUseCohortCases: number;
    maximumAbsoluteBiasRegression: number;
    maximumIntervalCoverageRegression: number;
  };
  metrics: {
    estimateCoverage: number;
    reliableEstimatedCount: number;
    reliableMedianApe: number;
    reliableP75Ape: number;
    highConfidenceEstimatedCount: number;
    highConfidenceMedianApe: number;
    mediumConfidenceEstimatedCount: number;
    mediumConfidenceMedianApe: number;
  };
  useCohorts: Record<Exclude<NormalizedPrimaryUse, 'unknown'>, ScenarioCohortAcceptance>;
  parkingImputationAccepted: boolean;
  parkingComparison: {
    directCoverage: number;
    imputedCoverage: number;
    directMedianApe: number | null;
    imputedMedianApe: number | null;
    directP75Ape: number | null;
    imputedP75Ape: number | null;
    biasRegression: number | null;
    intervalCoverageRegression: number | null;
  };
}
```

Validate every exact key, finite metric, checksum, policy id/version, as-of
coverage, threshold equality, and count. `marketDataBacktestAcceptanceDecision`
continues to require the residential global pass. Scenario estimation checks
the exact use cohort plus parking flag independently.

- [ ] **Step 7: Run backtest, store, and CLI tests**

Run:

```bash
node --import tsx --test scripts/lib/market-data/backtest.test.ts
node --import tsx --test scripts/lib/market-data/store.test.ts
node --import tsx --test scripts/lib/market-data/cli.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit cohort acceptance**

```bash
git add scripts/lib/market-data/backtest.ts scripts/lib/market-data/backtest.test.ts scripts/lib/market-data/types.ts scripts/lib/market-data/config.ts scripts/lib/market-data/store.ts scripts/lib/market-data/store.test.ts scripts/lib/market-data/cli.test.ts
git commit -m "feat: gate use and parking cohorts"
```

---

### Task 7: Run the Candidate Gate and Activate the New Schema Only on Pass

**Files:**
- Modify: `scripts/lib/market-data/config.ts`
- Modify: `scripts/lib/market-data/store.ts`
- Modify: `scripts/lib/market-data/store.test.ts`
- Modify: `scripts/lib/market-data/update.test.ts`
- Modify: `scripts/lib/steps.ts`
- Modify: `scripts/lib/market-data/integration.test.ts`

**Interfaces:**
- Changes on successful gate only: `MARKET_SCHEMA_VERSION` from `3` to `4` and `ESTIMATOR_POLICY_VERSION` from `4` to `5`.
- Makes: `marketScenarios` authoritative for report evaluation while retaining legacy `marketEstimate` as a labeled compatibility field for one release.

- [ ] **Step 1: Run the complete unit test suite before candidate data work**

Run: `npm test`

Expected: PASS with zero failures.

- [ ] **Step 2: Build the baseline candidate without retaining raw stdout**

Run interactively:

```bash
npm run market-data -- candidate --city taipei --policy baseline
```

Inspect only the terminal aggregate summary and gate result. Do not redirect or
copy full stdout because it may contain cases and addresses.

Expected activation prerequisites:

- residential global gate passes;
- direct-plus-imputed residential coverage exceeds direct-only coverage;
- grade-B comparison passes bias and interval-regression limits; and
- at least one non-residential cohort is either accepted or explicitly
  diagnostic-only with aggregate reasons.

- [ ] **Step 3: Stop safely if shared gates fail**

If the residential or parking shared gate fails, leave daily authority on the
legacy estimator, preserve only aggregate diagnostics under
`state/market-data/backtests/taipei/`, and do not change schema/policy constants.
Record the failed aggregate reason in the implementation handoff. This is a
complete candidate-phase outcome, not authorization to weaken thresholds.

- [ ] **Step 4: Write failing schema-4/policy-5 tests after a passing candidate**

Update tests to expect:

```ts
assert.equal(MARKET_SCHEMA_VERSION, 4);
assert.equal(ESTIMATOR_POLICY_VERSION, 5);
assert.equal(acceptance.schemaVersion, 3);
```

Assert schema-3 market builds and schema-2 acceptance are rejected with the
existing `run update first` policy-provenance error in current-load mode. In
publication-recovery mode, permit checksum-valid schema 1, 2, 3, or 4 builds so
an interrupted schema-4 promotion can still restore its schema-3 predecessor.

- [ ] **Step 5: Activate constants and production authority**

Only after Step 2 passes, bump the constants, update store validation, and make
daily report evaluation consume `marketScenarios`. Keep `marketEstimate` in
`enriched.json` with `unavailableReasons` including
`legacy-residential-baseline-not-authoritative` whenever listing use is unknown
or parking is imputed, preventing accidental legacy recommendations.

- [ ] **Step 6: Rebuild and atomically publish the active pair**

Run:

```bash
npm run market-data -- update --city taipei
```

Expected: full semantic rebuild, passing gate, atomic publication of schema-4
index plus schema-3 acceptance, and no fallback to a mismatched old pair.

- [ ] **Step 7: Verify production backtest and tests**

Run:

```bash
npm run market-data -- backtest --city taipei
npm test
```

Do not retain backtest stdout. Expected: gated backtest PASS and unit suite PASS.

- [ ] **Step 8: Commit activation**

```bash
git add scripts/lib/market-data/config.ts scripts/lib/market-data/store.ts scripts/lib/market-data/store.test.ts scripts/lib/market-data/update.test.ts scripts/lib/steps.ts scripts/lib/market-data/integration.test.ts
git commit -m "feat: activate scenario valuation policy"
```

---

### Task 8: Update Report Rules, Templates, and Operational Documentation

**Files:**
- Modify: `docs/reporting-rules.md`
- Modify: `profiles/example-investment/evaluation.md`
- Modify: `profiles/example-investment/notify-template.md`
- Modify: `profiles/example-owner-occupied/evaluation.md`
- Modify: `profiles/example-owner-occupied/notify-template.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `EnrichedListing.marketScenarios` and official locator evidence.
- Produces: deterministic instructions for conditional recommendations,
  use-confirmation candidates, A/B/C disclosure, and clickable official query
  links.

- [ ] **Step 1: Replace the single-estimate reporting rule**

Document this exact decision order in `docs/reporting-rules.md`:

```text
verified use:
  same-use accepted scenario controls; residential is comparison-only

unknown use:
  conditional recommendation only when at least two accepted scenarios,
  including residential, all pass the profile P25 gate and no diagnostic
  scenario conflicts

  mixed pass/fail/insufficient -> 用途待確認候選
  every supported scenario fails -> 不推薦
  no supported scenario or bundle conflict -> 人工複核
```

State that title prose never verifies use and that the official URL opens the
query service, not the exact row.

- [ ] **Step 2: Add the scenario table to both templates**

Use these columns:

```markdown
| 登記用途情境 | 建物單價 P25／P50／P75 | 含車位總價 P25／P50／P75 | A／B／C 筆數 | 狀態 | 判斷 |
|---|---:|---:|---:|---|---|
```

Below the table list at most the most influential comparables per scenario with
transaction month, road/address range, floor, area, total price, parking
evidence, distance, imputation label, and `[內政部查詢](https://lvr.land.moi.gov.tw/)`.

- [ ] **Step 3: Update profile gates**

For investment, apply the existing conservative premium threshold separately
to every acceptance-enabled scenario's P25. For owner-occupied, prevent
`符合條件` when use is unknown unless the conditional-recommendation rule passes;
otherwise place it in `候選/需確認` with legal-use, lending, tax, and resale-risk
confirmation items.

- [ ] **Step 4: Update the runbook source-of-truth description**

In `AGENTS.md`, replace the residential-only parking-separable statement with:

- exact-use scenario evidence;
- A/B/C parking grades;
- conditional unknown-use recommendation semantics;
- per-cohort acceptance; and
- official-query locator links.

Keep all existing notification status, state privacy, and raw-backtest stdout
rules unchanged.

- [ ] **Step 5: Verify documentation consistency**

Run:

```bash
rg -n "listing-parking-not-separable|inseparable parking|車位.*不可分|住家用.*only|住宅.*唯一" AGENTS.md docs profiles
git diff --check
```

Expected: remaining matches refer only to historical/legacy behavior or explain
graded evidence; no active instruction says every parking listing is
unavailable.

- [ ] **Step 6: Run the full verification suite**

Run:

```bash
npm test
npm run pipeline -- status --profile example-investment --date 2026-08-02
```

Expected: tests PASS; status is read-only and prints a valid run state or a
clear not-yet-created status without changing external systems.

- [ ] **Step 7: Commit documentation**

```bash
git add AGENTS.md docs/reporting-rules.md profiles/example-investment/evaluation.md profiles/example-investment/notify-template.md profiles/example-owner-occupied/evaluation.md profiles/example-owner-occupied/notify-template.md
git commit -m "docs: explain scenario valuation reports"
```

---

## Final Verification and Handoff

- [ ] Confirm `git status --short` contains no unintended files.
- [ ] Run `npm test` and record only the aggregate pass/fail summary.
- [ ] Run the active gated backtest only if Task 7 activated schema 4; do not
  retain raw stdout.
- [ ] Inspect one local enriched listing with no parking and one with flat
  parking; verify scenario separation, parking provenance, grade counts, and
  official locator fields without copying addresses into committed artifacts.
- [ ] Confirm a listing title containing `工業宅` does not change
  `registeredUse.value` from `unknown`.
- [ ] Confirm unknown-use recommendations follow the two-scenario minimum and
  never use a residential comparison as an unconditional recommendation.
- [ ] Confirm a failed non-residential cohort remains diagnostic-only while a
  passing residential cohort remains usable.
