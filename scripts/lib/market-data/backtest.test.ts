import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridKey } from './grid.ts';
import {
  ACTIVE_ESTIMATOR_POLICY,
  CANDIDATE_ESTIMATOR_POLICY_VERSION,
  ESTIMATOR_POLICY_VERSION,
  EXPERIMENTAL_1000_METER_POLICY,
  MARKET_SCHEMA_VERSION,
  SCENARIO_BACKTEST_GATE,
} from './config.ts';
import {
  backtestAcceptance,
  backtestSubjectFromTransaction,
  backtestTransactions,
  candidateBacktestAcceptance,
  evaluateBacktestGate,
  evaluateProductionBacktestGate,
  heldOutTransactionEligible,
  type BacktestReport,
} from './backtest.ts';
import { estimateMarketScenarios } from './scenario-estimator.ts';
import {
  backtestExitCode,
  marketUpdateExitCode,
  shouldPersistBacktestAcceptance,
} from '../../market-data.ts';
import {
  NORMALIZED_PRIMARY_USES,
  type BuildingType,
  type MarketTransaction,
  type NormalizedPrimaryUse,
  type ScenarioMarketSubject,
  type TransactionIndex,
} from './types.ts';

const coordinate = { lat: 25.033964, lng: 121.564468 };

function transaction(
  id: string,
  transactionDate: string,
  price: number,
  buildingType: BuildingType = 'apartment',
  overrides: Partial<MarketTransaction> = {},
): MarketTransaction {
  const base: MarketTransaction = {
    id,
    transactionDate,
    sourceVersion: 'fixture',
    originalAddress: `台北市中正區測試路${id}號`,
    location: {
      method: 'exact-doorplate', coordinate, normalizedAddress: `台北市中正區測試路${id}號`,
      matchedAddress: `台北市中正區測試路${id}號`, uncertaintyMeters: 0, confidence: 'high', datasetVersion: 'fixture',
    },
    district: '中正區', ownership: 'freehold', buildingType,
    totalPriceNtd: price * 300_000, totalAreaPing: 30, buildingPriceNtd: price * 300_000, buildingAreaPing: 30,
    parkingPriceNtd: 0, parkingAreaPing: 0, buildingUnitPriceWan: price,
    floor: 3, totalFloors: buildingType === 'apartment' ? 5 : 10, floorGroup: buildingType === 'apartment' ? 'middle' : 'low',
    completionDate: buildingType === 'apartment' ? null : '2011-01-01', notes: '', exclusionFlags: [],
    eligibility: 'reliable-eligible', eligibilityReasons: [], originalPrimaryUse: '住家用', primaryUse: 'residential', transferredBuildingCount: 1,
    transferredParkingCount: 0,
    buildingUnitPriceBoundsWan: null,
    parkingEvidence: { grade: 'A', family: 'none', originalType: '無車位', officialPriceNtd: 0, officialAreaPing: 0, imputation: null, reasons: [] },
  };
  return { ...base, ...overrides };
}

const primaryUseText: Record<Exclude<NormalizedPrimaryUse, 'unknown'>, string> = {
  commercial: '商業用',
  industrial: '工業用',
  'mixed-industrial': '住工用',
  'mixed-residential': '住商用',
  office: '辦公用',
  residential: '住家用',
};

function exactUseTransaction(
  id: string,
  transactionDate: string,
  price: number,
  primaryUse: Exclude<NormalizedPrimaryUse, 'unknown'>,
  overrides: Partial<MarketTransaction> = {},
): MarketTransaction {
  return transaction(id, transactionDate, price, 'apartment', {
    eligibility: primaryUse === 'residential' ? 'reliable-eligible' : 'review-only',
    eligibilityReasons: primaryUse === 'residential' ? [] : ['scenario-only-primary-use'],
    originalPrimaryUse: primaryUseText[primaryUse],
    primaryUse,
    ...overrides,
  });
}

function gradeBComparable(id: string, transactionDate: string, price: number): MarketTransaction {
  const imputation = {
    asOf: transactionDate,
    stage: 'nearby-500m' as const,
    comparableIds: ['parking-trainer-1', 'parking-trainer-2', 'parking-trainer-3'],
    comparableCount: 3,
    priceP25Ntd: 1_800_000,
    priceP50Ntd: 2_000_000,
    priceP75Ntd: 2_200_000,
    areaP25Ping: 9,
    areaP50Ping: 10,
    areaP75Ping: 11,
    pairP25: { priceNtd: 1_800_000, areaPing: 9 },
    pairP50: { priceNtd: 2_000_000, areaPing: 10 },
    pairP75: { priceNtd: 2_200_000, areaPing: 11 },
    priceIqrRatio: 0.20,
    areaIqrRatio: 0.20,
  };
  return exactUseTransaction(id, transactionDate, price, 'residential', {
    eligibility: 'review-only',
    eligibilityReasons: ['parking-not-separable'],
    totalPriceNtd: price * 300_000 + imputation.priceP50Ntd,
    totalAreaPing: 40,
    buildingPriceNtd: price * 300_000,
    buildingAreaPing: 30,
    parkingPriceNtd: imputation.priceP50Ntd,
    parkingAreaPing: imputation.areaP50Ping,
    transferredParkingCount: 1,
    buildingUnitPriceBoundsWan: { p25: price * 0.95, p50: price, p75: price * 1.05, relativeIqrRatio: 0.10 },
    parkingEvidence: {
      grade: 'B', family: 'flat', originalType: '坡道平面',
      officialPriceNtd: null, officialAreaPing: null, imputation,
      reasons: ['parking-price-missing'],
    },
  });
}

function directParkingTransaction(
  id: string,
  transactionDate: string,
  parkingPriceNtd: number,
  parkingAreaPing: number,
): MarketTransaction {
  const unitPriceWan = 100;
  return exactUseTransaction(id, transactionDate, unitPriceWan, 'residential', {
    totalPriceNtd: unitPriceWan * 300_000 + parkingPriceNtd,
    totalAreaPing: 30 + parkingAreaPing,
    buildingPriceNtd: unitPriceWan * 300_000,
    buildingAreaPing: 30,
    parkingPriceNtd,
    parkingAreaPing,
    transferredParkingCount: 1,
    parkingEvidence: {
      grade: 'A', family: 'flat', originalType: '坡道平面',
      officialPriceNtd: parkingPriceNtd, officialAreaPing: parkingAreaPing,
      imputation: null, reasons: [],
    },
  });
}

function indexOf(transactions: MarketTransaction[]): TransactionIndex {
  const cells: TransactionIndex['cells'] = {};
  for (const transaction of transactions) {
    const key = gridKey(transaction.location.coordinate!);
    (cells[key] ??= []).push(transaction);
  }
  return {
    schemaVersion: MARKET_SCHEMA_VERSION, datasetVersion: 'fixture', builtAt: '2026-07-25T00:00:00.000Z',
    cells,
  };
}

const indexWithFutureLeak = indexOf([
  transaction('one', '2025-01-01', 90),
  transaction('two', '2025-02-01', 92),
  transaction('three', '2025-03-01', 94),
  transaction('four', '2025-04-01', 96),
  transaction('future', '2025-12-01', 10),
]);

test('held-out estimate uses only transactions before subject date', () => {
  const report = backtestTransactions(indexWithFutureLeak, { asOf: '2026-07-25' });

  assert.ok(report.cases.every((backtestCase) =>
    backtestCase.comparableDates.every((date) => date < backtestCase.subjectDate),
  ));
});

test('legacy held-outs exclude completion inconsistencies while scenario coverage tracks runtime influence', () => {
  const completedAfterSale = transaction('future-completion', '2025-12-01', 100, 'midrise');
  completedAfterSale.completionDate = '2026-01-01';

  const report = backtestTransactions(indexOf([completedAfterSale]), { asOf: '2026-07-25' });

  assert.equal(heldOutTransactionEligible(completedAfterSale), false);
  assert.equal(report.latestEligibleTransactionDate, '2025-12-01');
  assert.equal(report.cases.length, 0);
});

test('held-out price is not passed into the evaluator subject or comparable estimate', () => {
  const original = transaction('subject', '2025-04-01', 96);
  const changedOutcome = transaction('subject', '2025-04-01', 960);
  const originalSubject = backtestSubjectFromTransaction(original);
  const changedSubject = backtestSubjectFromTransaction(changedOutcome);

  assert.equal(originalSubject.askingUnitPriceWan, null);
  assert.deepEqual(changedSubject, originalSubject);

  const originalReport = backtestTransactions(indexWithFutureLeak, { asOf: '2026-07-25' });
  const changedReport = backtestTransactions(indexOf([
    transaction('one', '2025-01-01', 90),
    transaction('two', '2025-02-01', 92),
    transaction('three', '2025-03-01', 94),
    transaction('four', '2025-04-01', 960),
    transaction('future', '2025-12-01', 10),
  ]), { asOf: '2026-07-25' });
  const originalCase = originalReport.cases.find((backtestCase) => backtestCase.subjectDate === '2025-04-01');
  const changedCase = changedReport.cases.find((backtestCase) => backtestCase.subjectDate === '2025-04-01');

  assert.equal(originalCase?.status, 'reliable');
  assert.notEqual(originalCase?.estimatedUnitPriceWan, null);
  assert.deepEqual(
    changedCase && {
      status: changedCase.status, confidence: changedCase.confidence,
      estimate: changedCase.estimatedUnitPriceWan, p25: changedCase.estimatedP25Wan,
      p75: changedCase.estimatedP75Wan, comparableDates: changedCase.comparableDates,
    },
    originalCase && {
      status: originalCase.status, confidence: originalCase.confidence,
      estimate: originalCase.estimatedUnitPriceWan, p25: originalCase.estimatedP25Wan,
      p75: originalCase.estimatedP75Wan, comparableDates: originalCase.comparableDates,
    },
  );
});

test('reports coverage, median APE, P75 APE, bias, interval coverage, and confidence slices', () => {
  const report = backtestTransactions(indexWithFutureLeak, { asOf: '2026-07-25' });

  assert.equal(typeof report.overall.estimateCoverage, 'number');
  assert.equal(typeof report.overall.medianApe, 'number');
  assert.equal(typeof report.overall.p75Ape, 'number');
  assert.equal(typeof report.overall.bias, 'number');
  assert.equal(typeof report.overall.intervalCoverage, 'number');
  assert.ok(report.byBuildingType.apartment);
  assert.ok(report.byConfidence.high);
  assert.ok(report.byStatus.reliable);
  assert.ok(report.byStatus.review);
  assert.ok(report.byStatus.unavailable);
  assert.equal(report.policyId, ACTIVE_ESTIMATOR_POLICY.id);
});

test('reports independent exact-use cohorts and direct-plus-imputed coverage from causal grade-B history', () => {
  const parkingTrainers = [
    directParkingTransaction('parking-trainer-1', '2025-01-01', 1_800_000, 9),
    directParkingTransaction('parking-trainer-2', '2025-01-02', 2_000_000, 10),
    directParkingTransaction('parking-trainer-3', '2025-01-03', 2_200_000, 11),
  ].map((item) => ({
    ...item,
    eligibility: 'review-only' as const,
    eligibilityReasons: ['primary-use-unavailable'],
    originalPrimaryUse: '',
    primaryUse: 'unknown' as const,
  }));
  const residential = [
    exactUseTransaction('residential-a', '2025-02-01', 99, 'residential'),
    exactUseTransaction('residential-b', '2025-03-01', 100, 'residential'),
    gradeBComparable('residential-imputed', '2025-04-01', 101),
    exactUseTransaction('residential-subject', '2025-05-01', 102, 'residential'),
  ];
  const office = [1, 2, 3, 4].map((month) =>
    exactUseTransaction(`office-${month}`, `2025-0${month}-15`, 80 + month, 'office'),
  );
  const industrial = [1, 2, 3, 4].map((month) =>
    exactUseTransaction(`industrial-${month}`, `2025-0${month}-20`, 60 + month, 'industrial'),
  );

  const report = backtestTransactions(
    indexOf([...parkingTrainers, ...residential, ...office, ...industrial]),
    { asOf: '2026-07-25' },
  );
  const knownUses = NORMALIZED_PRIMARY_USES.filter((use) => use !== 'unknown');

  assert.deepEqual(Object.keys(report.byPrimaryUse), knownUses);
  assert.equal(report.byPrimaryUse.residential.caseCount, 3);
  assert.equal(report.byPrimaryUse.office.caseCount, 4);
  assert.equal(report.byPrimaryUse.industrial.caseCount, 4);
  assert.equal(report.byPrimaryUse.commercial.caseCount, 0);
  assert.equal(report.byPrimaryUse['mixed-residential'].caseCount, 0);
  assert.equal(report.byPrimaryUse['mixed-industrial'].caseCount, 0);
  assert.equal(report.byParkingGrade.A.caseCount, 11);
  assert.equal(report.byParkingGrade.B.caseCount, 0);
  assert.equal(report.byParkingGrade.C.caseCount, 0);
  assert.equal(report.directOnly.caseCount, 11);
  assert.equal(report.directPlusImputed.caseCount, 11);
  assert.ok(report.directPlusImputed.estimatedCount > report.directOnly.estimatedCount);
});

test('masked grade-A parking holdouts report aggregate price, area, and interval diagnostics by family', () => {
  const report = backtestTransactions(indexOf([
    directParkingTransaction('parking-1', '2025-01-01', 1_800_000, 9),
    directParkingTransaction('parking-2', '2025-02-01', 2_000_000, 10),
    directParkingTransaction('parking-3', '2025-03-01', 2_200_000, 11),
    directParkingTransaction('parking-4', '2025-04-01', 2_000_000, 10),
  ]), { asOf: '2026-07-25' });

  assert.equal(report.parkingMaskedHoldout.overall.caseCount, 4);
  assert.equal(report.parkingMaskedHoldout.overall.estimatedCount, 1);
  assert.equal(typeof report.parkingMaskedHoldout.overall.priceMedianApe, 'number');
  assert.equal(typeof report.parkingMaskedHoldout.overall.areaMedianApe, 'number');
  assert.equal(report.parkingMaskedHoldout.overall.priceIntervalCoverage, 1);
  assert.equal(report.parkingMaskedHoldout.overall.areaIntervalCoverage, 1);
  assert.equal(report.parkingMaskedHoldout.byParkingFamily.flat.caseCount, 4);
  assert.equal(report.parkingMaskedHoldout.byParkingFamily.mechanical.caseCount, 0);
});

test('quality gate fails only completed reports over a target and can be disabled', () => {
  const failed = completeGateReport({
    reliable: { medianApe: 0.13, p75Ape: 0.19 },
  });

  assert.equal(backtestExitCode(failed, false), 1);
  assert.equal(backtestExitCode(failed, true), 0);
});

test('incomplete backtests fail the gate unless explicitly diagnostic', () => {
  const incomplete = completeGateReport({
    reliable: { estimatedCount: 0, medianApe: null, p75Ape: null },
  });

  assert.equal(evaluateBacktestGate(incomplete).passed, false);
  assert.ok(evaluateBacktestGate(incomplete).reasons.includes('incomplete-overall'));
  assert.equal(backtestExitCode(incomplete, false), 1);
  assert.equal(backtestExitCode(incomplete, true), 0);
});

test('historical cutoff cannot approve a newer complete active transaction index', () => {
  const historical = completeGateReport({}, '2025-04-01');

  assert.equal(historical.latestEligibleTransactionDate, '2025-12-01');
  assert.ok(evaluateBacktestGate(historical).reasons.includes('incomplete-active-transaction-coverage'));
  assert.equal(backtestExitCode(historical, false), 1);
  assert.equal(backtestExitCode(historical, true), 0);
  assert.equal(shouldPersistBacktestAcceptance(historical, false), false);
  assert.equal(shouldPersistBacktestAcceptance(historical, true), false);
});

test('scenario acceptance coverage boundary includes newer exact-use grade-A transactions', () => {
  const report = backtestTransactions(indexOf([
    exactUseTransaction('residential-old', '2025-01-01', 100, 'residential'),
    exactUseTransaction('office-newer', '2025-12-15', 80, 'office'),
  ]), { asOf: '2025-06-01' });

  assert.equal(report.latestEligibleTransactionDate, '2025-12-15');
  assert.ok(evaluateBacktestGate(report).reasons.includes('incomplete-active-transaction-coverage'));
});

test('scenario coverage boundary includes grade-B, masked-parking, and grade-C runtime evidence', () => {
  const older = exactUseTransaction('residential-old', '2025-01-01', 100, 'residential');
  const gradeB = gradeBComparable('grade-b-newer', '2025-10-01', 101);
  const maskedParkingOnly = {
    ...directParkingTransaction('masked-parking-newer', '2025-11-01', 2_000_000, 10),
    eligibility: 'review-only' as const,
    eligibilityReasons: ['primary-use-unavailable'],
    originalPrimaryUse: '',
    primaryUse: 'unknown' as const,
  };
  const gradeC = exactUseTransaction('grade-c-newer', '2025-12-01', 80, 'office', {
    eligibility: 'review-only',
    eligibilityReasons: ['scenario-only-primary-use', 'parking-not-separable'],
    buildingPriceNtd: null,
    buildingAreaPing: null,
    buildingUnitPriceWan: null,
    parkingPriceNtd: null,
    parkingAreaPing: null,
    parkingEvidence: {
      grade: 'C', family: 'unknown', originalType: '其他',
      officialPriceNtd: null, officialAreaPing: null, imputation: null,
      reasons: ['parking-family-unknown'],
    },
  });

  const gradeBReport = backtestTransactions(indexOf([older, gradeB]), { asOf: '2025-06-01' });
  const maskedReport = backtestTransactions(indexOf([older, maskedParkingOnly]), { asOf: '2025-06-01' });
  const bundleReport = backtestTransactions(indexOf([older, gradeC]), { asOf: '2025-06-01' });

  assert.equal(gradeBReport.latestEligibleTransactionDate, '2025-10-01');
  assert.equal(maskedReport.latestEligibleTransactionDate, '2025-11-01');
  assert.equal(bundleReport.latestEligibleTransactionDate, '2025-12-01');
});

test('gate cannot approve a report without an eligible transaction coverage boundary', () => {
  const missingBoundary = {
    ...completeGateReport(),
    latestEligibleTransactionDate: null,
  };

  assert.ok(evaluateBacktestGate(missingBoundary).reasons.includes('incomplete-active-transaction-coverage'));
  assert.equal(shouldPersistBacktestAcceptance(missingBoundary, false), false);
});

test('acceptance requires sufficient slices and high confidence to outperform medium by one point', () => {
  const insufficient = completeGateReport({
    high: { estimatedCount: 19, medianApe: 0.07 },
  });
  const notMeasurablyBetter = completeGateReport({
    high: { medianApe: 0.095 },
    medium: { medianApe: 0.10 },
  });
  const passing = completeGateReport({
    high: { medianApe: 0.08 },
    medium: { medianApe: 0.10 },
  });

  assert.ok(evaluateBacktestGate(insufficient).reasons.includes('insufficient-high-confidence-cases'));
  assert.ok(evaluateBacktestGate(notMeasurablyBetter).reasons.includes('high-confidence-not-measurably-better'));
  assert.deepEqual(evaluateBacktestGate(passing), { passed: true, complete: true, reasons: [] });
  assert.equal(shouldPersistBacktestAcceptance(passing, false), false);
  assert.equal(shouldPersistBacktestAcceptance(productionReadyReport(), false), true);
  assert.equal(shouldPersistBacktestAcceptance(passing, true), false);
  assert.equal(shouldPersistBacktestAcceptance(insufficient, false), false);
});

test('acceptance requires 70% overall estimate coverage and reliable-cohort accuracy', () => {
  assert.ok(evaluateBacktestGate(completeGateReport({
    overall: { estimateCoverage: 0.69 },
  })).reasons.includes('estimate-coverage-target-missed'));
  assert.ok(evaluateBacktestGate(completeGateReport({
    reliable: { medianApe: 0.121 },
  })).reasons.includes('median-ape-target-missed'));
  assert.deepEqual(evaluateBacktestGate(completeGateReport({
    overall: { estimateCoverage: 0.70 },
    reliable: { medianApe: 0.12, p75Ape: 0.20 },
  })), { passed: true, complete: true, reasons: [] });
});

test('review cohort accuracy is diagnostic and does not fail reliable acceptance', () => {
  const report = completeGateReport({
    reliable: { medianApe: 0.12, p75Ape: 0.20 },
    review: { medianApe: 0.40, p75Ape: 0.80 },
  });

  assert.deepEqual(evaluateBacktestGate(report), { passed: true, complete: true, reasons: [] });
});

test('production gate requires the legacy global, residential exact-use, and shared parking gates', () => {
  const passing = productionReadyReport();
  assert.deepEqual(evaluateProductionBacktestGate(passing), {
    passed: true,
    complete: true,
    reasons: [],
  });

  const residentialFailure = productionReadyReport();
  residentialFailure.byPrimaryUse.residential = gateMetric({
    caseCount: 20,
    estimatedCount: 20,
    estimateCoverage: 1,
    medianApe: 0.13,
    p75Ape: 0.21,
  });
  assert.ok(evaluateProductionBacktestGate(residentialFailure).reasons.includes(
    'residential-use-cohort-failed',
  ));

  const parkingFailure = productionReadyReport();
  parkingFailure.parkingMaskedHoldout.byParkingFamily.mechanical = maskedMetric({
    caseCount: 0,
    estimatedCount: 0,
    estimateCoverage: 0,
    priceMedianApe: null,
    priceP75Ape: null,
    areaMedianApe: null,
    areaP75Ape: null,
    priceIntervalCoverage: null,
    areaIntervalCoverage: null,
  });
  assert.ok(evaluateProductionBacktestGate(parkingFailure).reasons.includes(
    'parking-family-mechanical-not-accepted',
  ));

  const isolatedOfficeFailure = productionReadyReport();
  isolatedOfficeFailure.byPrimaryUse.office = gateMetric({
    caseCount: 20,
    estimatedCount: 20,
    estimateCoverage: 1,
    medianApe: 0.50,
    p75Ape: 0.80,
    bias: 0.50,
    intervalCoverage: 0,
  });
  assert.equal(evaluateProductionBacktestGate(isolatedOfficeFailure).passed, true);
});

test('exact-use cohort gate rejects catastrophic absolute bias and interval calibration', () => {
  const catastrophicBias = productionReadyReport();
  catastrophicBias.byPrimaryUse.residential = gateMetric({
    caseCount: 20,
    estimatedCount: 20,
    estimateCoverage: 1,
    medianApe: 0.08,
    p75Ape: 0.16,
    bias: 0.99,
    intervalCoverage: 0.5,
  });
  assert.ok(evaluateProductionBacktestGate(catastrophicBias).reasons.includes(
    'residential-use-cohort-failed',
  ));

  const catastrophicCalibration = productionReadyReport();
  catastrophicCalibration.byPrimaryUse.residential = gateMetric({
    caseCount: 20,
    estimatedCount: 20,
    estimateCoverage: 1,
    medianApe: 0.08,
    p75Ape: 0.16,
    bias: 0,
    intervalCoverage: 0,
  });
  assert.ok(evaluateProductionBacktestGate(catastrophicCalibration).reasons.includes(
    'residential-use-cohort-failed',
  ));
});

test('parking family gate rejects sparse and poor masked diagnostics independently', () => {
  const sparse = productionReadyReport();
  sparse.parkingMaskedHoldout.byParkingFamily.flat = maskedMetric({
    caseCount: 19,
    estimatedCount: 19,
    estimateCoverage: 1,
  });
  assert.ok(evaluateProductionBacktestGate(sparse).reasons.includes(
    'parking-family-flat-not-accepted',
  ));

  const poor = productionReadyReport();
  poor.parkingMaskedHoldout.byParkingFamily.flat = maskedMetric({
    priceMedianApe: 0.90,
    priceP75Ape: 1.20,
    areaMedianApe: 0.80,
    areaP75Ape: 1,
    priceIntervalCoverage: 0,
    areaIntervalCoverage: 0,
  });
  assert.ok(evaluateProductionBacktestGate(poor).reasons.includes(
    'parking-family-flat-not-accepted',
  ));
});

test('passing challenger acceptance records policy identity, scenario thresholds, and complete transaction coverage', () => {
  const passing = productionReadyReport();
  const acceptance = candidateBacktestAcceptance(passing, 'a'.repeat(64), '2026-07-26T01:00:00.000Z');

  assert.equal(acceptance.schemaVersion, 3);
  assert.equal(acceptance.estimatorPolicyVersion, CANDIDATE_ESTIMATOR_POLICY_VERSION);
  assert.equal(acceptance.policyId, 'baseline');
  assert.equal(acceptance.evaluatedThrough, '2025-12-01');
  assert.equal(acceptance.latestEligibleTransactionDate, '2025-12-01');
  assert.equal(acceptance.thresholds.minimumEstimateCoverage, 0.70);
  assert.equal(acceptance.thresholds.minimumUseCohortCases, SCENARIO_BACKTEST_GATE.minimumUseCohortCases);
  assert.equal(acceptance.thresholds.maximumAbsoluteBiasRegression, 0.01);
  assert.equal(acceptance.thresholds.maximumIntervalCoverageRegression, 0.05);
  assert.equal(acceptance.thresholds.maximumAbsoluteBias, 0.05);
  assert.equal(acceptance.thresholds.minimumIntervalCoverage, 0.30);
  assert.equal(acceptance.thresholds.minimumParkingFamilyCases, 20);
  assert.equal(acceptance.parkingFamilies.flat.status, 'accepted');
  assert.equal(acceptance.parkingFamilies.mechanical.status, 'accepted');
  assert.equal(acceptance.metrics.reliableMedianApe, 0.08);
  assert.equal(acceptance.metrics.reliableP75Ape, 0.16);
});

test('production and challenger acceptance artifacts cannot cross-authorize', () => {
  const passing = productionReadyReport();
  const checksum = '9'.repeat(64);
  const approvedAt = '2026-07-26T01:00:00.000Z';

  const production = backtestAcceptance(passing, checksum, approvedAt);
  const challenger = candidateBacktestAcceptance(passing, checksum, approvedAt);

  assert.equal(production.schemaVersion, 2);
  assert.equal(production.estimatorPolicyVersion, ESTIMATOR_POLICY_VERSION);
  assert.equal(challenger.schemaVersion, 3);
  assert.equal(
    challenger.estimatorPolicyVersion,
    CANDIDATE_ESTIMATOR_POLICY_VERSION,
  );
});

test('schema-3 acceptance keeps sparse cohorts diagnostic and accepts a 20-case exact-use cohort at the accuracy bounds', () => {
  const report = productionReadyReport();
  report.byPrimaryUse.office = gateMetric({
    caseCount: 25,
    estimatedCount: 19,
    estimateCoverage: 0.76,
    medianApe: 0.05,
    p75Ape: 0.10,
  });
  report.byPrimaryUse.industrial = gateMetric({
    caseCount: 20,
    estimatedCount: 20,
    estimateCoverage: 1,
    medianApe: 0.12,
    p75Ape: 0.20,
  });
  report.byPrimaryUseDirectOnly.office = { ...report.byPrimaryUse.office };
  report.byPrimaryUseDirectOnly.industrial = { ...report.byPrimaryUse.industrial };

  const acceptance = candidateBacktestAcceptance(report, 'b'.repeat(64), '2026-07-26T01:00:00.000Z');

  assert.equal(acceptance.schemaVersion, 3);
  assert.deepEqual(Object.keys(acceptance.useCohorts), NORMALIZED_PRIMARY_USES.filter((use) => use !== 'unknown'));
  assert.equal(acceptance.useCohorts.office.status, 'diagnostic-only');
  assert.equal(acceptance.useCohorts.office.scoredCases, 19);
  assert.ok(acceptance.useCohorts.office.reasons.includes('insufficient-use-cohort-cases'));
  assert.equal(acceptance.useCohorts.industrial.status, 'accepted');
  assert.equal(acceptance.useCohorts.industrial.scoredCases, 20);
  assert.deepEqual(acceptance.useCohorts.industrial.reasons, []);
  assert.equal('cases' in acceptance, false);
  assert.equal('scenarioCases' in acceptance, false);
  assert.doesNotMatch(JSON.stringify(acceptance), /subjectDate|comparableDates|originalAddress/);
});

test('a failed non-residential use remains isolated while residential global failure blocks acceptance', () => {
  const nonResidentialFailure = productionReadyReport();
  nonResidentialFailure.byPrimaryUse.office = gateMetric({
    caseCount: 20,
    estimatedCount: 20,
    medianApe: 0.13,
    p75Ape: 0.21,
  });
  nonResidentialFailure.byPrimaryUseDirectOnly.office = {
    ...nonResidentialFailure.byPrimaryUse.office,
  };
  const acceptance = candidateBacktestAcceptance(
    nonResidentialFailure,
    'c'.repeat(64),
    '2026-07-26T01:00:00.000Z',
  );
  assert.equal(acceptance.useCohorts.office.status, 'failed');
  assert.ok(acceptance.useCohorts.office.reasons.includes('median-ape-target-missed'));
  assert.ok(acceptance.useCohorts.office.reasons.includes('p75-ape-target-missed'));

  const residentialGlobalFailure = completeGateReport({
    reliable: { medianApe: 0.13 },
  }, '2025-12-01');
  assert.throws(
    () => candidateBacktestAcceptance(
      residentialGlobalFailure,
      'd'.repeat(64),
      '2026-07-26T01:00:00.000Z',
    ),
    /Backtest does not pass acceptance/,
  );
});

test('grade-B activation requires strict coverage improvement within accuracy, bias, and interval regressions', () => {
  const acceptanceFor = (
    direct: Partial<BacktestReport['directOnly']>,
    imputed: Partial<BacktestReport['directPlusImputed']>,
  ) => {
    const report = productionReadyReport();
    report.directOnly = gateMetric({
      estimateCoverage: 0.70,
      medianApe: 0.10,
      p75Ape: 0.18,
      bias: 0.02,
      intervalCoverage: 0.80,
      ...direct,
    });
    report.directPlusImputed = gateMetric({
      estimateCoverage: 0.71,
      medianApe: 0.11,
      p75Ape: 0.19,
      bias: -0.03,
      intervalCoverage: 0.75,
      ...imputed,
    });
    return () => candidateBacktestAcceptance(report, 'e'.repeat(64), '2026-07-26T01:00:00.000Z');
  };

  const passing = acceptanceFor({}, {})();
  assert.equal(passing.parkingImputationAccepted, true);
  assert.equal(passing.parkingComparison.biasRegression, 0.009999999999999998);
  assert.ok(Math.abs((passing.parkingComparison.intervalCoverageRegression ?? 0) - 0.05) < 1e-12);

  assert.throws(acceptanceFor({}, { estimateCoverage: 0.70 }), /parking-imputation-comparison-failed/);
  assert.throws(acceptanceFor({}, { bias: -0.031 }), /parking-imputation-comparison-failed/);
  assert.throws(acceptanceFor({}, { intervalCoverage: 0.749 }), /parking-imputation-comparison-failed/);
  assert.throws(acceptanceFor({}, { medianApe: 0.121 }), /parking-imputation-comparison-failed/);
  assert.throws(acceptanceFor({}, { p75Ape: 0.201 }), /parking-imputation-comparison-failed/);
});

test('rejected parking gates cannot produce a production acceptance', () => {
  const report = completeGateReport({}, '2025-12-01') as BacktestReport & {
    byPrimaryUseDirectOnly: BacktestReport['byPrimaryUse'];
  };
  report.byPrimaryUse.residential = gateMetric({
    caseCount: 25,
    estimatedCount: 20,
    estimateCoverage: 0.8,
    medianApe: 0.08,
    p75Ape: 0.16,
  });
  report.byPrimaryUseDirectOnly = {
    ...report.byPrimaryUse,
    residential: gateMetric({
      caseCount: 25,
      estimatedCount: 20,
      estimateCoverage: 0.8,
      medianApe: 0.13,
      p75Ape: 0.21,
    }),
  };
  report.directOnly = gateMetric({
    estimateCoverage: 0.70,
    medianApe: 0.13,
    p75Ape: 0.21,
    bias: 0.02,
    intervalCoverage: 0.8,
  });
  report.directPlusImputed = gateMetric({
    estimateCoverage: 0.70,
    medianApe: 0.08,
    p75Ape: 0.16,
    bias: 0.01,
    intervalCoverage: 0.8,
  });

  assert.throws(
    () => candidateBacktestAcceptance(report, 'f'.repeat(64), '2026-07-26T01:00:00.000Z'),
    /parking-imputation-comparison-failed/,
  );
});

test('selected backtest policy is passed to estimation without changing the active policy', () => {
  const subjectCoordinate = { lat: 25.033964, lng: 121.564468 };
  const distantCoordinate = { lat: 25.033964, lng: 121.5734 };
  const history = [
    transaction('one', '2025-01-01', 90),
    transaction('two', '2025-02-01', 92),
    transaction('three', '2025-03-01', 94),
  ];
  for (const item of history) item.location.coordinate = distantCoordinate;
  const subject = transaction('subject', '2025-04-01', 96);
  subject.location.coordinate = subjectCoordinate;
  const index = indexOf([...history, subject]);

  const baseline = backtestTransactions(index, { asOf: '2026-07-25' });
  const expanded = backtestTransactions(index, {
    asOf: '2026-07-25',
    policy: EXPERIMENTAL_1000_METER_POLICY,
  });

  assert.equal(baseline.policyId, 'baseline');
  assert.equal(expanded.policyId, '1000-meter');
  assert.equal(baseline.cases.at(-1)?.estimatedUnitPriceWan, null);
  assert.equal(typeof expanded.cases.at(-1)?.estimatedUnitPriceWan, 'number');
  assert.equal(ACTIVE_ESTIMATOR_POLICY.id, 'baseline');
});

test('review-only source stays outside legacy held-outs while scenario coverage tracks runtime influence', () => {
  const reviewOnly = transaction('review-only', '2025-12-01', 100);
  reviewOnly.eligibility = 'review-only';
  reviewOnly.eligibilityReasons = ['mixed-primary-use'];

  const report = backtestTransactions(indexOf([reviewOnly]), { asOf: '2026-07-25' });

  assert.equal(heldOutTransactionEligible(reviewOnly), false);
  assert.equal(report.latestEligibleTransactionDate, '2025-12-01');
  assert.equal(report.overall.caseCount, 0);
});

test('held-out history is built incrementally with each source transaction inserted once', () => {
  const transactions = Array.from({ length: 100 }, (_, index) =>
    transaction(`scale-${index}`, `2025-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`, 90 + index / 100),
  );
  const report = backtestTransactions(indexOf(transactions), { asOf: '2026-07-25' });

  assert.equal(report.work.historicalIndexBuilds, 1);
  assert.equal(report.work.historicalInsertions, transactions.length);
});

test('retained last-known-good refresh has a distinct nonzero operator exit', () => {
  assert.equal(marketUpdateExitCode('updated'), 0);
  assert.equal(marketUpdateExitCode('not-modified'), 0);
  assert.equal(marketUpdateExitCode('last-known-good'), 3);
});

function gateMetric(
  values: Partial<BacktestReport['overall']> = {},
): BacktestReport['overall'] {
  return {
    caseCount: 25,
    estimatedCount: 20,
    estimateCoverage: 0.8,
    medianApe: 0.08,
    p75Ape: 0.16,
    bias: 0,
    intervalCoverage: 0.5,
    ...values,
  };
}

function maskedMetric(
  values: Partial<BacktestReport['parkingMaskedHoldout']['overall']> = {},
): BacktestReport['parkingMaskedHoldout']['overall'] {
  return {
    caseCount: 25,
    estimatedCount: 20,
    estimateCoverage: 0.8,
    priceMedianApe: 0.10,
    priceP75Ape: 0.20,
    areaMedianApe: 0.08,
    areaP75Ape: 0.16,
    priceIntervalCoverage: 0.50,
    areaIntervalCoverage: 0.50,
    ...values,
  };
}

function productionReadyReport(): BacktestReport {
  const report = completeGateReport({}, '2025-12-01');
  const residential = gateMetric({
    caseCount: 25,
    estimatedCount: 20,
    estimateCoverage: 0.8,
    medianApe: 0.08,
    p75Ape: 0.16,
    bias: 0,
    intervalCoverage: 0.5,
  });
  report.byPrimaryUse.residential = residential;
  report.byPrimaryUseDirectOnly.residential = { ...residential };
  report.directOnly = gateMetric({
    estimateCoverage: 0.70,
    medianApe: 0.10,
    p75Ape: 0.18,
    bias: 0.02,
    intervalCoverage: 0.50,
  });
  report.directPlusImputed = gateMetric({
    estimateCoverage: 0.71,
    medianApe: 0.10,
    p75Ape: 0.18,
    bias: 0.02,
    intervalCoverage: 0.50,
  });
  report.parkingMaskedHoldout = {
    overall: maskedMetric({ caseCount: 50, estimatedCount: 40 }),
    byParkingFamily: {
      flat: maskedMetric(),
      mechanical: maskedMetric(),
    },
  };
  return report;
}

function completeGateReport(overrides: {
  overall?: Partial<BacktestReport['overall']>;
  reliable?: Partial<BacktestReport['byStatus']['reliable']>;
  review?: Partial<BacktestReport['byStatus']['review']>;
  high?: Partial<BacktestReport['byConfidence']['high']>;
  medium?: Partial<BacktestReport['byConfidence']['medium']>;
} = {}, asOf = '2026-07-25'): BacktestReport {
  const report = backtestTransactions(indexWithFutureLeak, { asOf });
  return {
    ...report,
    overall: gateMetric({ caseCount: 50, estimatedCount: 40, ...overrides.overall }),
    byStatus: {
      reliable: gateMetric({ caseCount: 50, estimatedCount: 40, medianApe: 0.08, p75Ape: 0.16, ...overrides.reliable }),
      review: gateMetric({ caseCount: 0, estimatedCount: 0, estimateCoverage: 0, medianApe: null, p75Ape: null, ...overrides.review }),
      unavailable: gateMetric({ caseCount: 0, estimatedCount: 0, estimateCoverage: 0, medianApe: null, p75Ape: null }),
    },
    byConfidence: {
      ...report.byConfidence,
      high: gateMetric({ medianApe: 0.08, ...overrides.high }),
      medium: gateMetric({ medianApe: 0.10, ...overrides.medium }),
    },
  };
}
