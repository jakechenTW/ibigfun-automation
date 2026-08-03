import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  attachMarketEstimates,
  labelLegacyCompatibilityEstimate,
  listingParkingFamily,
} from '../steps.ts';
import type { PreMarketEnrichedListing } from '../types.ts';
import {
  ACTIVE_ESTIMATOR_POLICY,
  ESTIMATOR_POLICY_VERSION,
  MARKET_SCHEMA_VERSION,
} from './config.ts';
import type { BacktestAcceptance, MarketDataBundle } from './types.ts';

const AS_OF = '2026-07-25';
const bundle = JSON.parse(
  readFileSync(new URL('./fixtures/enriched-market-index.json', import.meta.url), 'utf8'),
) as MarketDataBundle;

for (const transactions of Object.values(bundle.transactions.cells)) {
  for (const transaction of transactions) {
    transaction.eligibility = 'reliable-eligible';
    transaction.eligibilityReasons = [];
    transaction.totalAreaPing = transaction.buildingAreaPing!;
    transaction.parkingEvidence = {
      grade: 'A',
      family: 'none',
      originalType: '無車位',
      officialPriceNtd: null,
      officialAreaPing: null,
      imputation: null,
      reasons: [],
    };
    transaction.originalPrimaryUse = '住家用';
    transaction.primaryUse = 'residential';
    transaction.transferredBuildingCount = 1;
  }
}

function bundleWithAcceptance(transactionArtifactSha256 = 'a'.repeat(64)): MarketDataBundle {
  const accepted = structuredClone(bundle);
  accepted.manifest.schemaVersion = MARKET_SCHEMA_VERSION;
  accepted.manifest.estimatorPolicyVersion = ESTIMATOR_POLICY_VERSION;
  accepted.doorplates.schemaVersion = MARKET_SCHEMA_VERSION;
  accepted.transactions.schemaVersion = MARKET_SCHEMA_VERSION;
  accepted.manifest.artifacts['transactions-index.json'] = {
    sha256: 'a'.repeat(64),
    bytes: 1,
  };
  const diagnosticOnly = {
    status: 'diagnostic-only' as const,
    scoredCases: 0,
    estimateCoverage: 0,
    medianApe: null,
    p75Ape: null,
    bias: null,
    intervalCoverage: null,
    reasons: ['insufficient-use-cohort-cases', 'incomplete-use-cohort-metrics'],
  };
  const acceptedCohort = {
    status: 'accepted' as const,
    scoredCases: 20,
    estimateCoverage: 0.8,
    medianApe: 0.08,
    p75Ape: 0.16,
    bias: 0,
    intervalCoverage: 0.8,
    reasons: [],
  };
  accepted.backtestAcceptance = {
    schemaVersion: 3,
    estimatorPolicyVersion: ESTIMATOR_POLICY_VERSION,
    policyId: ACTIVE_ESTIMATOR_POLICY.id,
    transactionArtifactSha256,
    approvedAt: '2026-07-25T01:00:00.000Z',
    asOf: AS_OF,
    evaluatedThrough: AS_OF,
    latestEligibleTransactionDate: '2026-01-25',
    thresholds: {
      medianApeMax: 0.12,
      p75ApeMax: 0.20,
      minimumEstimateCoverage: 0.70,
      minimumConfidenceSliceCases: 20,
      minimumHighConfidenceImprovement: 0.01,
      minimumUseCohortCases: 20,
      maximumAbsoluteBiasRegression: 0.01,
      maximumIntervalCoverageRegression: 0.05,
    },
    metrics: {
      estimateCoverage: 0.8,
      reliableEstimatedCount: 40,
      reliableMedianApe: 0.08,
      reliableP75Ape: 0.16,
      highConfidenceEstimatedCount: 20,
      highConfidenceMedianApe: 0.07,
      mediumConfidenceEstimatedCount: 20,
      mediumConfidenceMedianApe: 0.09,
    },
    useCohorts: {
      commercial: { ...diagnosticOnly },
      industrial: { ...diagnosticOnly },
      'mixed-industrial': { ...diagnosticOnly },
      'mixed-residential': { ...diagnosticOnly },
      office: { ...diagnosticOnly },
      residential: { ...acceptedCohort },
    },
    parkingImputationAccepted: true,
    parkingComparison: {
      directCoverage: 0.70,
      imputedCoverage: 0.71,
      directMedianApe: 0.10,
      imputedMedianApe: 0.11,
      directP75Ape: 0.18,
      imputedP75Ape: 0.19,
      biasRegression: 0.01,
      intervalCoverageRegression: 0.05,
    },
  } satisfies BacktestAcceptance;
  return accepted;
}

function listing(overrides: Partial<PreMarketEnrichedListing> = {}): PreMarketEnrichedListing {
  return {
    id: 1,
    title: '測試華廈',
    url: null,
    addressOrArea: '台北市中正區測試路1號',
    nearbyStation: null,
    coordinate: { lat: 25.033964, lng: 121.564468 },
    publishedDate: null,
    totalPrice: '3000萬',
    totalPing: '30坪',
    unitPrice: '100萬/坪',
    floor: '5',
    totalFloors: '10',
    typeLayout: '3房2廳',
    age: '15',
    parking: '無車位',
    realPriceUrl: null,
    listingHistory: [],
    source: null,
    sourceLink: null,
    room: 3,
    livingRoom: 2,
    bathroom: 2,
    queryHouseType: '17',
    buildingType: 'midrise',
    totalPriceWan: 3000,
    totalPriceNtd: 30_000_000,
    totalPingNum: 30,
    unitPriceWan: 100,
    ageNum: 15,
    monthlyMortgage: 96_000,
    district: '中正區',
    walk: null,
    withinWalk: null,
    regionGate: 'review',
    reliability: { coordPresent: true, coordConsistent: true, routeOk: null, ratio: null, reason: null },
    signals: { auctionKeyword: false },
    hardExclusion: { excluded: false, reasons: [] },
    tenure: { firstListedDate: null, daysOnMarket: null, recordCount: 0, sourceCount: 0, priceTrend: 'unknown', firstPrice: null, latestPrice: null },
    ...overrides,
  };
}

test('maps listing parking labels to strict scenario families', () => {
  assert.equal(listingParkingFamily('平面'), 'flat');
  assert.equal(listingParkingFamily('機械'), 'mechanical');
  assert.equal(listingParkingFamily('無車位'), 'none');
  assert.equal(listingParkingFamily(null), 'unknown');
});

test('scenario output becomes authoritative while unknown-use legacy output stays compatibility-only', () => {
  const [unapproved] = attachMarketEstimates([listing()], bundle, AS_OF);
  const [mismatched] = attachMarketEstimates([listing()], bundleWithAcceptance('different-dataset'), AS_OF);
  const policyV2Bundle = bundleWithAcceptance();
  policyV2Bundle.backtestAcceptance!.estimatorPolicyVersion = 2;
  const [policyV2] = attachMarketEstimates([listing()], policyV2Bundle, AS_OF);
  const staleCoverageBundle = bundleWithAcceptance();
  const cell = Object.keys(staleCoverageBundle.transactions.cells)[0]!;
  staleCoverageBundle.transactions.cells[cell]!.push({
    ...structuredClone(staleCoverageBundle.transactions.cells[cell]![0]!),
    id: 'newer-transaction',
    transactionDate: '2026-07-01',
  });
  const [staleCoverage] = attachMarketEstimates([listing()], staleCoverageBundle, AS_OF);
  const [result] = attachMarketEstimates([listing()], bundleWithAcceptance(), AS_OF);

  assert.equal(unapproved.marketEstimate.status, 'review');
  assert.ok(unapproved.marketEstimate.unavailableReasons.includes('market-backtest-not-approved'));
  assert.equal(mismatched.marketEstimate.status, 'review');
  assert.equal(policyV2.marketEstimate.status, 'review');
  assert.ok(policyV2.marketEstimate.unavailableReasons.includes('market-backtest-not-approved'));
  assert.equal(staleCoverage.marketEstimate.status, 'review');
  assert.ok(staleCoverage.marketEstimate.unavailableReasons.includes('market-backtest-not-approved'));
  assert.equal(result.marketEstimate.status, 'review');
  assert.ok(result.marketEstimate.unavailableReasons.includes(
    'legacy-residential-baseline-not-authoritative',
  ));
  assert.equal(result.marketEstimate.comparables.length, 5);
  assert.equal(result.marketEstimate.selectedStage, 1);
  assert.equal(result.marketEstimate.subjectOwnershipEvidence, 'profile-default-freehold');
  const residentialScenario = result.marketScenarios.scenarios.find(
    (scenario) => scenario.primaryUse === 'residential',
  );
  assert.equal(residentialScenario?.status, 'review');
  assert.equal(typeof residentialScenario?.marketUnitPriceP25, 'number');
  assert.equal(residentialScenario?.reasons.includes('use-cohort-not-accepted'), false);
  const evidence = result.marketEstimate.subjectLocationEvidence;
  assert.equal(evidence?.verdict, 'matched');
  assert.equal(evidence?.address.method, 'exact-doorplate');
  assert.ok((evidence?.addressDistanceMeters ?? Infinity) < 1);
});

test('one listing batch scans acceptance coverage exactly once', () => {
  const diagnostics = { eligibleTransactionScans: 0 };
  const listings = Array.from({ length: 5 }, (_, index) => listing({ id: index + 1 }));

  const results = attachMarketEstimates(listings, bundleWithAcceptance(), AS_OF, diagnostics);

  assert.ok(results.every((result) => result.marketEstimate.status === 'review'));
  assert.ok(results.every((result) => result.marketEstimate.unavailableReasons.includes(
    'legacy-residential-baseline-not-authoritative',
  )));
  assert.equal(diagnostics.eligibleTransactionScans, 1);
});

test('an imputed parking component keeps the legacy baseline non-authoritative even for verified use', () => {
  const [attached] = attachMarketEstimates([listing()], bundleWithAcceptance(), AS_OF);
  const scenarios = structuredClone(attached.marketScenarios);
  scenarios.registeredUse = {
    value: 'residential',
    source: 'official',
    detail: 'synthetic verified use',
  };
  const residential = scenarios.scenarios.find((scenario) => scenario.primaryUse === 'residential');
  assert.ok(residential);
  residential.parkingEstimate = {
    asOf: AS_OF,
    stage: 'same-building',
    comparableIds: ['synthetic-a', 'synthetic-b', 'synthetic-c'],
    comparableCount: 3,
    priceP25Ntd: 2_000_000,
    priceP50Ntd: 2_200_000,
    priceP75Ntd: 2_400_000,
    areaP25Ping: 9,
    areaP50Ping: 10,
    areaP75Ping: 11,
  };

  const legacy = labelLegacyCompatibilityEstimate({
    ...attached.marketEstimate,
    status: 'reliable',
    unavailableReasons: [],
  }, scenarios);

  assert.equal(legacy.status, 'review');
  assert.ok(legacy.unavailableReasons.includes(
    'legacy-residential-baseline-not-authoritative',
  ));
});

test('a known use value from an unknown source keeps the legacy baseline non-authoritative', () => {
  const [attached] = attachMarketEstimates([listing()], bundleWithAcceptance(), AS_OF);
  const scenarios = structuredClone(attached.marketScenarios);
  scenarios.registeredUse = {
    value: 'residential',
    source: 'unknown',
    detail: null,
  };
  assert.ok(scenarios.scenarios.every((scenario) => scenario.parkingEstimate === null));

  const legacy = labelLegacyCompatibilityEstimate({
    ...attached.marketEstimate,
    status: 'reliable',
    unavailableReasons: [],
  }, scenarios);

  assert.equal(legacy.status, 'review');
  assert.ok(legacy.unavailableReasons.includes(
    'legacy-residential-baseline-not-authoritative',
  ));
});

test('same-district wrong-neighborhood GPS pin cannot receive an automatic estimate', () => {
  const [result] = attachMarketEstimates([
    listing({
      coordinate: { lat: 25.033964, lng: 121.574468 },
      reliability: { coordPresent: true, coordConsistent: true, routeOk: true, ratio: 1.2, reason: null },
    }),
  ], bundle, AS_OF);

  assert.equal(result.marketEstimate.status, 'unavailable');
  assert.deepEqual(result.marketEstimate.unavailableReasons, [
    'listing-coordinate-address-conflict',
    'legacy-residential-baseline-not-authoritative',
  ]);
  const evidence = result.marketEstimate.subjectLocationEvidence;
  assert.equal(evidence?.verdict, 'conflict');
  assert.ok((evidence?.distanceBeyondUncertaintyMeters ?? 0) > 300);
  assert.equal(evidence?.nearestDoorplate.matchedAddress, '台北市中正區另一街99號');
});

test('masked listing address preserves range uncertainty and stays review-only without a false conflict', () => {
  const [result] = attachMarketEstimates([
    listing({ addressOrArea: '台北市中正區測試路1~30號' }),
  ], bundle, AS_OF);

  assert.equal(result.marketEstimate.status, 'review');
  assert.ok(result.marketEstimate.unavailableReasons.includes('listing-address-range-uncertain'));
  const evidence = result.marketEstimate.subjectLocationEvidence;
  assert.equal(evidence?.verdict, 'uncertain');
  assert.equal(evidence?.address.method, 'address-range');
  assert.ok((evidence?.address.uncertaintyMeters ?? 0) > 0);
  assert.ok((evidence?.distanceBeyondUncertaintyMeters ?? Infinity) <= 300);
});

test('incomplete unresolved listing address stays review-only when the reverse road still matches', () => {
  const [result] = attachMarketEstimates([
    listing({ addressOrArea: '台北市中正區測試路' }),
  ], bundle, AS_OF);

  assert.equal(result.marketEstimate.status, 'review');
  assert.ok(result.marketEstimate.unavailableReasons.includes('listing-address-location-unresolved'));
  const evidence = result.marketEstimate.subjectLocationEvidence;
  assert.equal(evidence?.verdict, 'uncertain');
  assert.equal(evidence?.address.method, 'unresolved');
  assert.equal(evidence?.nearestDoorplate.matchedAddress, '台北市中正區測試路1號');
});

test('untyped and unreliable GPS listings stay unavailable', () => {
  const untyped = attachMarketEstimates([listing({ queryHouseType: null, buildingType: null })], bundle, AS_OF)[0]!;
  const unreliable = attachMarketEstimates([
    listing({ reliability: { coordPresent: true, coordConsistent: false, routeOk: null, ratio: null, reason: 'district mismatch' } }),
  ], bundle, AS_OF)[0]!;

  assert.deepEqual(untyped.marketEstimate.unavailableReasons, [
    'listing-building-type-unavailable',
    'legacy-residential-baseline-not-authoritative',
  ]);
  assert.deepEqual(unreliable.marketEstimate.unavailableReasons, [
    'listing-coordinate-unreliable',
    'legacy-residential-baseline-not-authoritative',
  ]);
});

test('known listing parking gets a one-space authoritative scenario and a labeled legacy review', () => {
  const [result] = attachMarketEstimates([listing({ parking: '平面' })], bundle, AS_OF);

  assert.equal(result.marketEstimate.status, 'review');
  assert.deepEqual(result.marketEstimate.unavailableReasons, [
    'listing-parking-not-separable',
    'legacy-residential-baseline-not-authoritative',
  ]);
  assert.equal(result.marketScenarios.parkingFamily, 'flat');
  assert.equal(result.marketScenarios.parkingCountAssumption, 1);
  assert.ok(result.marketScenarios.scenarios.length > 0);
});

test('known parking preserves the legacy parking review when scenario floor data is missing', () => {
  const [result] = attachMarketEstimates([listing({ parking: '平面', floor: null })], bundle, AS_OF);

  assert.equal(result.marketEstimate.status, 'review');
  assert.deepEqual(result.marketEstimate.unavailableReasons, [
    'listing-parking-not-separable',
    'legacy-residential-baseline-not-authoritative',
  ]);
  assert.ok(result.marketScenarios.reasons.includes('listing-floor-group-unavailable'));
  assert.ok(result.marketScenarios.scenarios.every((scenario) => scenario.status === 'unavailable'));
});

test('no-parking listing gets an explicit zero-space scenario assumption', () => {
  const [result] = attachMarketEstimates([listing({ parking: '無車位' })], bundle, AS_OF);

  assert.equal(result.marketScenarios.parkingFamily, 'none');
  assert.equal(result.marketScenarios.parkingCountAssumption, 0);
});

test('local scenario comparables carry official query locators', () => {
  const [result] = attachMarketEstimates([listing()], bundle, AS_OF);
  const comparable = result.marketScenarios.scenarios
    .flatMap((scenario) => [...scenario.comparables, ...scenario.bundleComparables])[0];

  assert.deepEqual(comparable?.officialLocator, {
    queryUrl: 'https://lvr.land.moi.gov.tw/',
    district: '中正區',
    addressOrRoad: '台北市中正區測試路1號',
    transactionMonth: '2026-01',
    floor: 5,
    totalPriceNtd: 28_800_000,
    totalAreaPing: 30,
  });
});

test('unknown listing parking keeps count and price unknown with low-confidence evidence', () => {
  const [result] = attachMarketEstimates([listing({ parking: '另洽' })], bundle, AS_OF);

  assert.equal(result.marketScenarios.parkingFamily, 'unknown');
  assert.equal(result.marketScenarios.parkingCountAssumption, null);
  assert.ok(result.marketScenarios.reasons.includes('parking-family-unknown'));
  assert.ok(result.marketScenarios.scenarios.every((scenario) => scenario.confidence === 'low'));
  assert.ok(result.marketScenarios.scenarios.every((scenario) => scenario.parkingEstimate === null));
  assert.ok(result.marketScenarios.scenarios.every((scenario) => scenario.bundleValue === null));
});

test('unknown parking retains subject evidence in unavailable scenarios without market data', () => {
  const [result] = attachMarketEstimates([listing({ parking: null })], null, AS_OF);

  assert.ok(result.marketScenarios.reasons.includes('market-data-unavailable'));
  assert.ok(result.marketScenarios.reasons.includes('parking-family-unknown'));
  assert.ok(result.marketScenarios.reasons.includes('parking-count-unknown'));
  assert.equal(result.marketScenarios.scenarios.length, 6);
  assert.ok(result.marketScenarios.scenarios.every((scenario) => scenario.status === 'unavailable'));
  assert.ok(result.marketScenarios.scenarios.every((scenario) => scenario.confidence === 'low'));
  assert.ok(result.marketScenarios.scenarios.every((scenario) =>
    scenario.reasons.includes('parking-family-unknown') && scenario.reasons.includes('parking-count-unknown')));
});

test('unknown parking retains subject evidence when scenario floor data is missing', () => {
  const [result] = attachMarketEstimates([listing({ parking: '另洽', floor: null })], bundle, AS_OF);

  assert.ok(result.marketScenarios.reasons.includes('listing-floor-group-unavailable'));
  assert.ok(result.marketScenarios.reasons.includes('parking-family-unknown'));
  assert.ok(result.marketScenarios.reasons.includes('parking-count-unknown'));
  assert.equal(result.marketScenarios.scenarios.length, 6);
  assert.ok(result.marketScenarios.scenarios.every((scenario) => scenario.status === 'unavailable'));
  assert.ok(result.marketScenarios.scenarios.every((scenario) => scenario.confidence === 'low'));
});

test('explicit non-freehold title is retained as listing evidence', () => {
  const [result] = attachMarketEstimates([listing({ title: '地上權華廈' })], bundle, AS_OF);

  assert.equal(result.marketEstimate.subjectOwnershipEvidence, 'title-explicit-non-freehold');
  assert.equal(result.marketEstimate.status, 'unavailable');
  assert.ok(result.marketEstimate.unavailableReasons.includes('no-comparables'));
});

test('missing local market data leaves the independent enrichment record usable', () => {
  const [result] = attachMarketEstimates([listing()], null, AS_OF);

  assert.equal(result.marketEstimate.status, 'unavailable');
  assert.deepEqual(result.marketEstimate.unavailableReasons, [
    'market-data-unavailable',
    'legacy-residential-baseline-not-authoritative',
  ]);
  assert.equal(result.walk, null);
  assert.equal(result.withinWalk, null);
});
