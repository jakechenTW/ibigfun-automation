import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridKey } from './grid.ts';
import {
  backtestSubjectFromTransaction,
  backtestTransactions,
  evaluateBacktestGate,
  type BacktestReport,
} from './backtest.ts';
import {
  backtestExitCode,
  marketUpdateExitCode,
  parseMarketDataArgs,
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
  };
}

function indexOf(transactions: MarketTransaction[]): TransactionIndex {
  return {
    schemaVersion: 1, datasetVersion: 'fixture', builtAt: '2026-07-25T00:00:00.000Z',
    cells: { [gridKey(coordinate)]: transactions },
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
});

test('CLI parsing rejects unsupported cities and invalid dates before any market-data operation', () => {
  assert.throws(() => parseMarketDataArgs(['backtest', '--city', 'invalid']), /supported city: taipei/);
  assert.throws(() => parseMarketDataArgs(['backtest', '--city', 'taipei', '--as-of', '2026-02-30']), /valid YYYY-MM-DD/);
  assert.throws(() => parseMarketDataArgs(['update', '--city', 'taipei', '--as-of', '2026-07-25']), /only by backtest/);
});

test('implicit CLI dates use the Taipei calendar at the 00:00–07:59 window and a quarter boundary', () => {
  const taipeiEarlyMorning = new Date('2026-06-30T17:30:00.000Z'); // 2026-07-01 01:30 in Taipei
  const taipeiLateMorning = new Date('2026-06-30T23:59:00.000Z'); // 2026-07-01 07:59 in Taipei

  assert.equal(parseMarketDataArgs(['backtest', '--city', 'taipei'], taipeiEarlyMorning).asOf, '2026-07-01');
  assert.equal(parseMarketDataArgs(['backtest', '--city', 'taipei'], taipeiLateMorning).asOf, '2026-07-01');
  assert.equal(parseMarketDataArgs(['update', '--city', 'taipei'], taipeiEarlyMorning).asOf, '2026-07-01');
});

test('quality gate fails only completed reports over a target and can be disabled', () => {
  const failed = completeGateReport({
    overall: { medianApe: 0.13, p75Ape: 0.19 },
  });

  assert.equal(backtestExitCode(failed, false), 1);
  assert.equal(backtestExitCode(failed, true), 0);
});

test('incomplete backtests fail the gate unless explicitly diagnostic', () => {
  const incomplete = completeGateReport({
    overall: { estimatedCount: 0, medianApe: null, p75Ape: null },
  });

  assert.equal(evaluateBacktestGate(incomplete).passed, false);
  assert.ok(evaluateBacktestGate(incomplete).reasons.includes('incomplete-overall'));
  assert.equal(backtestExitCode(incomplete, false), 1);
  assert.equal(backtestExitCode(incomplete, true), 0);
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
  high?: Partial<BacktestReport['byConfidence']['high']>;
  medium?: Partial<BacktestReport['byConfidence']['medium']>;
} = {}): BacktestReport {
  const report = backtestTransactions(indexWithFutureLeak, { asOf: '2026-07-25' });
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
    byConfidence: {
      ...report.byConfidence,
      high: metric({ medianApe: 0.08, ...overrides.high }),
      medium: metric({ medianApe: 0.10, ...overrides.medium }),
    },
  };
}
