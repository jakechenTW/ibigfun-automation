import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridKey } from './grid.ts';
import { estimateMarketScenarios } from './scenario-estimator.ts';
import type {
  BacktestAcceptance,
  MarketTransaction,
  NormalizedPrimaryUse,
  ScenarioMarketSubject,
  SourceFreshness,
  TransactionIndex,
} from './types.ts';

const AS_OF = '2026-01-31';
const coordinate = { lat: 25.033964, lng: 121.564468 };

const fresh: SourceFreshness = {
  transactionCheckedAt: '2026-01-31T00:00:00.000Z',
  doorplateCheckedAt: '2026-01-31T00:00:00.000Z',
  transactionStale: false,
  doorplateStale: false,
};

const acceptance: BacktestAcceptance = {
  schemaVersion: 2,
  estimatorPolicyVersion: 4,
  policyId: 'baseline',
  transactionArtifactSha256: 'fixture',
  approvedAt: '2026-01-31T00:00:00.000Z',
  asOf: AS_OF,
  evaluatedThrough: '2026-01-30',
  latestEligibleTransactionDate: '2026-01-30',
  thresholds: {
    medianApeMax: 0.12,
    p75ApeMax: 0.20,
    minimumEstimateCoverage: 0.70,
    minimumConfidenceSliceCases: 20,
    minimumHighConfidenceImprovement: 0.01,
  },
  metrics: {
    estimateCoverage: 0.80,
    reliableEstimatedCount: 100,
    reliableMedianApe: 0.08,
    reliableP75Ape: 0.16,
    highConfidenceEstimatedCount: 50,
    highConfidenceMedianApe: 0.06,
    mediumConfidenceEstimatedCount: 50,
    mediumConfidenceMedianApe: 0.10,
  },
};

const unknownUseSubject: ScenarioMarketSubject = {
  listingId: 1,
  coordinate,
  matchedAddress: '台北市中正區測試路1號',
  district: '中正區',
  ownership: 'freehold',
  buildingType: 'midrise',
  totalAreaPing: 30,
  askingTotalPriceNtd: 30_000_000,
  floor: 5,
  totalFloors: 10,
  floorGroup: 'middle',
  ageYears: 15,
  registeredUse: { value: 'unknown', source: 'unknown', detail: null },
  parkingFamily: 'none',
  parkingCount: 0,
};

const originalUse: Record<Exclude<NormalizedPrimaryUse, 'unknown'>, string> = {
  residential: '住家用',
  'mixed-residential': '住商用',
  office: '辦公用',
  commercial: '商業用',
  industrial: '工業用',
  'mixed-industrial': '住工用',
};

function transaction(
  id: string,
  primaryUse: Exclude<NormalizedPrimaryUse, 'unknown'>,
  unitPriceWan: number,
  overrides: Partial<MarketTransaction> = {},
): MarketTransaction {
  return {
    id,
    transactionDate: '2025-12-15',
    sourceVersion: 'fixture',
    originalAddress: '台北市中正區測試路1號',
    location: {
      method: 'exact-doorplate',
      coordinate,
      normalizedAddress: '台北市中正區測試路1號',
      matchedAddress: '台北市中正區測試路1號',
      uncertaintyMeters: 0,
      confidence: 'high',
      datasetVersion: 'fixture',
    },
    district: '中正區',
    ownership: 'freehold',
    buildingType: 'midrise',
    totalPriceNtd: unitPriceWan * 300_000,
    totalAreaPing: 30,
    buildingPriceNtd: unitPriceWan * 300_000,
    buildingAreaPing: 30,
    parkingPriceNtd: 0,
    parkingAreaPing: 0,
    buildingUnitPriceWan: unitPriceWan,
    parkingEvidence: {
      grade: 'A', family: 'none', originalType: '無車位',
      officialPriceNtd: 0, officialAreaPing: 0, imputation: null, reasons: [],
    },
    floor: 5,
    totalFloors: 10,
    floorGroup: 'middle',
    completionDate: '2011-01-01',
    notes: '',
    exclusionFlags: [],
    eligibility: primaryUse === 'residential' ? 'reliable-eligible' : 'review-only',
    eligibilityReasons: primaryUse === 'residential' ? [] : ['scenario-only-primary-use'],
    originalPrimaryUse: originalUse[primaryUse],
    primaryUse,
    transferredBuildingCount: 1,
    ...overrides,
  };
}

function indexWithTransactions(transactions: readonly MarketTransaction[]): TransactionIndex {
  return {
    schemaVersion: 1,
    datasetVersion: 'fixture',
    builtAt: '2026-01-31T00:00:00.000Z',
    cells: { [gridKey(coordinate)]: [...transactions] },
  };
}

function allUseTransactions(): MarketTransaction[] {
  const uses: Array<Exclude<NormalizedPrimaryUse, 'unknown'>> = [
    'residential', 'mixed-residential', 'office', 'commercial', 'industrial', 'mixed-industrial',
  ];
  return uses.flatMap((primaryUse) => [99, 100, 101].map((price, index) =>
    transaction(`${primaryUse}-${index}`, primaryUse, price),
  ));
}

test('unknown registered use emits every exact-use scenario in stable order and never marks one reliable', () => {
  const unknown = estimateMarketScenarios(
    unknownUseSubject,
    indexWithTransactions(allUseTransactions()),
    fresh,
    AS_OF,
    acceptance,
  );

  assert.deepEqual(unknown.scenarios.map((scenario) => scenario.primaryUse), [
    'residential', 'mixed-residential', 'office', 'commercial', 'industrial', 'mixed-industrial',
  ]);
  assert.ok(unknown.scenarios.every((scenario) => scenario.role === 'unknown-use-scenario'));
  assert.ok(unknown.scenarios.every((scenario) => scenario.status !== 'reliable'));
  assert.equal(unknown.scenarios[0]?.status, 'review');
});

test('verified non-residential use emits its primary scenario before a residential comparison', () => {
  const verifiedOffice = estimateMarketScenarios(
    {
      ...unknownUseSubject,
      registeredUse: { value: 'office', source: 'official', detail: '使用執照' },
    },
    indexWithTransactions(allUseTransactions()),
    fresh,
    AS_OF,
    acceptance,
  );

  assert.deepEqual(verifiedOffice.scenarios.map((scenario) => [scenario.primaryUse, scenario.role]), [
    ['office', 'primary'],
    ['residential', 'residential-comparison'],
  ]);
});

test('schema-2 extras cannot activate office cohorts or grade-B building evidence', () => {
  const injectedSchema2 = {
    ...acceptance,
    useCohorts: {
      residential: { status: 'accepted' },
      office: { status: 'accepted' },
    },
    parkingImputationAccepted: true,
  } as BacktestAcceptance & {
    useCohorts: Record<string, { status: string }>;
    parkingImputationAccepted: boolean;
  };
  const office = estimateMarketScenarios(
    {
      ...unknownUseSubject,
      registeredUse: { value: 'office', source: 'official', detail: '使用執照' },
    },
    indexWithTransactions(allUseTransactions()),
    fresh,
    AS_OF,
    injectedSchema2,
  );
  assert.equal(office.scenarios[0]?.status, 'diagnostic-only');
  assert.ok(office.scenarios[0]?.reasons.includes('use-cohort-not-accepted'));

  const imputation = {
    asOf: '2025-12-15',
    stage: 'nearby-500m' as const,
    comparableIds: ['parking-a', 'parking-b', 'parking-c'],
    comparableCount: 3,
    priceP25Ntd: 1_800_000,
    priceP50Ntd: 2_000_000,
    priceP75Ntd: 2_200_000,
    areaP25Ping: 9,
    areaP50Ping: 10,
    areaP75Ping: 11,
  };
  const gradeB = [99, 100, 101].map((price, index) => transaction(`grade-b-${index}`, 'residential', price, {
    eligibility: 'review-only',
    eligibilityReasons: ['parking-not-separable'],
    parkingEvidence: {
      grade: 'B', family: 'flat', originalType: '坡道平面',
      officialPriceNtd: null, officialAreaPing: null, imputation, reasons: ['parking-not-separable'],
    },
  }));
  const residential = estimateMarketScenarios(
    {
      ...unknownUseSubject,
      registeredUse: { value: 'residential', source: 'official', detail: '使用執照' },
    },
    indexWithTransactions(gradeB),
    fresh,
    AS_OF,
    injectedSchema2,
  );
  assert.equal(residential.scenarios[0]?.status, 'insufficient-sample');
  assert.equal(residential.scenarios[0]?.marketUnitPriceMedian, null);
  assert.equal(residential.scenarios[0]?.gradeCounts.B, 0);
});

test('insufficient exact-use cohorts stay visible with null quantiles', () => {
  const result = estimateMarketScenarios(
    unknownUseSubject,
    indexWithTransactions([]),
    fresh,
    AS_OF,
    acceptance,
  );

  assert.equal(result.scenarios.length, 6);
  for (const scenario of result.scenarios) {
    assert.equal(scenario.status, 'insufficient-sample');
    assert.equal(scenario.marketUnitPriceP25, null);
    assert.equal(scenario.marketUnitPriceMedian, null);
    assert.equal(scenario.marketUnitPriceP75, null);
    assert.equal(scenario.bundleValue, null);
    assert.ok(scenario.reasons.includes('bundle-evidence-insufficient'));
  }
});

test('scenario estimation applies weighted MAD before publishing exact-use quantiles', () => {
  const transactions = [99, 100, 101, 102, 1_000].map((price, index) =>
    transaction(`residential-${index}`, 'residential', price),
  );
  const result = estimateMarketScenarios(
    { ...unknownUseSubject, registeredUse: { value: 'residential', source: 'manual', detail: '人工確認' } },
    indexWithTransactions(transactions),
    fresh,
    AS_OF,
    acceptance,
  );

  assert.equal(result.scenarios[0]?.comparables.length, 4);
  assert.ok(!result.scenarios[0]?.comparables.some((candidate) => candidate.transaction.id === 'residential-4'));
  assert.equal(result.scenarios[0]?.marketUnitPriceMedian, 100.5);
  assert.equal(result.scenarios[0]?.status, 'reliable');
});

test('invalid subject coordinates return unavailable scenarios without entering geospatial selection', () => {
  const result = estimateMarketScenarios(
    { ...unknownUseSubject, coordinate: { lat: Number.NaN, lng: coordinate.lng } },
    indexWithTransactions(allUseTransactions()),
    fresh,
    AS_OF,
    acceptance,
  );

  assert.ok(result.scenarios.every((scenario) => scenario.status === 'unavailable'));
  assert.ok(result.scenarios.every((scenario) => scenario.reasons.includes('location-unreliable')));
});

test('invalid asking totals cannot leak NaN into a scenario premium', () => {
  const result = estimateMarketScenarios(
    {
      ...unknownUseSubject,
      askingTotalPriceNtd: Number.NaN,
      registeredUse: { value: 'residential', source: 'official', detail: '使用執照' },
    },
    indexWithTransactions([99, 100, 101].map((price, index) =>
      transaction(`residential-${index}`, 'residential', price),
    )),
    fresh,
    AS_OF,
    acceptance,
  );

  assert.equal(result.scenarios[0]?.askingPremiumConservative, null);
  assert.equal(result.scenarios[0]?.status, 'review');
});

test('a required but unavailable parking model prevents a reliable scenario', () => {
  const result = estimateMarketScenarios(
    {
      ...unknownUseSubject,
      totalAreaPing: 40,
      registeredUse: { value: 'residential', source: 'official', detail: '使用執照' },
      parkingFamily: 'flat',
      parkingCount: 1,
    },
    indexWithTransactions([99, 100, 101].map((price, index) =>
      transaction(`residential-${index}`, 'residential', price),
    )),
    fresh,
    AS_OF,
    acceptance,
  );

  assert.equal(result.scenarios[0]?.parkingEstimate, null);
  assert.equal(result.scenarios[0]?.bundleValue, null);
  assert.ok(result.scenarios[0]?.reasons.includes('parking-estimate-unavailable'));
  assert.equal(result.scenarios[0]?.status, 'review');
});

test('invalid runtime parking counts fail closed before scenario derivation', () => {
  const transactions = [99, 100, 101].map((price, index) =>
    transaction(`residential-${index}`, 'residential', price),
  );
  for (const parkingCount of [Number.NaN, -1, 0.5, 3]) {
    const malformedSubject = {
      ...unknownUseSubject,
      registeredUse: { value: 'residential', source: 'official', detail: '使用執照' },
      parkingFamily: 'flat',
      parkingCount,
    } as unknown as ScenarioMarketSubject;
    const result = estimateMarketScenarios(
      malformedSubject,
      indexWithTransactions(transactions),
      fresh,
      AS_OF,
      acceptance,
    );
    assert.ok(result.scenarios.every((scenario) => scenario.status === 'unavailable'), String(parkingCount));
    assert.ok(result.scenarios.every((scenario) => scenario.reasons.includes('invalid-parking-count')), String(parkingCount));
  }
});

test('parking-family-incompatible counts fail closed before scenario derivation', () => {
  const transactions = [99, 100, 101].map((price, index) =>
    transaction(`residential-${index}`, 'residential', price),
  );
  const invalidPairs = [
    { parkingFamily: 'none', parkingCount: 1 },
    { parkingFamily: 'flat', parkingCount: 0 },
    { parkingFamily: 'mechanical', parkingCount: 0 },
    { parkingFamily: 'unknown', parkingCount: 1 },
  ] as const;
  for (const pair of invalidPairs) {
    const result = estimateMarketScenarios(
      {
        ...unknownUseSubject,
        registeredUse: { value: 'residential', source: 'official', detail: '使用執照' },
        ...pair,
      },
      indexWithTransactions(transactions),
      fresh,
      AS_OF,
      acceptance,
    );
    assert.ok(result.scenarios.every((scenario) => scenario.status === 'unavailable'), JSON.stringify(pair));
    assert.ok(result.scenarios.every((scenario) => scenario.reasons.includes('parking-count-family-conflict')), JSON.stringify(pair));
  }
});

test('three grade-C bundle observations outside the paired interval force review', () => {
  const direct = [99, 100, 101].map((price, index) => transaction(`direct-${index}`, 'residential', price, {
    totalPriceNtd: price * 300_000 + (2_000_000 + index * 100_000),
    totalAreaPing: 40,
    buildingPriceNtd: price * 300_000,
    buildingAreaPing: 30,
    parkingPriceNtd: 2_000_000 + index * 100_000,
    parkingAreaPing: 10,
    parkingEvidence: {
      grade: 'A', family: 'flat', originalType: '坡道平面',
      officialPriceNtd: 2_000_000 + index * 100_000,
      officialAreaPing: 10,
      imputation: null,
      reasons: [],
    },
  }));
  const bundleOnly = [0, 1, 2].map((index) => transaction(`bundle-${index}`, 'residential', 100, {
    totalPriceNtd: 100_000_000 + index * 1_000_000,
    totalAreaPing: 40,
    buildingPriceNtd: null,
    buildingAreaPing: null,
    buildingUnitPriceWan: null,
    parkingPriceNtd: null,
    parkingAreaPing: null,
    parkingEvidence: {
      grade: 'C', family: 'unknown', originalType: '',
      officialPriceNtd: null, officialAreaPing: null, imputation: null, reasons: ['parking-family-unknown'],
    },
  }));
  const result = estimateMarketScenarios(
    {
      ...unknownUseSubject,
      totalAreaPing: 40,
      askingTotalPriceNtd: 32_000_000,
      registeredUse: { value: 'residential', source: 'official', detail: '使用執照' },
      parkingFamily: 'flat',
      parkingCount: 1,
    },
    indexWithTransactions([...direct, ...bundleOnly]),
    fresh,
    AS_OF,
    acceptance,
  );

  const scenario = result.scenarios[0];
  assert.ok(scenario?.parkingEstimate);
  assert.ok(scenario?.bundleValue);
  assert.equal(scenario?.bundleComparables.length, 3);
  assert.ok(scenario?.reasons.includes('bundle-evidence-conflicts'));
  assert.equal(scenario?.status, 'review');
});
