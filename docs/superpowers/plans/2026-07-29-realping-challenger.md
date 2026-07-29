# RealPing Challenger Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated Taipei RealPing A-lite benchmark that compares a reduced-feature challenger with the current official estimator without changing daily production behavior.

**Architecture:** A strict RealPing client downloads and locally caches the documented transaction feed. A dedicated adapter geocodes provider doorplates into a separate comparable index, and a separate estimator applies the active policy's distance, time, area, age, outlier, quantile, confidence, and status concepts without inventing floor data. A paired held-out runner evaluates both estimators on identical official cases and emits aggregate-only evidence.

**Tech Stack:** TypeScript, Node.js 22 built-in `fetch`/`node:test`/`crypto`/filesystem APIs, existing doorplate/grid/finance/statistics/market-data modules, RealPing REST API.

## Global Constraints

- The benchmark is standalone; do not call it from `fetch`, `enrich`, `pipeline`, `market-data update`, reporting, or notification.
- Do not modify `marketEstimate`, `ACTIVE_ESTIMATOR_POLICY`, `ESTIMATOR_POLICY_VERSION`, production selector semantics, or production acceptance.
- Use only RealPing `去車位單價_萬元坪` and `淨建坪`; never substitute `實坪單價_萬元坪`.
- The challenger must not create transferred-floor, total-floor, completion-date, ownership, or transaction-ID evidence that the provider did not supply.
- Provider candidates must precede the complete held-out date; same-day and future records are excluded.
- Use the first 12 provider months as warm-up. Evaluate both systems only on identical official held-out cases from the next calendar day through the earlier of `--as-of` and the latest provider transaction date.
- The real API key remains in `.env` or the process environment and is never logged, serialized, cached, committed, or placed in fixtures.
- Automated tests inject HTTP responses and never call RealPing.
- Raw provider records may exist only in git-ignored `state/market-data/realping-cache/`; stdout and benchmark reports are aggregate-only.
- The challenger passes only when median APE and P75 APE are both strictly lower and coverage is not lower than the official estimator.
- Use `BACKTEST_ACCEPTANCE_THRESHOLDS.minimumConfidenceSliceCases` (currently 20) as the minimum paired estimated-case count; fewer cases are `inconclusive`.

---

## File Structure

- Create `scripts/lib/market-data/realping-client.ts`: response contract, authenticated pagination, timeout/retry behavior, schema fingerprint, and cache.
- Create `scripts/lib/market-data/realping-client.test.ts`: contract, transport, secret-redaction, pagination, retry, and cache tests.
- Create `scripts/lib/market-data/realping-adapter.ts`: strict provider normalization, deterministic local keys, doorplate geocoding, exclusion diagnostics, and challenger grid index.
- Create `scripts/lib/market-data/realping-adapter.test.ts`: price-basis, quality, address, deduplication, and collision tests.
- Create `scripts/lib/market-data/realping-estimator.ts`: reduced-feature comparable selection and weighted estimate.
- Create `scripts/lib/market-data/realping-estimator.test.ts`: stage, distance, date, area, age, weighting, outlier, confidence, and no-floor tests.
- Create `scripts/lib/market-data/realping-backtest.ts`: paired held-out evaluation, metrics, gate, and aggregate report persistence.
- Create `scripts/lib/market-data/realping-backtest.test.ts`: leakage, denominator, metric, gate, and redaction tests.
- Create `scripts/realping-benchmark.ts`: strict CLI and orchestration.
- Create `scripts/lib/realping-benchmark-cli.test.ts`: argument, missing-key, dependency injection, output, and exit-code tests.
- Create `docs/realping-benchmark.md`: credential setup, operation, limitations, and interpretation.
- Modify `.env.example`: document `REALPING_API_KEY`.
- Modify `package.json`: add the `realping-benchmark` command.
- Modify `AGENTS.md`: add the standalone diagnostic command to Tooling and source-of-truth map without adding it to the daily sequence.

---

### Task 1: Strict RealPing Client, Contract, and Cache

**Files:**

- Create: `scripts/lib/market-data/realping-client.ts`
- Test: `scripts/lib/market-data/realping-client.test.ts`

**Interfaces:**

- Produces:

```ts
export interface RealPingRawRecord {
  縣市: string;
  區: string;
  門牌: string;
  交易日: string | null;
  建物型態: string;
  主要用途: string | null;
  屋齡: number | null;
  總價: number | null;
  實坪單價_萬元坪: number | null;
  去車位單價_萬元坪: number | null;
  原始單價_萬元坪: number | null;
  公設比: number | null;
  實坪: number | null;
  淨建坪: number | null;
  房: number | null;
  廳: number | null;
  衛: number | null;
  是否特殊: boolean;
  含車位無價: boolean;
  多物件: boolean;
  單價可用: boolean;
  實坪可用: boolean;
  日期異常: boolean;
  來源期別: string;
}

export interface RealPingCorpus {
  source: string;
  fetchedAt: string;
  schemaFingerprint: string;
  requestFingerprint: string;
  responseChecksum: string;
  records: RealPingRawRecord[];
}

export interface RealPingQuery {
  city: '臺北市';
  dateFrom?: string;
  dateTo: string;
}

export interface RealPingClientDependencies {
  fetcher?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  cacheRoot?: string;
}

export async function fetchRealPingCorpus(
  query: RealPingQuery,
  apiKey: string,
  dependencies?: RealPingClientDependencies,
): Promise<RealPingCorpus>;
```

- Constants: base URL `https://api.realping.tw`, page size `1000`, timeout `20_000` ms, maximum attempts `2`, retry delay `250` ms.

- [ ] **Step 1: Write failing contract and pagination tests**

Create a synthetic page with the exact observed envelope and all record keys. Assert that two injected pages produce one `RealPingCorpus`, that every request carries `X-API-Key`, `縣市`, `date_from`, `date_to`, `limit=1000`, and the correct `offset`, and that no returned diagnostic contains the key.

```ts
test('validates and paginates the observed RealPing transaction contract', async () => {
  const requests: Request[] = [];
  const corpus = await fetchRealPingCorpus(
    { city: '臺北市', dateFrom: '2025-01-01', dateTo: '2026-07-28' },
    'rp_secret_fixture',
    {
      cacheRoot: temporaryRoot,
      now: () => new Date('2026-07-29T00:00:00.000Z'),
      fetcher: async (input, init) => {
        requests.push(new Request(input, init));
        const offset = Number(new URL(String(input)).searchParams.get('offset'));
        return Response.json(realPingPage(offset));
      },
    },
  );

  assert.equal(corpus.records.length, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.headers.get('X-API-Key'), 'rp_secret_fixture');
  assert.ok(!JSON.stringify(corpus).includes('rp_secret_fixture'));
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test scripts/lib/market-data/realping-client.test.ts
```

Expected: FAIL because `realping-client.ts` and `fetchRealPingCorpus` do not exist.

- [ ] **Step 3: Implement strict envelope/record validation and pagination**

Accept nullable numeric content fields but require every documented key to be present. Reject unknown/missing envelope or record keys with `RealPingContractError`; never include record values or the key in the error. Use `URLSearchParams` for the Chinese query parameter and stop pagination only when accumulated records equal `total`.

- [ ] **Step 4: Add failing transport-policy tests**

Add separate tests proving:

- HTTP 401/403 throws `RealPingCredentialError` without retry.
- HTTP 429 throws `RealPingQuotaError` without retry.
- one network error or 5xx retries exactly once after 250 ms.
- a second transient failure, timeout, malformed JSON, or inconsistent `count`/`total` fails.
- the error string never contains the API key, authorization headers, response records, or addresses.

- [ ] **Step 5: Run the transport tests and verify RED**

Run the same focused command. Expected: FAIL on missing retry/error behavior.

- [ ] **Step 6: Implement timeout, bounded retry, fingerprints, and cache**

Use `AbortSignal.timeout(20_000)`. Compute SHA-256 over stable JSON for:

- schema fingerprint: sorted envelope and record key/type contract;
- request fingerprint: base URL plus non-secret query;
- response checksum: raw validated page content.

Write cache entries atomically under
`state/market-data/realping-cache/<requestFingerprint>-<schemaFingerprint>.json`.
On a valid cache hit, return it without HTTP. Reject a cache whose request,
schema fingerprint, checksum, or record contract differs. Do not put the key in
the filename or file content.

- [ ] **Step 7: Run focused and full tests**

Run:

```bash
node --import tsx --test scripts/lib/market-data/realping-client.test.ts
npm test
```

Expected: both exit `0`, with no live network access.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/market-data/realping-client.ts scripts/lib/market-data/realping-client.test.ts
git commit -m "feat: add strict RealPing transaction client"
```

---

### Task 2: Provider Adapter and Challenger Index

**Files:**

- Create: `scripts/lib/market-data/realping-adapter.ts`
- Test: `scripts/lib/market-data/realping-adapter.test.ts`

**Interfaces:**

- Consumes: `RealPingCorpus`, `RealPingRawRecord`, `DoorplateIndex`, `LocationEvidence`, `BuildingType`, and existing `locateAddress`, `normalizeOfficialBuildingType`, `gridKey`.
- Produces:

```ts
export interface RealPingComparable {
  localKey: string;
  transactionDate: string;
  sourcePeriod: string;
  originalAddress: string;
  location: LocationEvidence;
  district: string;
  buildingType: BuildingType;
  ageAtSaleYears: number;
  netBuildingAreaPing: number;
  buildingUnitPriceWan: number;
}

export interface RealPingComparableIndex {
  schemaVersion: 1;
  datasetVersion: string;
  builtAt: string;
  cells: Record<string, RealPingComparable[]>;
}

export interface RealPingAdapterDiagnostics {
  raw: number;
  included: number;
  exactDuplicates: number;
  excluded: number;
  excludedByReason: Record<string, number>;
}

export interface RealPingAdapterDependencies {
  hash?: (canonicalRecord: string) => string;
}

export function buildRealPingComparableIndex(
  corpus: RealPingCorpus,
  doorplates: DoorplateIndex,
  dependencies?: RealPingAdapterDependencies,
): { index: RealPingComparableIndex; diagnostics: RealPingAdapterDiagnostics };
```

- [ ] **Step 1: Write failing price-basis and quality tests**

Use records where `實坪單價_萬元坪` deliberately differs from
`去車位單價_萬元坪`. Assert the adapter stores only `去車位單價_萬元坪` and
`淨建坪`. Assert exclusion of non-residential use, special, parking-without-
price, multi-property, unusable unit price, abnormal date, missing age for
midrise/highrise, nonpositive net area, and unsupported building type.

```ts
test('maps only registered net ping and parking-removed unit price', () => {
  const { index, diagnostics } = buildRealPingComparableIndex(
    corpus(record({
      淨建坪: 30,
      去車位單價_萬元坪: 80,
      實坪: 20,
      實坪單價_萬元坪: 120,
    })),
    doorplates,
  );

  const comparable = Object.values(index.cells).flat()[0]!;
  assert.equal(comparable.netBuildingAreaPing, 30);
  assert.equal(comparable.buildingUnitPriceWan, 80);
  assert.equal(diagnostics.included, 1);
});
```

- [ ] **Step 2: Run the adapter test and verify RED**

Run:

```bash
node --import tsx --test scripts/lib/market-data/realping-adapter.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement strict normalization and doorplate location**

Normalize supported types through `normalizeOfficialBuildingType`. Require
`主要用途 === '住家用'`. Resolve `門牌` through `locateAddress`; accept
`exact-doorplate` and `address-range`, preserving uncertainty, and exclude
`unresolved`. Require the located district to equal provider `區`, and require
provider `縣市` to be exactly `臺北市`.

Apartment records may use age `0`; midrise/highrise require finite age `>= 0`.
Do not add any floor, total-floor, ownership, completion-date, parking, or
provider-ID property.

- [ ] **Step 4: Add failing deduplication and collision tests**

Assert:

- identical complete records collapse once;
- canonical JSON is stable regardless of object insertion order;
- two unequal records forced to the same injected hash throw
  `RealPingContractError`;
- each included comparable is stored under `gridKey(location.coordinate)`;
- diagnostics contain counts/reason names only, never addresses or rows.

- [ ] **Step 5: Run tests and verify RED, then implement local-key handling**

Run the focused test and confirm the new cases fail. Implement canonical
sorted-key JSON and SHA-256 local keys. Permit a test-only injected hasher in an
optional dependency object so collision behavior is deterministic.

- [ ] **Step 6: Run focused and full tests**

```bash
node --import tsx --test scripts/lib/market-data/realping-adapter.test.ts
npm test
```

Expected: both exit `0`.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/market-data/realping-adapter.ts scripts/lib/market-data/realping-adapter.test.ts
git commit -m "feat: normalize RealPing challenger comparables"
```

---

### Task 3: Reduced-Feature Geospatial Estimator

**Files:**

- Create: `scripts/lib/market-data/realping-estimator.ts`
- Test: `scripts/lib/market-data/realping-estimator.test.ts`

**Interfaces:**

- Consumes: `MarketSubject`, `EstimatorPolicy`, `RealPingComparableIndex`,
  `neighborGridKeys`, `haversineMeters`, `weightedMadOutliers`,
  `weightedQuantile`, existing confidence/IQR constants.
- Produces:

```ts
export interface RealPingComparableEvidence {
  comparable: RealPingComparable;
  distanceMinM: number;
  distanceMaxM: number;
  transactionAgeMonths: number;
  ageAtSubjectYears: number;
  weight: {
    distance: number;
    time: number;
    locationPrecision: number;
    area: number;
    buildingAge: number;
    total: number;
  };
}

export interface RealPingEstimate {
  status: 'reliable' | 'review' | 'unavailable';
  confidence: 'high' | 'medium' | 'low';
  marketUnitPriceMedian: number | null;
  marketUnitPriceP25: number | null;
  marketUnitPriceP75: number | null;
  selectedStage: number | null;
  unavailableReasons: string[];
  comparables: RealPingComparableEvidence[];
}

export function estimateRealPingMarket(
  subject: MarketSubject,
  index: RealPingComparableIndex,
  subjectDate: string,
  policy?: EstimatorPolicy,
): RealPingEstimate;
```

- [ ] **Step 1: Write failing selection tests**

Prove candidates are excluded when they are:

- on the subject date or later;
- outside district/type/radius;
- outside stage time/area tolerance;
- address-uncertainty minimum distance is outside the radius; or
- midrise/highrise age at the subject date exceeds the stage's 10/15-year
  tolerance.

Also prove that no fixture or result contains `floor`, `floorGroup`, or
`totalFloors` on a provider comparable/evidence object.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --import tsx --test scripts/lib/market-data/realping-estimator.test.ts
```

Expected: FAIL because the estimator does not exist.

- [ ] **Step 3: Implement date/age/stage selection**

Use the active policy stages unchanged. Select the first stage with at least
three qualifying comparables, or the last stage when none earlier reaches
three. Advance provider age with:

```ts
const ageAtSubjectYears =
  comparable.ageAtSaleYears +
  completeMonthsBetween(comparable.transactionDate, subjectDate) / 12;
```

For apartments set building-age weight to `1` and skip age tolerance, matching
production. Reject invalid subject dates and non-finite coordinates.

- [ ] **Step 4: Add failing weighting, outlier, and status tests**

Assert:

- distance/time/location/area/age weights multiply, with no floor factor;
- weighted-MAD outliers are excluded;
- median/P25/P75 use `weightedQuantile`;
- fewer than three post-outlier comparables yields `review`;
- stale state is not invented; provider fetch freshness is reported by the
  outer benchmark rather than estimator status;
- high confidence requires the production minimum comparable count,
  standard-class stage, and high IQR threshold;
- fallback stages never become high confidence.

- [ ] **Step 5: Run tests and verify RED, then implement estimation**

Run the focused command and confirm failures are caused by missing weighting and
status behavior. Implement only the specified reduced-feature estimate.

- [ ] **Step 6: Run focused and full tests**

```bash
node --import tsx --test scripts/lib/market-data/realping-estimator.test.ts
npm test
```

Expected: both exit `0`.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/market-data/realping-estimator.ts scripts/lib/market-data/realping-estimator.test.ts
git commit -m "feat: estimate with RealPing reduced-feature comparables"
```

---

### Task 4: Paired Held-Out Benchmark, Gate, and Redacted Artifact

**Files:**

- Create: `scripts/lib/market-data/realping-backtest.ts`
- Test: `scripts/lib/market-data/realping-backtest.test.ts`

**Interfaces:**

- Consumes: active official `TransactionIndex`, `RealPingComparableIndex`,
  `heldOutTransactionEligible`, `backtestSubjectFromTransaction`,
  `estimateMarket`, `estimateRealPingMarket`, `ACTIVE_ESTIMATOR_POLICY`.
- Produces:

```ts
export interface ChallengerMetrics {
  caseCount: number;
  estimatedCount: number;
  coverage: number;
  medianApe: number | null;
  p75Ape: number | null;
  byConfidence: Record<'high' | 'medium' | 'low', number>;
  unestimatedByReason: Record<string, number>;
}

export interface RealPingBenchmarkReport {
  schemaVersion: 1;
  asOf: string;
  evaluationFrom: string;
  evaluationTo: string;
  createdAt: string;
  policyId: string;
  provider: {
    source: string;
    fetchedAt: string;
    schemaFingerprint: string;
    requestFingerprint: string;
    responseChecksum: string;
  };
  official: ChallengerMetrics;
  challenger: ChallengerMetrics;
  pairedEstimatedCount: number;
  deltas: {
    coverage: number;
    medianApe: number | null;
    p75Ape: number | null;
  };
  outcome: 'pass' | 'fail' | 'inconclusive';
  reasons: string[];
  adapterDiagnostics: RealPingAdapterDiagnostics;
}

export function runRealPingBenchmark(
  officialIndex: TransactionIndex,
  challengerIndex: RealPingComparableIndex,
  corpus: RealPingCorpus,
  adapterDiagnostics: RealPingAdapterDiagnostics,
  options: { asOf: string; now?: () => Date },
): RealPingBenchmarkReport;

export async function writeRealPingBenchmarkReport(
  report: RealPingBenchmarkReport,
  root?: string,
): Promise<string>;
```

- [ ] **Step 1: Write failing leakage and denominator tests**

Create synthetic official held-out transactions and provider comparables on the
day before, same day, and day after each subject. Assert:

- both systems use the same `heldOutTransactionEligible` denominator;
- the earliest 12 provider months are warm-up only;
- held-out cases run from the day after the 12-month warm-up through the earlier
  of `asOf` and the latest provider transaction date;
- provider same-day/future records never become comparables;
- official estimates use only strictly earlier official transactions;
- the actual held-out price is passed only to scoring, never either estimator;
- case-level records are not part of `RealPingBenchmarkReport`.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --import tsx --test scripts/lib/market-data/realping-backtest.test.ts
```

Expected: FAIL because the paired runner does not exist.

- [ ] **Step 3: Implement paired evaluation and aggregate metrics**

Flatten and deduplicate the official index by ID, sort by date then ID, group by
date, and build the official historical grid only after evaluating the entire
date group. Score each median as `abs(predicted - actual) / actual`. Use
`weightedQuantile` with unit weights for median/P75 metrics. Keep transient
case keys and scores local to the function.

- [ ] **Step 4: Add failing decision-gate tests**

Cover exactly:

```ts
challenger.medianApe < official.medianApe
&& challenger.p75Ape < official.p75Ape
&& challenger.coverage >= official.coverage
```

Assert:

- all three true and paired count `>= 20` gives `pass`;
- either accuracy comparison false or coverage lower gives `fail`;
- missing metrics, zero eligible cases, paired count `< 20`, schema/adapter
  contract failure, or fewer than 20 high-confidence or 20 medium-confidence
  estimates in either system gives `inconclusive`;
- equality of an APE metric gives `fail`, not `pass`.

- [ ] **Step 5: Run tests and verify RED, then implement the gate**

Use `BACKTEST_ACCEPTANCE_THRESHOLDS.minimumConfidenceSliceCases` rather than a
new numeric constant.

- [ ] **Step 6: Add failing report-redaction and persistence tests**

Serialize a report built from fixtures whose raw records contain unique address
and price sentinels. Assert neither sentinel, `records`, `cases`, nor the API
key appears. Assert the artifact path is:

```text
<root>/<asOf>-<responseChecksum first 12 chars>.json
```

and that writes are atomic.

- [ ] **Step 7: Implement aggregate-only persistence and run tests**

```bash
node --import tsx --test scripts/lib/market-data/realping-backtest.test.ts
npm test
```

Expected: both exit `0`.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/market-data/realping-backtest.ts scripts/lib/market-data/realping-backtest.test.ts
git commit -m "feat: compare RealPing challenger with official estimates"
```

---

### Task 5: Standalone CLI, Documentation, and Live Smoke Benchmark

**Files:**

- Create: `scripts/realping-benchmark.ts`
- Create: `scripts/lib/realping-benchmark-cli.test.ts`
- Create: `docs/realping-benchmark.md`
- Modify: `.env.example`
- Modify: `package.json`
- Modify: `AGENTS.md`

**Interfaces:**

- CLI:

```text
npm run realping-benchmark -- --city taipei [--as-of YYYY-MM-DD]
```

- Exit codes: `0` only for `pass`; `1` for `fail`, `inconclusive`, provider,
  contract, or local-data failure; `2` for invalid CLI input.
- Dependencies:

```ts
export interface RealPingBenchmarkDependencies {
  loadBundle?: typeof loadMarketData;
  fetchCorpus?: typeof fetchRealPingCorpus;
  buildIndex?: typeof buildRealPingComparableIndex;
  benchmark?: typeof runRealPingBenchmark;
  persist?: typeof writeRealPingBenchmarkReport;
  now?: () => Date;
}

export async function runRealPingBenchmarkCommand(
  args: readonly string[],
  dependencies?: RealPingBenchmarkDependencies,
): Promise<number>;
```

- [ ] **Step 1: Write failing CLI tests**

Assert:

- only `--city taipei` and one optional valid `--as-of` are accepted;
- missing/empty `REALPING_API_KEY` fails before network work without printing
  secrets;
- the active Taipei bundle is loaded read-only and current policy provenance is
  checked;
- injected dependencies receive the expected date range and bundle;
- stdout contains only outcome, official/challenger aggregate metrics, reasons,
  and artifact path;
- exit code matches `pass`/`fail`/`inconclusive`.

- [ ] **Step 2: Run the CLI test and verify RED**

```bash
node --import tsx --test scripts/lib/realping-benchmark-cli.test.ts
```

Expected: FAIL because the CLI does not exist.

- [ ] **Step 3: Implement the standalone CLI**

Load `.env` with `process.loadEnvFile('.env')` when present. Load the active
bundle from `MARKET_DATA_ROOT`, call `assertCurrentMarketDataIndexPolicy`, and
fetch all provider records available through `dateTo = asOf` by omitting
`date_from`. The paired runner derives its exact 12-month warm-up and evaluation
range from the validated corpus. Use
`state/market-data/backtests/taipei/realping/` as the report root.

Catch input errors separately from provider/contract/runtime errors. Error
messages may contain category, HTTP status, and aggregate reason only.

- [ ] **Step 4: Add command and credential documentation**

Add to `.env.example`:

```dotenv
# RealPing API key for the standalone challenger benchmark (https://realping.tw/developers)
REALPING_API_KEY=
```

Add to `package.json`:

```json
"realping-benchmark": "tsx scripts/realping-benchmark.ts"
```

Document in `docs/realping-benchmark.md`:

- free-key setup;
- exact command and exit codes;
- registered-net-ping versus actual-interior-ping distinction;
- absence of provider floor evidence;
- cache/report locations;
- pass/fail/inconclusive gate;
- no automatic production effect; and
- safe deletion of git-ignored cache if a fresh provider fetch is required.

Add one standalone diagnostic bullet to `AGENTS.md` Tooling and add the new doc
to Source-Of-Truth Map. Do not add the command to Daily Run Sequence.

- [ ] **Step 5: Run focused, full, and type checks**

```bash
node --import tsx --test scripts/lib/realping-benchmark-cli.test.ts
npm test
npx tsc --noEmit
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 6: Run the manual live smoke benchmark**

With `REALPING_API_KEY` already present in the local `.env`, run:

```bash
npm run realping-benchmark -- --city taipei --as-of 2026-07-28
```

Expected:

- no address, raw transaction, case evidence, or API key appears on stdout or
  stderr;
- an aggregate JSON artifact is written under
  `state/market-data/backtests/taipei/realping/`;
- the command reports `pass`, `fail`, or `inconclusive` with both aggregate
  metric sets;
- exit `0` only when the outcome is `pass`.

If the command reports provider contract drift, quota exhaustion, insufficient
paired cases, or unavailable active market data, record the aggregate reason
and do not weaken validation to force a result.

- [ ] **Step 7: Inspect the generated artifact for redaction**

Run:

```bash
rg -n "門牌|交易日|去車位單價_萬元坪|rp_" state/market-data/backtests/taipei/realping
```

Expected: no matches. Then inspect the aggregate keys with:

```bash
jq 'keys' state/market-data/backtests/taipei/realping/*.json
```

Expected: only report-level keys defined by `RealPingBenchmarkReport`.

- [ ] **Step 8: Commit**

```bash
git add .env.example package.json AGENTS.md docs/realping-benchmark.md scripts/realping-benchmark.ts scripts/lib/realping-benchmark-cli.test.ts
git commit -m "feat: add standalone RealPing challenger benchmark"
```

---

## Final Verification

- [ ] Run the complete automated verification:

```bash
npm test
npx tsc --noEmit
git diff --check
git status --short
```

- [ ] Confirm every new production function has a test that was observed
  failing before implementation.
- [ ] Confirm no tracked file contains the real key:

```bash
git grep -n "REALPING_API_KEY=" -- ':!*.example'
git grep -n "rp_"
```

Expected: the first command has no matches; the second has no real-key match
(synthetic test sentinels must use a visibly fake value such as
`rp_secret_fixture`).

- [ ] Confirm production estimator identity is unchanged:

```bash
git diff HEAD~5 -- scripts/lib/market-data/config.ts scripts/lib/market-data/selector.ts scripts/lib/market-data/estimator.ts scripts/lib/steps.ts
```

Expected: no production-estimator changes introduced by this feature.

- [ ] Review the implementation against
  `docs/superpowers/specs/2026-07-29-realping-challenger-design.md`, especially
  price basis, no-floor evidence, held-out cutoff, aggregate-only output, and
  non-automatic production behavior.
