import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { attachMarketEstimates } from '../steps.ts';
import type { PreMarketEnrichedListing } from '../types.ts';
import { ACTIVE_ESTIMATOR_POLICY, ESTIMATOR_POLICY_VERSION } from './config.ts';
import { gridKey } from './grid.ts';
import type {
  BacktestAcceptance,
  CandidateBacktestAcceptance,
  DoorplatePoint,
  MarketDataBundle,
} from './types.ts';

const AS_OF = '2026-07-25';
const bundle = JSON.parse(
  readFileSync(new URL('./fixtures/enriched-market-index.json', import.meta.url), 'utf8'),
) as MarketDataBundle;
bundle.manifest.schemaVersion = 5;
bundle.manifest.estimatorPolicyVersion = ESTIMATOR_POLICY_VERSION;

for (const transactions of Object.values(bundle.transactions.cells)) {
  for (const transaction of transactions) {
    transaction.eligibility = 'reliable-eligible';
    transaction.eligibilityReasons = [];
    transaction.totalAreaPing = transaction.buildingAreaPing!;
    transaction.parkingEvidence = {
      grade: 'A',
      family: 'none',
      originalType: '無車位',
      officialPriceNtd: 0,
      officialAreaPing: 0,
      imputation: null,
      reasons: [],
    };
    transaction.originalPrimaryUse = '住家用';
    transaction.primaryUse = 'residential';
    transaction.transferredBuildingCount = 1;
    transaction.transferredParkingCount = 0;
    transaction.buildingUnitPriceBoundsWan = null;
  }
}

function bundleWithAcceptance(transactionArtifactSha256 = 'a'.repeat(64)): MarketDataBundle {
  const accepted = structuredClone(bundle);
  accepted.manifest.artifacts['transactions-index.json'] = {
    sha256: 'a'.repeat(64),
    bytes: 1,
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
      maximumAbsoluteBias: 0.05,
      minimumIntervalCoverage: 0.30,
      minimumParkingFamilyCases: 20,
      minimumParkingEstimateCoverage: 0.50,
      parkingPriceMedianApeMax: 0.25,
      parkingPriceP75ApeMax: 0.45,
      parkingAreaMedianApeMax: 0.15,
      parkingAreaP75ApeMax: 0.30,
      minimumParkingPriceIntervalCoverage: 0.30,
      minimumParkingAreaIntervalCoverage: 0.30,
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
    useCohorts: Object.fromEntries([
      'commercial', 'industrial', 'mixed-industrial', 'mixed-residential', 'office', 'residential',
    ].map((use) => [use, use === 'residential' ? {
      status: 'accepted', scoredCases: 20, estimateCoverage: 0.8,
      medianApe: 0.08, p75Ape: 0.16, bias: 0, intervalCoverage: 0.5, reasons: [],
    } : {
      status: 'diagnostic-only', scoredCases: 0, estimateCoverage: 0,
      medianApe: null, p75Ape: null, bias: null, intervalCoverage: null,
      reasons: ['insufficient-use-cohort-cases', 'incomplete-use-cohort-metrics'],
    }])) as CandidateBacktestAcceptance['useCohorts'],
    parkingImputationAccepted: true,
    parkingFamilies: {
      flat: {
        status: 'accepted', caseCount: 20, estimatedCount: 16, estimateCoverage: 0.8,
        priceMedianApe: 0.1, priceP75Ape: 0.2, areaMedianApe: 0.08, areaP75Ape: 0.12,
        priceIntervalCoverage: 0.5, areaIntervalCoverage: 0.5, reasons: [],
      },
      mechanical: {
        status: 'accepted', caseCount: 20, estimatedCount: 16, estimateCoverage: 0.8,
        priceMedianApe: 0.1, priceP75Ape: 0.2, areaMedianApe: 0.08, areaP75Ape: 0.12,
        priceIntervalCoverage: 0.5, areaIntervalCoverage: 0.5, reasons: [],
      },
    },
    parkingComparison: {
      directCoverage: 0.7, imputedCoverage: 0.8,
      directMedianApe: 0.08, imputedMedianApe: 0.08,
      directP75Ape: 0.16, imputedP75Ape: 0.16,
      biasRegression: 0, intervalCoverageRegression: 0,
    },
  } satisfies CandidateBacktestAcceptance;
  return accepted;
}

function legacyAcceptance(transactionArtifactSha256 = 'a'.repeat(64)): BacktestAcceptance {
  return {
    schemaVersion: 2,
    estimatorPolicyVersion: 4,
    policyId: ACTIVE_ESTIMATOR_POLICY.id,
    transactionArtifactSha256,
    approvedAt: '2026-07-25T01:00:00.000Z',
    asOf: AS_OF,
    evaluatedThrough: AS_OF,
    latestEligibleTransactionDate: '2026-01-25',
    thresholds: {
      medianApeMax: 0.12, p75ApeMax: 0.20, minimumEstimateCoverage: 0.70,
      minimumConfidenceSliceCases: 20, minimumHighConfidenceImprovement: 0.01,
    },
    metrics: {
      estimateCoverage: 0.8, reliableEstimatedCount: 40,
      reliableMedianApe: 0.08, reliableP75Ape: 0.16,
      highConfidenceEstimatedCount: 20, highConfidenceMedianApe: 0.07,
      mediumConfidenceEstimatedCount: 20, mediumConfidenceMedianApe: 0.09,
    },
  };
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
    tenureGate: 'review',
    ...overrides,
  };
}

function bundleWithNearestDoorplate(distanceM: number): MarketDataBundle {
  const accepted = bundleWithAcceptance();
  const coordinate = {
    lat: 25.033964 + (distanceM / 6_371_000) * (180 / Math.PI),
    lng: 121.564468,
  };
  const point: DoorplatePoint = {
    canonicalAddress: '台北市中正區別路88號',
    coordinate,
    district: '中正區',
    roadKey: '台北市中正區別路',
    mainNumber: 88,
    subNumber: null,
  };
  accepted.doorplates.cells = { [gridKey(coordinate)]: [point] };
  return accepted;
}

test('production estimate stays review before approval and becomes reliable only for matching acceptance', () => {
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
  assert.equal(result.marketEstimate.status, 'reliable');
  assert.equal(result.marketEstimate.comparables.length, 5);
  assert.equal(result.marketEstimate.selectedStage, 1);
  assert.equal(result.marketEstimate.subjectOwnershipEvidence, 'profile-default-freehold');
  const evidence = result.marketEstimate.subjectLocationEvidence;
  assert.equal(evidence?.verdict, 'matched');
  assert.equal(evidence?.address.method, 'exact-doorplate');
  assert.ok((evidence?.addressDistanceMeters ?? Infinity) < 1);
  assert.ok(result.marketScenarios);
  assert.equal(
    result.marketEstimate.unavailableReasons.includes(
      'legacy-residential-baseline-not-authoritative',
    ),
    false,
  );
});

test('untouched schema-3 predecessor is review-only and never enters current scenario selectors', () => {
  const legacy = structuredClone(bundleWithAcceptance());
  legacy.manifest.schemaVersion = 3;
  legacy.manifest.estimatorPolicyVersion = 4;
  legacy.backtestAcceptance = legacyAcceptance();
  for (const transactions of Object.values(legacy.transactions.cells)) {
    for (const transaction of transactions) {
      const row = transaction as unknown as Record<string, unknown>;
      for (const challengerField of [
        'totalAreaPing',
        'buildingUnitPriceBoundsWan',
        'parkingEvidence',
        'originalPrimaryUse',
        'transferredParkingCount',
      ]) delete row[challengerField];
    }
  }

  const [result] = attachMarketEstimates([listing()], legacy, AS_OF);

  assert.equal(result.marketEstimate.status, 'review');
  assert.ok(result.marketEstimate.unavailableReasons.includes('market-backtest-not-approved'));
  assert.ok(result.marketScenarios.reasons.includes('legacy-compatibility-scenario-unavailable'));
  assert.ok(result.marketScenarios.scenarios.every((scenario) =>
    scenario.status === 'unavailable'
      && scenario.comparables.length === 0
      && scenario.bundleComparables.length === 0));
});

test('one listing batch scans acceptance coverage exactly once', () => {
  const diagnostics = { eligibleTransactionScans: 0 };
  const listings = Array.from({ length: 5 }, (_, index) => listing({ id: index + 1 }));

  const results = attachMarketEstimates(listings, bundleWithAcceptance(), AS_OF, diagnostics);

  assert.ok(results.every((result) => result.marketEstimate.status === 'reliable'));
  assert.equal(diagnostics.eligibleTransactionScans, 1);
});

test('coordinate-near-doorplate accepts unresolved cross-road addresses through 100 metres', () => {
  for (const distanceM of [25.5, 37.6, 100]) {
    const [result] = attachMarketEstimates([
      listing({ addressOrArea: '台北市中正區定位路1號' }),
    ], bundleWithNearestDoorplate(distanceM), AS_OF);

    const evidence = result.marketEstimate.subjectLocationEvidence;
    assert.equal(evidence?.verdict, 'matched', `${distanceM}m`);
    assert.ok(result.marketEstimate.unavailableReasons.every((reason) =>
      reason !== 'listing-coordinate-address-conflict'
      && reason !== 'listing-address-location-unresolved'), `${distanceM}m`);
    assert.notEqual(result.marketEstimate.status, 'unavailable', `${distanceM}m`);
    assert.equal(evidence?.nearestDoorplate.method, 'nearest-doorplate', `${distanceM}m`);
    assert.equal(evidence?.address.matchedAddress, null, `${distanceM}m`);
  }
});

test('doorplate distance beyond 100 metres stays review-only', () => {
  const [result] = attachMarketEstimates([
    listing({ addressOrArea: '台北市中正區定位路1號' }),
  ], bundleWithNearestDoorplate(200), AS_OF);

  const evidence = result.marketEstimate.subjectLocationEvidence;
  assert.equal(evidence?.verdict, 'uncertain');
  assert.equal(result.marketEstimate.status, 'review');
  assert.ok(result.marketEstimate.unavailableReasons.includes(
    'listing-coordinate-doorplate-distance-uncertain',
  ));
});

test('doorplate unavailable within 300 metres leaves an unresolved address unavailable', () => {
  const [result] = attachMarketEstimates([
    listing({ addressOrArea: '台北市中正區定位路1號' }),
  ], bundleWithNearestDoorplate(300.1), AS_OF);

  const evidence = result.marketEstimate.subjectLocationEvidence;
  assert.equal(evidence?.verdict, 'unavailable');
  assert.equal(result.marketEstimate.status, 'unavailable');
  assert.deepEqual(result.marketEstimate.unavailableReasons, [
    'listing-coordinate-doorplate-unavailable',
  ]);
});

test('same-district wrong-neighborhood GPS pin cannot receive an automatic estimate', () => {
  const [result] = attachMarketEstimates([
    listing({
      coordinate: { lat: 25.033964, lng: 121.574468 },
      reliability: { coordPresent: true, coordConsistent: true, routeOk: true, ratio: 1.2, reason: null },
    }),
  ], bundle, AS_OF);

  assert.equal(result.marketEstimate.status, 'unavailable');
  assert.deepEqual(result.marketEstimate.unavailableReasons, ['listing-coordinate-address-conflict']);
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

test('incomplete unresolved listing address accepts a nearby same-road doorplate', () => {
  const [result] = attachMarketEstimates([
    listing({ addressOrArea: '台北市中正區測試路' }),
  ], bundleWithAcceptance(), AS_OF);

  assert.equal(result.marketEstimate.status, 'reliable');
  const evidence = result.marketEstimate.subjectLocationEvidence;
  assert.equal(evidence?.verdict, 'matched');
  assert.equal(evidence?.address.method, 'unresolved');
  assert.equal(evidence?.nearestDoorplate.matchedAddress, '台北市中正區測試路1號');
});

test('untyped, unreliable GPS, and inseparable listing parking stay unavailable or review', () => {
  const untyped = attachMarketEstimates([listing({ queryHouseType: null, buildingType: null })], bundle, AS_OF)[0]!;
  const unreliable = attachMarketEstimates([
    listing({ reliability: { coordPresent: true, coordConsistent: false, routeOk: null, ratio: null, reason: 'district mismatch' } }),
  ], bundle, AS_OF)[0]!;
  const unknownConsistency = attachMarketEstimates([
    listing({ reliability: { coordPresent: true, coordConsistent: null, routeOk: null, ratio: null, reason: 'district unknown' } }),
  ], bundle, AS_OF)[0]!;
  const parking = attachMarketEstimates([listing({ parking: '平面車位' })], bundle, AS_OF)[0]!;

  assert.deepEqual(untyped.marketEstimate.unavailableReasons, ['listing-building-type-unavailable']);
  assert.deepEqual(unreliable.marketEstimate.unavailableReasons, ['listing-coordinate-unreliable']);
  assert.deepEqual(unknownConsistency.marketEstimate.unavailableReasons, ['listing-coordinate-unreliable']);
  assert.equal(parking.marketEstimate.status, 'review');
  assert.deepEqual(parking.marketEstimate.unavailableReasons, ['listing-parking-not-separable']);
  assert.ok(parking.marketScenarios);
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
  assert.deepEqual(result.marketEstimate.unavailableReasons, ['market-data-unavailable']);
  assert.equal(result.walk, null);
  assert.equal(result.withinWalk, null);
});
