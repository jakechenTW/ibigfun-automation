import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridKey } from './grid.ts';
import {
  ACTIVE_ESTIMATOR_POLICY,
  EXPERIMENTAL_1000_METER_POLICY,
  MARKET_SCHEMA_VERSION,
} from './config.ts';
import {
  backtestAcceptance,
  backtestSubjectFromTransaction,
  backtestTransactions,
  evaluateBacktestGate,
  heldOutTransactionEligible,
  type BacktestReport,
} from './backtest.ts';
import {
  backtestExitCode,
  marketUpdateExitCode,
  shouldPersistBacktestAcceptance,
} from '../../market-data.ts';
import type { BuildingType, MarketTransaction, TransactionIndex } from './types.ts';

const coordinate = { lat: 25.033964, lng: 121.564468 };

function transaction(id: string, transactionDate: string, price: number, buildingType: BuildingType = 'apartment'): MarketTransaction {
  return {
    id,
    transactionDate,
    sourceVersion: 'fixture',
    originalAddress: `台北市中正區測試路${id}號`,
    location: {
      method: 'exact-doorplate', coordinate, normalizedAddress: `台北市中正區測試路${id}號`,
      matchedAddress: `台北市中正區測試路${id}號`, uncertaintyMeters: 0, confidence: 'high', datasetVersion: 'fixture',
    },
    district: '中正區', ownership: 'freehold', buildingType,
    totalPriceNtd: price * 300_000, buildingPriceNtd: price * 300_000, buildingAreaPing: 30,
    parkingPriceNtd: 0, parkingAreaPing: 0, buildingUnitPriceWan: price,
    floor: 3, totalFloors: buildingType === 'apartment' ? 5 : 10, floorGroup: buildingType === 'apartment' ? 'middle' : 'low',
    completionDate: buildingType === 'apartment' ? null : '2011-01-01', notes: '', exclusionFlags: [],
    eligibility: 'reliable-eligible', eligibilityReasons: [], primaryUse: 'residential', transferredBuildingCount: 1,
  };
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

test('subject-date eligibility excludes completion inconsistencies from coverage and cases', () => {
  const completedAfterSale = transaction('future-completion', '2025-12-01', 100, 'midrise');
  completedAfterSale.completionDate = '2026-01-01';

  const report = backtestTransactions(indexOf([completedAfterSale]), { asOf: '2026-07-25' });

  assert.equal(heldOutTransactionEligible(completedAfterSale), false);
  assert.equal(report.latestEligibleTransactionDate, null);
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
  assert.equal(shouldPersistBacktestAcceptance(passing, false), true);
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

test('passing acceptance records policy identity and complete transaction coverage', () => {
  const passing = completeGateReport({}, '2025-12-01');
  const acceptance = backtestAcceptance(passing, 'transactions-checksum', '2026-07-26T01:00:00.000Z');

  assert.equal(acceptance.schemaVersion, 2);
  assert.equal(acceptance.estimatorPolicyVersion, 2);
  assert.equal(acceptance.policyId, 'baseline');
  assert.equal(acceptance.evaluatedThrough, '2025-12-01');
  assert.equal(acceptance.latestEligibleTransactionDate, '2025-12-01');
  assert.equal(acceptance.thresholds.minimumEstimateCoverage, 0.70);
  assert.equal(acceptance.metrics.reliableMedianApe, 0.08);
  assert.equal(acceptance.metrics.reliableP75Ape, 0.16);
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
  assert.equal(expanded.cases.at(-1)?.estimatedUnitPriceWan, null);
  assert.equal(ACTIVE_ESTIMATOR_POLICY.id, 'baseline');
});

test('review-only source transactions are excluded from the held-out denominator', () => {
  const reviewOnly = transaction('review-only', '2025-12-01', 100);
  reviewOnly.eligibility = 'review-only';
  reviewOnly.eligibilityReasons = ['mixed-primary-use'];

  const report = backtestTransactions(indexOf([reviewOnly]), { asOf: '2026-07-25' });

  assert.equal(heldOutTransactionEligible(reviewOnly), false);
  assert.equal(report.latestEligibleTransactionDate, null);
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

function completeGateReport(overrides: {
  overall?: Partial<BacktestReport['overall']>;
  reliable?: Partial<BacktestReport['byStatus']['reliable']>;
  review?: Partial<BacktestReport['byStatus']['review']>;
  high?: Partial<BacktestReport['byConfidence']['high']>;
  medium?: Partial<BacktestReport['byConfidence']['medium']>;
} = {}, asOf = '2026-07-25'): BacktestReport {
  const report = backtestTransactions(indexWithFutureLeak, { asOf });
  const metric = (values: Partial<BacktestReport['overall']>): BacktestReport['overall'] => ({
    caseCount: 25,
    estimatedCount: 20,
    estimateCoverage: 0.8,
    medianApe: 0.08,
    p75Ape: 0.16,
    bias: 0,
    intervalCoverage: 0.5,
    ...values,
  });
  return {
    ...report,
    overall: metric(overrides.overall ?? {}),
    byStatus: {
      reliable: metric({ medianApe: 0.08, p75Ape: 0.16, ...overrides.reliable }),
      review: metric({ caseCount: 0, estimatedCount: 0, estimateCoverage: 0, medianApe: null, p75Ape: null, ...overrides.review }),
      unavailable: metric({ caseCount: 0, estimatedCount: 0, estimateCoverage: 0, medianApe: null, p75Ape: null }),
    },
    byConfidence: {
      ...report.byConfidence,
      high: metric({ medianApe: 0.08, ...overrides.high }),
      medium: metric({ medianApe: 0.10, ...overrides.medium }),
    },
  };
}
