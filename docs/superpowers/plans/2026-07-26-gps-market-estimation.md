# GPS-Based Market Estimation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible Taipei market-price baseline from official doorplate and real-price transaction data, attach auditable estimates to enriched iBigFun listings, and reserve agent lookups for uncertain or boundary cases.

**Architecture:** A versioned local updater downloads official sources into `state/market-data/taipei`, builds address and transaction grid indexes, and publishes them atomically. The deterministic estimator consumes reliable listing GPS plus server-side building-type provenance, selects and weights comparables, and emits a median, P25–P75 interval, conservative premium, confidence, and full evidence. The existing report agent consumes this result and records any external valuation override separately.

**Tech Stack:** Node.js 22, TypeScript/ESM, `tsx`, Node test runner, `csv-parse`, `proj4`, `unzipper`, Node `fetch`/filesystem/crypto.

## Global Constraints

- Initial market-data coverage is Taipei City only.
- Use Taipei City's monthly doorplate open data as the required offline geocoder; do not require Google, Mapbox, Nominatim, or TGOS.
- Keep raw official data, derived indexes, manifests, and run review evidence under git-ignored `state/`.
- Do not infer listing building type from title or `pattern`; split iBigFun fetches by `house_type=16` and `17` and preserve query provenance.
- Classify `16` as apartment; classify `17` as midrise at 10 total floors or fewer and highrise at 11 floors or more.
- First comparable search uses 300 m, 12 months, ±20% area, same floor group, and—except apartments—±10 years.
- Relax in this order: 500 m; 36 months; ±30% area/±15 years/adjacent floor group; 800 m.
- Never relax district, building type, ownership class, valid building-only unit price, 36-month maximum age, or coordinate reliability.
- Apartment age never gates or weights comparability.
- Distance weights are `1.0`, `0.75`, `0.5`; time weights are `1.0`, `0.7`, `0.4`.
- Address-range precision weight is `max(0.5, 1 / (1 + uncertaintyMeters / 400))`.
- Relaxation factors are area `0.85`, building age `0.85`, adjacent floor group `0.7`.
- Recommend only when P25-based conservative premium qualifies and the estimate is fresh and reliable.
- Tests must never require network access or real local market data.
- Use TDD for every behavioral change and keep commits scoped to one task.

---

## File Structure

Create a focused `scripts/lib/market-data/` module:

- `types.ts` — shared market-data contracts.
- `config.ts` — version numbers, paths, thresholds, stages, and weights.
- `address.ts` — Taiwan address normalization and masked number parsing.
- `projection.ts` — TWD97 to WGS84 conversion.
- `grid.ts` — deterministic spatial cell keys and neighboring-cell enumeration.
- `doorplates.ts` — doorplate CSV mapping, index construction, forward lookup, and nearest lookup.
- `property.ts` — building-type and floor-group normalization.
- `transactions.ts` — official transaction parsing, parking normalization, and explicit special-case filtering.
- `statistics.ts` — weighted quantiles and weighted MAD.
- `selector.ts` — staged comparable gates and weight breakdowns.
- `estimator.ts` — estimate status, confidence, interval, and premium.
- `sources.ts` — official source discovery, conditional downloads, quarter enumeration, and ZIP extraction.
- `store.ts` — manifests, sharded/indexed JSON persistence, freshness, staging, and atomic publication.
- `update.ts` — orchestration for source refresh and index builds.
- `backtest.ts` — leakage-free held-out transaction evaluation.

Create `scripts/market-data.ts` as the update/backtest CLI. Keep daily integration in `scripts/lib/steps.ts`, listing provenance in existing fetch/map/types modules, and agent/report policy in existing docs and templates.

---

### Task 1: Add Market-Data Dependencies and Domain Contracts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/lib/market-data/types.ts`
- Create: `scripts/lib/market-data/config.ts`
- Create: `scripts/lib/market-data/config.test.ts`

**Interfaces:**
- Produces: `BuildingType`, `FloorGroup`, `LocationEvidence`, `MarketSubject`, `MarketTransaction`, `MarketEstimate`, `MarketDataManifest`, `TransactionIndex`, `DoorplateIndex`.
- Produces: centralized constants `MARKET_SCHEMA_VERSION`, `SEARCH_STAGES`, `WEIGHTS`, `TRANSACTION_STALE_DAYS`, `DOORPLATE_STALE_DAYS`.

- [ ] **Step 1: Install the runtime parsing/projection dependencies**

Run:

```bash
npm install csv-parse proj4 unzipper
npm install --save-dev @types/unzipper
```

Expected: `package.json` contains the three runtime dependencies and `package-lock.json` resolves them.

- [ ] **Step 2: Make the test script discover market-data tests**

Change `package.json`:

```json
"test": "node --import tsx --test scripts/lib/*.test.ts scripts/lib/market-data/*.test.ts"
```

- [ ] **Step 3: Write the failing config contract test**

Create `scripts/lib/market-data/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_STAGES, WEIGHTS, TRANSACTION_STALE_DAYS, DOORPLATE_STALE_DAYS,
} from './config.ts';

test('search stages relax in the approved order', () => {
  assert.deepEqual(SEARCH_STAGES.map((s) => [s.radiusM, s.months, s.areaTolerance]), [
    [300, 12, 0.20],
    [500, 12, 0.20],
    [500, 36, 0.20],
    [500, 36, 0.30],
    [800, 36, 0.30],
  ]);
  assert.equal(SEARCH_STAGES[3].allowAdjacentFloor, true);
});

test('approved weights and stale windows are centralized', () => {
  assert.deepEqual(WEIGHTS.distance, [1, 0.75, 0.5]);
  assert.deepEqual(WEIGHTS.time, [1, 0.7, 0.4]);
  assert.equal(WEIGHTS.relaxedArea, 0.85);
  assert.equal(WEIGHTS.relaxedAge, 0.85);
  assert.equal(WEIGHTS.adjacentFloor, 0.7);
  assert.equal(TRANSACTION_STALE_DAYS, 30);
  assert.equal(DOORPLATE_STALE_DAYS, 60);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run:

```bash
node --import tsx --test scripts/lib/market-data/config.test.ts
```

Expected: FAIL because `config.ts` does not exist.

- [ ] **Step 5: Add the contracts and constants**

In `types.ts`, define the stable public contracts:

```ts
import type { Coordinate } from '../coords.ts';

export type BuildingType = 'apartment' | 'midrise' | 'highrise';
export type FloorGroup = 'first' | 'low' | 'middle' | 'top' | 'high';
export type LocationMethod = 'exact-doorplate' | 'address-range' | 'nearest-doorplate' | 'unresolved';
export type EstimateStatus = 'reliable' | 'review' | 'unavailable';
export type EstimateConfidence = 'high' | 'medium' | 'low';

export interface LocationEvidence {
  method: LocationMethod;
  coordinate: Coordinate | null;
  normalizedAddress: string;
  matchedAddress: string | null;
  uncertaintyMeters: number | null;
  confidence: EstimateConfidence;
  datasetVersion: string;
}

export interface WeightBreakdown {
  distance: number;
  time: number;
  locationPrecision: number;
  area: number;
  buildingAge: number;
  floor: number;
  total: number;
}

export interface MarketTransaction {
  id: string;
  transactionDate: string;
  sourceVersion: string;
  originalAddress: string;
  location: LocationEvidence;
  district: string;
  ownership: 'freehold' | 'non-freehold' | 'unknown';
  buildingType: BuildingType;
  totalPriceNtd: number;
  buildingPriceNtd: number;
  buildingAreaPing: number;
  parkingPriceNtd: number;
  parkingAreaPing: number;
  buildingUnitPriceWan: number;
  floor: number;
  totalFloors: number;
  floorGroup: FloorGroup;
  completionDate: string | null;
  notes: string;
  exclusionFlags: string[];
}

export interface MarketSubject {
  listingId: number | null;
  coordinate: Coordinate;
  district: string;
  ownership: 'freehold' | 'non-freehold' | 'unknown';
  buildingType: BuildingType;
  buildingAreaPing: number;
  askingUnitPriceWan: number;
  floor: number;
  totalFloors: number;
  floorGroup: FloorGroup;
  ageYears: number | null;
  parkingSeparable: boolean;
}

export interface ComparableEvidence {
  transaction: MarketTransaction;
  distanceMinM: number;
  distanceMaxM: number;
  transactionAgeMonths: number;
  weight: WeightBreakdown;
  included: boolean;
  reasons: string[];
}

export interface SourceFreshness {
  transactionCheckedAt: string | null;
  doorplateCheckedAt: string | null;
  transactionStale: boolean;
  doorplateStale: boolean;
}

export interface MarketEstimate {
  status: EstimateStatus;
  confidence: EstimateConfidence;
  marketUnitPriceMedian: number | null;
  marketUnitPriceP25: number | null;
  marketUnitPriceP75: number | null;
  askingPremiumMedian: number | null;
  askingPremiumConservative: number | null;
  selectedStage: number | null;
  sourceFreshness: SourceFreshness;
  unavailableReasons: string[];
  comparables: ComparableEvidence[];
  excludedCandidates: ComparableEvidence[];
}

export interface DoorplatePoint {
  canonicalAddress: string;
  coordinate: Coordinate;
  district: string;
  roadKey: string;
  mainNumber: number;
  subNumber: number | null;
}

export interface DoorplateIndex {
  schemaVersion: number;
  datasetVersion: string;
  byCanonicalAddress: Record<string, DoorplatePoint[]>;
  byRoad: Record<string, DoorplatePoint[]>;
  cells: Record<string, DoorplatePoint[]>;
}

export interface TransactionIndex {
  schemaVersion: number;
  datasetVersion: string;
  builtAt: string;
  cells: Record<string, MarketTransaction[]>;
}

export interface SelectionResult {
  selectedStage: number | null;
  included: ComparableEvidence[];
  excluded: ComparableEvidence[];
  candidates: ComparableEvidence[];
}

export interface MarketDataManifest {
  schemaVersion: number;
  buildId: string;
  builtAt: string;
  doorplates: {
    sourceUrl: string;
    publishedAt: string | null;
    checkedAt: string;
    sha256: string;
    recordCount: number;
  };
  transactions: {
    sourceUrls: string[];
    publishedAt: string | null;
    checkedAt: string;
    sha256: string;
    recordCount: number;
  };
  lastFailure: { at: string; reason: string } | null;
}

export interface MarketDataBundle {
  manifest: MarketDataManifest;
  doorplates: DoorplateIndex;
  transactions: TransactionIndex;
}
```

Also define source-descriptor and build-summary interfaces. In `config.ts`,
implement the exact constants asserted by the test plus:

```ts
export const MARKET_SCHEMA_VERSION = 1;
export const MARKET_DATA_ROOT = 'state/market-data/taipei';
export const MIN_COMPARABLES = 3;
export const HIGH_CONFIDENCE_MIN_COMPARABLES = 5;
export const HIGH_IQR_RATIO = 0.15;
export const MEDIUM_IQR_RATIO = 0.25;
export const GRID_CELL_DEGREES = 0.005;
export const MIN_PRODUCTION_DOORPLATES = 100_000;
export const MIN_PRODUCTION_TRANSACTIONS = 1_000;
```

- [ ] **Step 6: Run the focused test and typecheck**

Run:

```bash
node --import tsx --test scripts/lib/market-data/config.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json scripts/lib/market-data
git commit -m "feat(market): add domain contracts and configuration"
```

---

### Task 2: Preserve Server-Side Listing Building-Type Provenance

**Files:**
- Modify: `profiles/example-investment/profile.json`
- Modify: `scripts/lib/types.ts`
- Modify: `scripts/lib/api.ts`
- Modify: `scripts/lib/map.ts`
- Modify: `scripts/lib/extract.ts`
- Modify: `scripts/lib/http.ts`
- Modify: `scripts/lib/steps.ts`
- Modify: `scripts/lib/map.test.ts`
- Modify: `scripts/lib/api.test.ts`
- Create: `scripts/lib/extract-variants.test.ts`
- Modify: `docs/fetching.md`

**Interfaces:**
- Consumes: `BuildingType` from Task 1.
- Produces: `Listing.queryHouseType: string | null`, `Listing.buildingType: BuildingType | null`.
- Produces: `fetchVariants(fetch: FetchMap): Array<{ filters: FetchMap; queryHouseType: string | null }>` and `collectListingVariants(...)`.

- [ ] **Step 1: Write failing provenance tests**

Add to `map.test.ts`:

```ts
test('query house type supplies deterministic building type', () => {
  assert.equal(apiItemToListing(ITEM, [], '16').buildingType, 'apartment');
  assert.equal(apiItemToListing({ ...ITEM, total_floor: 8 }, [], '17').buildingType, 'midrise');
  assert.equal(apiItemToListing({ ...ITEM, total_floor: 12 }, [], '17').buildingType, 'highrise');
  assert.equal(apiItemToListing({ ...ITEM, total_floor: 0 }, [], '17').buildingType, null);
  assert.equal(apiItemToListing(ITEM, [], null).buildingType, null);
});
```

Create `extract-variants.test.ts` with injected collectors:

```ts
test('house_type array becomes separate typed fetches', () => {
  assert.deepEqual(fetchVariants({ city: '1', house_type: ['16', '17'] }), [
    { filters: { city: '1', house_type: ['16'] }, queryHouseType: '16' },
    { filters: { city: '1', house_type: ['17'] }, queryHouseType: '17' },
  ]);
});

test('cross-variant duplicate ids are counted and conflicting provenance becomes untyped', async () => {
  const result = await mergeVariantListings([
    { queryHouseType: '16', listings: [listing({ id: 7, queryHouseType: '16', buildingType: 'apartment' })] },
    { queryHouseType: '17', listings: [listing({ id: 7, queryHouseType: '17', buildingType: 'midrise' })] },
  ]);
  assert.equal(result.listings[0].buildingType, null);
  assert.equal(result.provenanceConflicts, 1);
});
```

- [ ] **Step 2: Run focused tests to verify failure**

Run:

```bash
node --import tsx --test scripts/lib/map.test.ts scripts/lib/extract-variants.test.ts
```

Expected: FAIL because the new fields/functions do not exist.

- [ ] **Step 3: Add the profile filter and listing fields**

Change the investment fetch map:

```json
"house_type": ["16", "17"]
```

Add to `Listing`:

```ts
queryHouseType: string | null;
buildingType: BuildingType | null;
```

Implement mapping without title inference:

```ts
export function buildingTypeFromQuery(queryHouseType: string | null, totalFloors: number | null): BuildingType | null {
  if (queryHouseType === '16') return 'apartment';
  if (queryHouseType !== '17' || totalFloors == null || totalFloors <= 0) return null;
  return totalFloors <= 10 ? 'midrise' : 'highrise';
}
```

Pass `queryHouseType` into `apiItemToListing`.

- [ ] **Step 4: Split fetch variants and merge results**

Implement:

```ts
export function fetchVariants(fetch: FetchMap): FetchVariant[] {
  const raw = fetch.house_type;
  if (!Array.isArray(raw) || raw.length <= 1) {
    return [{ filters: fetch, queryHouseType: Array.isArray(raw) ? raw[0] ?? null : null }];
  }
  return raw.map((value) => ({
    filters: { ...fetch, house_type: [value] },
    queryHouseType: value,
  }));
}
```

Make `collectListings` accept `queryHouseType` and preserve it in every map call. In `fetchStep`, collect each variant, merge by stable listing ID, add history-drop/duplicate counts, and mark a duplicate with conflicting query types as `buildingType: null` plus a journal warning.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --import tsx --test scripts/lib/map.test.ts scripts/lib/api.test.ts scripts/lib/extract-variants.test.ts
npm test
```

Expected: PASS; the existing owner-occupied single `house_type=17` query remains one request.

- [ ] **Step 6: Document the split-query contract**

Update `docs/fetching.md` to state that `house_type` is server-side only, arrays are queried separately when provenance is required, and normalized `buildingType` is never inferred from `pattern`.

- [ ] **Step 7: Commit**

```bash
git add profiles/example-investment/profile.json scripts/lib docs/fetching.md
git commit -m "feat(fetch): preserve listing building type provenance"
```

---

### Task 3: Normalize Addresses, Property Types, Floors, and Coordinates

**Files:**
- Create: `scripts/lib/market-data/address.ts`
- Create: `scripts/lib/market-data/address.test.ts`
- Create: `scripts/lib/market-data/property.ts`
- Create: `scripts/lib/market-data/property.test.ts`
- Create: `scripts/lib/market-data/projection.ts`
- Create: `scripts/lib/market-data/projection.test.ts`
- Create: `scripts/lib/market-data/grid.ts`
- Create: `scripts/lib/market-data/grid.test.ts`

**Interfaces:**
- Produces: `normalizeTaiwanAddress(input): NormalizedAddress`.
- Produces: `parseDoorNumberRange(token): { min: number; max: number } | null`.
- Produces: `normalizeOfficialBuildingType(raw): BuildingType | null`.
- Produces: `floorGroup(type, floor, totalFloors): FloorGroup | null`.
- Produces: `twd97ToWgs84(x, y): Coordinate`.
- Produces: `gridKey(coordinate)` and `neighborGridKeys(coordinate, radiusM)`.

- [ ] **Step 1: Write failing normalization tests**

Use exact representative cases:

```ts
test('normalizes Taiwan address variants and Chinese numerals', () => {
  assert.equal(
    normalizeTaiwanAddress('臺北市 中正區 忠孝東路 一段 １０號之２').canonical,
    '台北市中正區忠孝東路1段10號之2',
  );
});

test('parses masked door-number ranges', () => {
  assert.deepEqual(parseDoorNumberRange('1~30號'), { min: 1, max: 30 });
  assert.deepEqual(parseDoorNumberRange('31至60號'), { min: 31, max: 60 });
});
```

Property rules:

```ts
test('apartment top floor overrides middle', () => {
  assert.equal(floorGroup('apartment', 4, 4), 'top');
  assert.equal(floorGroup('apartment', 4, 5), 'middle');
  assert.equal(floorGroup('apartment', 5, 5), 'top');
});

test('elevator building groups use approved boundaries', () => {
  assert.equal(floorGroup('midrise', 1, 8), 'first');
  assert.equal(floorGroup('midrise', 4, 8), 'low');
  assert.equal(floorGroup('midrise', 5, 8), 'middle');
  assert.equal(floorGroup('highrise', 8, 12), 'high');
});
```

Projection test with a checked Taipei control point:

```ts
test('converts TWD97 Taipei coordinate to WGS84', () => {
  const p = twd97ToWgs84(306962.276, 2770291.297);
  assert.ok(Math.abs(p.lat - 25.033964) < 0.00002);
  assert.ok(Math.abs(p.lng - 121.564468) < 0.00002);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --import tsx --test scripts/lib/market-data/address.test.ts scripts/lib/market-data/property.test.ts scripts/lib/market-data/projection.test.ts scripts/lib/market-data/grid.test.ts
```

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement pure normalization and property helpers**

Use explicit component parsing rather than substring guesses. Return:

```ts
export interface NormalizedAddress {
  canonical: string;
  city: string | null;
  district: string | null;
  road: string | null;
  section: number | null;
  lane: number | null;
  alley: number | null;
  number: number | null;
  subNumber: number | null;
  numberRange: { min: number; max: number } | null;
}
```

Map official `公寓(5樓含以下無電梯)` to apartment, `華廈(10層含以下有電梯)` to midrise, and `住宅大樓(11層含以上有電梯)` to highrise. Unknown labels return `null`.

- [ ] **Step 4: Implement projection and spatial grid**

Register EPSG:3826 and EPSG:4326 with `proj4`. Validate finite coordinates and Taipei bounds. Use deterministic grid keys:

```ts
export function gridKey(c: Coordinate): string {
  return `${Math.floor(c.lat / GRID_CELL_DEGREES)}:${Math.floor(c.lng / GRID_CELL_DEGREES)}`;
}
```

`neighborGridKeys` must enumerate every cell intersecting the requested radius, sorted lexicographically for stable output.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
node --import tsx --test scripts/lib/market-data/address.test.ts scripts/lib/market-data/property.test.ts scripts/lib/market-data/projection.test.ts scripts/lib/market-data/grid.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/market-data
git commit -m "feat(market): normalize Taipei addresses and property geometry"
```

---

### Task 4: Build and Query the Offline Doorplate Index

**Files:**
- Create: `scripts/lib/market-data/doorplates.ts`
- Create: `scripts/lib/market-data/doorplates.test.ts`
- Create: `scripts/lib/market-data/fixtures/doorplates.csv`

**Interfaces:**
- Consumes: address, projection, grid, and types from Tasks 1 and 3.
- Produces: `mapDoorplateRow`, `buildDoorplateIndex`, `locateAddress`, `nearestDoorplate`.

- [ ] **Step 1: Add a sanitized fixture and failing tests**

The fixture must contain exact TWD97 columns for several numbers on one road,
including odd/even numbers and an attached number. Test:

```ts
test('exact address resolves to one doorplate', () => {
  const result = locateAddress(index, '台北市中正區測試路1段10號');
  assert.equal(result.method, 'exact-doorplate');
  assert.equal(result.uncertaintyMeters, 0);
});

test('masked range returns centroid and covering uncertainty', () => {
  const result = locateAddress(index, '台北市中正區測試路1段1~30號');
  assert.equal(result.method, 'address-range');
  assert.ok((result.uncertaintyMeters ?? 0) > 0);
  assert.equal(result.confidence, 'medium');
});

test('reverse lookup returns the nearest local doorplate and distance', () => {
  const result = nearestDoorplate(index, { lat: 25.03396, lng: 121.56447 });
  assert.equal(result.method, 'nearest-doorplate');
  assert.ok((result.uncertaintyMeters ?? Infinity) < 50);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --import tsx --test scripts/lib/market-data/doorplates.test.ts
```

Expected: FAIL because `doorplates.ts` does not exist.

- [ ] **Step 3: Implement streaming row mapping and index construction**

Use `csv-parse` streaming APIs; do not read the 119 MB source with a synchronous all-rows parser. Build:

```ts
interface DoorplateIndex {
  schemaVersion: number;
  datasetVersion: string;
  byCanonicalAddress: Record<string, DoorplatePoint[]>;
  byRoad: Record<string, DoorplatePoint[]>;
  cells: Record<string, DoorplatePoint[]>;
}
```

Sort every stored array by canonical address, then coordinate, before serialization.

- [ ] **Step 4: Implement exact, range, and nearest lookup**

For range lookup, match same city/district/road/section/lane/alley and all main
numbers inside the range. Calculate the centroid and maximum haversine distance
from centroid as uncertainty. Return unresolved when no candidate exists.

For reverse lookup, search neighboring grid cells progressively up to 300 m,
then choose the minimum haversine distance with a stable address tie-break.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --import tsx --test scripts/lib/market-data/doorplates.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/market-data/doorplates.ts scripts/lib/market-data/doorplates.test.ts scripts/lib/market-data/fixtures/doorplates.csv
git commit -m "feat(market): add offline Taipei doorplate locator"
```

---

### Task 5: Normalize Official Sale Transactions

**Files:**
- Create: `scripts/lib/market-data/transactions.ts`
- Create: `scripts/lib/market-data/transactions.test.ts`
- Create: `scripts/lib/market-data/fixtures/transactions.csv`

**Interfaces:**
- Consumes: `DoorplateIndex`, property helpers, location evidence.
- Produces: `rocDateToIso`, `normalizeSaleTransaction`, `specialTransactionFlags`.

- [ ] **Step 1: Write failing date, parking, and exclusion tests**

```ts
test('converts ROC dates and computes building-only unit price', () => {
  const tx = normalizeSaleTransaction(row({
    交易年月日: '1150105',
    建物移轉總面積平方公尺: '100',
    總價元: '30000000',
    車位移轉總面積平方公尺: '20',
    車位總價元: '3000000',
  }), context);
  assert.equal(tx.kind, 'included');
  assert.equal(tx.transaction.transactionDate, '2026-01-05');
  assert.ok(Math.abs(tx.transaction.buildingAreaPing - 24.2) < 0.1);
});

test('parking that cannot be fully separated is excluded', () => {
  const tx = normalizeSaleTransaction(row({
    車位類別: '坡道平面',
    車位移轉總面積平方公尺: '20',
    車位總價元: '0',
  }), context);
  assert.deepEqual(tx.reasons, ['parking-not-separable']);
});

test('explicit special relationship is excluded but ambiguous prose is reviewed', () => {
  assert.ok(specialTransactionFlags('親友、員工、共有人或其他特殊關係間之交易').includes('related-party'));
  assert.deepEqual(specialTransactionFlags('屋主誠意出售'), []);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --import tsx --test scripts/lib/market-data/transactions.test.ts
```

Expected: FAIL because transaction normalization is absent.

- [ ] **Step 3: Implement strict schema aliases and value parsing**

Support the official Chinese header names and reject missing required headers
before row parsing. Skip the official second explanatory row by detecting
non-data date/price cells, not by blindly dropping an arbitrary row.

Return a discriminated result:

```ts
type TransactionNormalization =
  | { kind: 'included'; transaction: MarketTransaction }
  | { kind: 'excluded'; id: string; reasons: string[] };
```

Preserve completion date rather than freezing age at index-build time. The
selector calculates both subject and comparable ages at the listing target date
before applying age gates. Preserve original notes and all explicit flags.

- [ ] **Step 4: Implement parking and special-case safety**

Require both positive parking area and price when parking exists. Cross-check
derived unit price against the official unit-price field and exclude with
`unit-price-conflict` when the relative difference exceeds 5%.

Map only sale targets containing a building, freehold ownership, and supported
building types. Mark explicit superficies/use-right cases non-freehold so they
cannot cross-match.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --import tsx --test scripts/lib/market-data/transactions.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/market-data/transactions.ts scripts/lib/market-data/transactions.test.ts scripts/lib/market-data/fixtures/transactions.csv
git commit -m "feat(market): normalize official Taipei sale transactions"
```

---

### Task 6: Select, Weight, and Estimate Comparable Transactions

**Files:**
- Create: `scripts/lib/market-data/statistics.ts`
- Create: `scripts/lib/market-data/statistics.test.ts`
- Create: `scripts/lib/market-data/selector.ts`
- Create: `scripts/lib/market-data/selector.test.ts`
- Create: `scripts/lib/market-data/estimator.ts`
- Create: `scripts/lib/market-data/estimator.test.ts`
- Modify: `scripts/lib/finance.ts`
- Modify: `scripts/lib/finance.test.ts`

**Interfaces:**
- Produces: `weightedQuantile`, `weightedMadOutliers`.
- Produces: `selectComparables(subject, candidates, asOf)`.
- Produces: `estimateMarket(subject, index, freshness, asOf): MarketEstimate`.
- Produces: `askingPremiumPercent(listingUnitPrice, marketUnitPrice)`.

- [ ] **Step 1: Write failing statistics and premium tests**

```ts
test('weighted quantile respects high-weight observations', () => {
  assert.equal(weightedQuantile([
    { value: 80, weight: 1 },
    { value: 100, weight: 8 },
    { value: 140, weight: 1 },
  ], 0.5), 100);
});

test('asking premium is positive above market', () => {
  assert.equal(askingPremiumPercent(108, 100), 8);
});
```

- [ ] **Step 2: Write failing staged-selection tests**

Construct transactions around one subject and assert:

```ts
test('stops at the first stage with three comparables', () => {
  const result = selectComparables(subject, candidates, '2026-07-25');
  assert.equal(result.selectedStage, 2);
  assert.equal(result.included.length, 3);
  assert.ok(result.included.every((c) => c.distanceMaxM <= 500));
});

test('apartment age never excludes or downweights', () => {
  const result = selectComparables(apartmentSubject, [oldApartment], '2026-07-25');
  assert.equal(result.candidates[0].weight.buildingAge, 1);
});

test('first floor never relaxes into low floor', () => {
  const result = selectComparables(firstFloorSubject, [secondFloor], '2026-07-25');
  assert.equal(result.included.length, 0);
});
```

Also test same-district/type/ownership hard gates, range-distance min for
eligibility and max for weight, all approved weight factors, 36-month maximum,
and no outlier removal below five candidates.

- [ ] **Step 3: Write failing confidence and conservative-decision tests**

```ts
test('median qualifies but P25 crossing threshold stays reviewable', () => {
  const estimate = estimateMarket(subjectAt105, indexWithPrices([90, 100, 100, 110, 120]), fresh, asOf);
  assert.equal(estimate.askingPremiumMedian, 5);
  assert.ok((estimate.askingPremiumConservative ?? 0) > estimate.askingPremiumMedian!);
});

test('wide IQR cannot be reliable', () => {
  const estimate = estimateMarket(subject, indexWithPrices([60, 80, 100, 130, 160]), fresh, asOf);
  assert.equal(estimate.status, 'review');
  assert.equal(estimate.confidence, 'low');
});
```

- [ ] **Step 4: Run tests to verify failure**

Run:

```bash
node --import tsx --test scripts/lib/market-data/statistics.test.ts scripts/lib/market-data/selector.test.ts scripts/lib/market-data/estimator.test.ts scripts/lib/finance.test.ts
```

Expected: FAIL because the estimator modules and premium helper do not exist.

- [ ] **Step 5: Implement statistics and exact staged selection**

Sort weighted observations by value with deterministic ID tie-breaks. Validate
positive finite weights. Apply weighted MAD only when at least five candidates
exist and record every excluded outlier in `excludedCandidates`.

Selection must evaluate complete stage criteria, stop at the first stage with
three included transactions, and retain every qualifying transaction from that
stage. If no stage reaches three, retain the one or two transactions qualifying
at final stage 5 as low-confidence review evidence, and return exclusion reasons
for every other candidate.

- [ ] **Step 6: Implement estimate status and confidence**

Compute median/P25/P75, IQR ratio, middle premium, and P25 conservative premium.
Use the explicit mapping:

```ts
if (hardReasons.length > 0 || included.length === 0) status = 'unavailable';
else if (included.length < 3 || stale || iqrRatio > 0.25) status = 'review';
else status = 'reliable';
```

High confidence additionally requires five comparables, no stage 5, IQR ratio
at most 0.15, and fresh sources. Medium requires three and IQR at most 0.25.

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --import tsx --test scripts/lib/market-data/statistics.test.ts scripts/lib/market-data/selector.test.ts scripts/lib/market-data/estimator.test.ts scripts/lib/finance.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/market-data scripts/lib/finance.ts scripts/lib/finance.test.ts
git commit -m "feat(market): estimate prices from weighted comparables"
```

---

### Task 7: Download, Validate, Build, and Atomically Publish Market Indexes

**Files:**
- Create: `scripts/lib/market-data/sources.ts`
- Create: `scripts/lib/market-data/sources.test.ts`
- Create: `scripts/lib/market-data/store.ts`
- Create: `scripts/lib/market-data/store.test.ts`
- Create: `scripts/lib/market-data/update.ts`
- Create: `scripts/lib/market-data/update.test.ts`
- Create: `scripts/lib/market-data/fixtures/taipei-doorplate-detail.html`

**Interfaces:**
- Produces: `quartersForLookback(asOf, 36)`.
- Produces: `resolveTaipeiDoorplateSource`, `moiSeasonUrl`, `downloadConditional`, `extractTaipeiSalesCsv`.
- Produces: `readManifest`, `loadMarketData`, `publishStagedBuild`.
- Produces: `ensureTaipeiMarketData(options): Promise<MarketDataBundle | null>`.

- [ ] **Step 1: Write failing source-resolution tests**

```ts
test('36-month lookback enumerates every intersecting ROC quarter', () => {
  assert.deepEqual(quartersForLookback('2026-07-25', 36), [
    '112S3', '112S4', '113S1', '113S2', '113S3', '113S4',
    '114S1', '114S2', '114S3', '114S4', '115S1', '115S2', '115S3',
  ]);
});

test('MOI season URL uses official CSV ZIP shape', () => {
  assert.equal(
    moiSeasonUrl('115S3'),
    'https://plvr.land.moi.gov.tw/DownloadSeason?season=115S3&type=zip&fileName=lvr_landcsv.zip',
  );
});

test('doorplate detail parser resolves exactly one CSV resource', () => {
  const source = resolveTaipeiDoorplateSource(fixtureHtml);
  assert.match(source.url, /resource\\.download\\?rid=/);
  assert.equal(source.publishedAt, '2026-07-02T09:47:33+08:00');
});
```

- [ ] **Step 2: Write failing atomic-store tests**

Use a temporary directory and assert:

```ts
test('failed validation preserves last-known-good manifest and indexes', async () => {
  await seedGoodMarketData(tmp);
  await assert.rejects(() => publishStagedBuild(tmp, brokenStage));
  assert.equal(readManifest(tmp)!.buildId, 'good-build');
});
```

Also test required headers, Taipei coordinate bounds, nonzero record counts,
checksum changes, stale calculations, stable sorted JSON, and cleanup limited
to the validated staging directory. Inject a fake ZIP-entry iterator into the
extractor tests so tests cover `a_lvr_land_a.csv`, absolute paths, and `..`
without committing a binary ZIP fixture.

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
node --import tsx --test scripts/lib/market-data/sources.test.ts scripts/lib/market-data/store.test.ts scripts/lib/market-data/update.test.ts
```

Expected: FAIL because updater modules do not exist.

- [ ] **Step 4: Implement official source adapters**

Use the official Taipei dataset detail URL:

```ts
export const TAIPEI_DOORPLATE_DETAIL_URL =
  'https://data.taipei/dataset/detail?id=b7c8e724-1e98-45ee-a0bd-f3840623ed97';
```

Parse the current CSV download link and published timestamp from the detail
response. Treat zero or multiple matching resources as schema drift.

For MOI, download all quarters intersecting 36 months. Cache immutable completed
quarters by checksum; conditionally recheck the current and immediately prior
quarter using stored ETag/Last-Modified. Extract only `a_lvr_land_a.csv` and
reject ZIP entries containing absolute paths or `..`.

- [ ] **Step 5: Implement streaming builds and atomic publication**

Build indexes in a sibling `mkdtemp` directory under
`state/market-data/.taipei-staging-*`, so the complete
`state/market-data/taipei` directory can be atomically replaced. Validate:

- exact required headers;
- fixture thresholds supplied by tests, and production minimums of 100,000
  doorplates plus 1,000 included Taipei transactions;
- all coordinates inside broad Taipei bounds;
- schema version;
- sorted cell keys and stable record order;
- SHA-256 for every raw and derived artifact.

Publish by renaming the active directory to a specifically named backup,
renaming the complete stage to active, then removing only that backup after
success. If rename fails, restore the backup and surface the error.

- [ ] **Step 6: Implement last-known-good updater orchestration**

`ensureTaipeiMarketData` accepts injected fetch, clock, root path, and logger.
It returns the active bundle when refresh fails, with freshness calculated from
the manifest. It returns `null` only when no valid active build exists.

Journal events:

```text
market-data.check
market-data.not-modified
market-data.updated
market-data.schema-drift
market-data.last-known-good
market-data.unavailable
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --import tsx --test scripts/lib/market-data/sources.test.ts scripts/lib/market-data/store.test.ts scripts/lib/market-data/update.test.ts
npx tsc --noEmit
```

Expected: PASS without network.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/market-data
git commit -m "feat(market): build versioned official-data indexes"
```

---

### Task 8: Integrate Automatic Market Estimation into Enrichment

**Files:**
- Modify: `scripts/lib/types.ts`
- Modify: `scripts/lib/steps.ts`
- Modify: `scripts/lib/enrich-offline.test.ts`
- Create: `scripts/lib/market-data/integration.test.ts`
- Create: `scripts/lib/market-data/fixtures/enriched-market-index.json`

**Interfaces:**
- Consumes: `ensureTaipeiMarketData` and `estimateMarket`.
- Produces: `EnrichedListing.marketEstimate: MarketEstimate`.
- Produces: enrich summary keys `marketReliable`, `marketReview`, `marketUnavailable`, `marketDataStale`.

- [ ] **Step 1: Write the failing enrich integration test**

Inject a market-data dependency into `enrichStep` or extract a pure
`attachMarketEstimates` helper. Assert:

```ts
test('enrich attaches auditable market estimate once per listing', () => {
  const [result] = attachMarketEstimates([typedListing], fixtureBundle, '2026-07-25');
  assert.equal(result.marketEstimate.status, 'reliable');
  assert.equal(result.marketEstimate.comparables.length, 5);
  assert.equal(result.marketEstimate.selectedStage, 1);
});

test('untyped, unreliable GPS, and inseparable listing parking stay unavailable or review', () => {
  assert.deepEqual(
    attachMarketEstimates([untypedListing], bundle, asOf)[0].marketEstimate.unavailableReasons,
    ['listing-building-type-unavailable'],
  );
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --import tsx --test scripts/lib/market-data/integration.test.ts
```

Expected: FAIL because enriched listings have no market estimate.

- [ ] **Step 3: Add the enriched contract and pure attachment helper**

Add `marketEstimate` to `EnrichedListing`. The attachment helper must:

- require `coordinate`, `reliability.coordConsistent !== false`, and derived building type;
- require no parking or fully separable listing data; because iBigFun lacks
  separable parking price, any non-`無車位` listing becomes review;
- classify explicit `地上權`, `使用權`, and `區分地上權` title text as
  non-freehold; otherwise use the existing profile assumption of freehold and
  retain that assumption in estimate evidence;
- derive subject floor group;
- call the estimator with one already-loaded bundle;
- always return a `MarketEstimate`, including unavailable cases.

- [ ] **Step 4: Call updater once at enrich start**

In `enrichStep`, call `ensureTaipeiMarketData({ asOf: range.to, logger })` once,
then estimate all listings after deterministic walk finalization. A failed
refresh must not erase last-known-good. No active bundle produces unavailable
estimates but does not fail the independent enrich work.

Add the four market summary counts and journal the source build ID/freshness,
never raw comparable rows.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --import tsx --test scripts/lib/market-data/integration.test.ts scripts/lib/enrich-offline.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/types.ts scripts/lib/steps.ts scripts/lib/enrich-offline.test.ts scripts/lib/market-data
git commit -m "feat(enrich): attach official market estimates"
```

---

### Task 9: Add Update and Leakage-Free Backtest CLI

**Files:**
- Create: `scripts/market-data.ts`
- Create: `scripts/lib/market-data/backtest.ts`
- Create: `scripts/lib/market-data/backtest.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run market-data -- update --city taipei`.
- Produces: `npm run market-data -- backtest --city taipei [--as-of YYYY-MM-DD]`.
- Produces: `backtestTransactions(index, options): BacktestReport`.

- [ ] **Step 1: Write failing leakage and metric tests**

```ts
test('held-out estimate uses only transactions before subject date', () => {
  const report = backtestTransactions(indexWithFutureLeak, { asOf: '2026-07-25' });
  assert.ok(report.cases.every((c) =>
    c.comparableDates.every((date) => date < c.subjectDate)
  ));
});

test('reports coverage, median APE, P75 APE, bias, interval coverage, and confidence slices', () => {
  const report = backtestTransactions(fixtureIndex, { asOf: '2026-07-25' });
  assert.equal(typeof report.overall.estimateCoverage, 'number');
  assert.equal(typeof report.overall.medianApe, 'number');
  assert.ok(report.byBuildingType.apartment);
  assert.ok(report.byConfidence.high);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --import tsx --test scripts/lib/market-data/backtest.test.ts
```

Expected: FAIL because backtesting is absent.

- [ ] **Step 3: Implement held-out backtesting**

Treat each eligible transaction as a subject. Remove its ID, discard every
candidate on or after its transaction date, construct the subject from its
known property fields, and call the same production estimator. Calculate:

```ts
ape = Math.abs(estimatedMedian - actualUnitPrice) / actualUnitPrice;
bias = (estimatedMedian - actualUnitPrice) / actualUnitPrice;
intervalHit = actualUnitPrice >= p25 && actualUnitPrice <= p75;
```

Aggregate overall, by building type, and by emitted confidence. Store no
personally identifying data in the summary.

- [ ] **Step 4: Implement strict CLI parsing**

Add:

```json
"market-data": "tsx scripts/market-data.ts"
```

Reject unsupported cities and invalid dates with exit code 2. `update` prints
only build ID, source dates, counts, and freshness. `backtest` prints JSON plus
a concise stderr summary and exits 1 when a completed backtest misses either
the 12% median APE or 20% P75 APE target; `--no-gate` reports metrics without a
nonzero quality-gate exit.

- [ ] **Step 5: Run focused tests and CLI help/error smoke tests**

Run:

```bash
node --import tsx --test scripts/lib/market-data/backtest.test.ts
npm run market-data -- backtest --city invalid
```

Expected: tests PASS; invalid city exits 2 with `supported city: taipei`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/market-data.ts scripts/lib/market-data/backtest.ts scripts/lib/market-data/backtest.test.ts
git commit -m "feat(market): add update and backtest CLI"
```

---

### Task 10: Make Agent Review and Report Semantics Auditable

**Files:**
- Modify: `scripts/lib/runpaths.ts`
- Modify: `scripts/lib/runpaths.test.ts`
- Create: `scripts/lib/valuation-review.ts`
- Create: `scripts/lib/valuation-review.test.ts`
- Modify: `scripts/pipeline.ts`
- Modify: `prompts/daily-run.md`
- Modify: `docs/reporting-rules.md`
- Modify: `docs/fetching.md`
- Modify: `AGENTS.md`
- Modify: `profiles/example-investment/evaluation.md`
- Modify: `profiles/example-investment/notify-template.md`
- Modify: `data/README.md`

**Interfaces:**
- Produces: `valuationReviewPath(profileId, label)`.
- Produces: `validateValuationReview(value): ValuationReviewFile`.
- Pipeline validates optional review evidence before marking report `ok`.

- [ ] **Step 1: Write failing review-schema tests**

```ts
test('accepts complete external valuation evidence', () => {
  assert.doesNotThrow(() => validateValuationReview({
    schemaVersion: 1,
    reviews: [{
      listingId: 53199422,
      source: '好時價',
      sourceUrl: 'https://example.invalid/valuation',
      checkedAt: '2026-07-26T01:00:00.000Z',
      externalUnitPriceWan: 92,
      externalTotalPriceWan: 1600,
      officialMedianWan: 88,
      officialP25Wan: 82,
      officialP75Wan: 95,
      differencePercent: 4.55,
      accepted: true,
      rationale: '門牌與型態一致，作為邊界覆核',
      resultingBucket: 'near-threshold',
    }],
  }));
});

test('rejects silent override without source URL or rationale', () => {
  assert.throws(() => validateValuationReview(invalidReview), /sourceUrl/);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --import tsx --test scripts/lib/valuation-review.test.ts scripts/lib/runpaths.test.ts
```

Expected: FAIL because review contracts are absent.

- [ ] **Step 3: Implement path and schema validation**

Add:

```ts
export function valuationReviewPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'valuation-review.json');
}
```

Validate finite numeric fields, ISO timestamps, HTTP(S) source URL, nonempty
rationale, and bucket enum. In `pipeline mark report --status ok`, validate the
file when it exists and refuse marking on malformed evidence.

- [ ] **Step 4: Update the worker and profile rules**

Document:

- `marketEstimate` is the default market source;
- P25 conservative premium gates recommendation;
- low/review/unavailable and median-only qualification trigger bounded external review;
- external results never replace official values silently;
- `valuation-review.json` is required whenever external valuation affects a bucket;
- stale market data forces notification status `warn`;
- listings with inseparable parking cannot be automatically recommended.

Update the report template's financial line to include median range, confidence,
comparable count, selected stage, and official source date. Add a compact manual
review line rather than embedding the full comparable list in notifications.

- [ ] **Step 5: Update source/tool documentation**

Add the `market-data` update/backtest commands, local state layout, split
house-type fetch, source URLs, freshness limits, and no-credential requirement
to `AGENTS.md`, `docs/fetching.md`, and `data/README.md`.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --import tsx --test scripts/lib/valuation-review.test.ts scripts/lib/runpaths.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md data/README.md docs/reporting-rules.md docs/fetching.md prompts/daily-run.md profiles/example-investment scripts/lib/runpaths.ts scripts/lib/runpaths.test.ts scripts/lib/valuation-review.ts scripts/lib/valuation-review.test.ts scripts/pipeline.ts
git commit -m "feat(report): make valuation evidence auditable"
```

---

### Task 11: Verify the Complete Offline Flow and Document the Baseline Procedure

**Files:**
- Create: `docs/market-data.md`
- Modify: `README.md`
- Modify: `.env.example` only if implementation introduced an optional source override; do not add a required geocoder key.

**Interfaces:**
- Verifies all interfaces from Tasks 1–10.
- Produces the operator guide for first build, daily behavior, inspection, rollback, and backtest interpretation.

- [ ] **Step 1: Run formatting/static checks**

Run:

```bash
git diff --check
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: Run the complete automated suite**

Run:

```bash
npm test
```

Expected: all tests PASS with no network access.

- [ ] **Step 3: Run deterministic fixture integration twice**

Run the integration test twice:

```bash
node --import tsx --test scripts/lib/market-data/integration.test.ts
node --import tsx --test scripts/lib/market-data/integration.test.ts
```

Expected: both PASS and fixture index/estimate checksums remain identical.

- [ ] **Step 4: Perform the real-data update with explicit approval if network is sandboxed**

Run:

```bash
npm run market-data -- update --city taipei
```

Expected: a validated build under `state/market-data/taipei`, with Taipei
doorplate and transaction counts, source dates, checksums, and `stale: false`.
If the official source schema differs, stop publication, keep last-known-good,
capture only header names and error metadata, and fix the source adapter plus
fixture before retrying.

- [ ] **Step 5: Run the real-data backtest and preserve the local baseline**

Run:

```bash
npm run market-data -- backtest --city taipei --no-gate
```

Expected: coverage, median APE, P75 APE, signed bias, interval coverage, and
confidence/type slices. Save the full local report under
`state/market-data/backtests/taipei/`, outside the checksum-closed active build;
document the aggregate metrics in the handoff without committing transaction
rows.

- [ ] **Step 6: Write the operator guide**

`docs/market-data.md` must include:

- official sources and licensing links;
- initial and automatic refresh behavior;
- exact local paths and git-ignore policy;
- freshness and last-known-good semantics;
- how to inspect one listing's comparable evidence;
- how to run and interpret backtesting;
- quality targets and why failure keeps listings in review;
- supported Taipei-only scope and building-type provenance;
- troubleshooting for schema drift, bad coordinates, insufficient comparables,
  and parking ambiguity.

Link the guide from `README.md`.

- [ ] **Step 7: Re-run checks after documentation**

Run:

```bash
git diff --check
npm test
npx tsc --noEmit
git status --short
```

Expected: only intended implementation and documentation files are changed;
`state/` remains absent from Git status.

- [ ] **Step 8: Commit**

```bash
git add README.md docs/market-data.md .env.example
git commit -m "docs: add market data operations guide"
```
