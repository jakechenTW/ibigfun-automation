import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridKey } from './grid.ts';
import { backtestTransactions } from './backtest.ts';
import { backtestExitCode, parseMarketDataArgs } from '../../market-data.ts';
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

test('quality gate fails only completed reports over a target and can be disabled', () => {
  const report = backtestTransactions(indexWithFutureLeak, { asOf: '2026-07-25' });
  const failed = { ...report, overall: { ...report.overall, caseCount: 1, medianApe: 0.13, p75Ape: 0.19 } };

  assert.equal(backtestExitCode(failed, false), 1);
  assert.equal(backtestExitCode(failed, true), 0);
});
