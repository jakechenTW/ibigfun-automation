import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import {
  DOORPLATE_STALE_DAYS,
  MARKET_BACKTEST_DIAGNOSTIC_ROOT,
  MARKET_DATA_ROOT,
  SEARCH_STAGES,
  TRANSACTION_STALE_DAYS,
  WEIGHTS,
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

test('backtest diagnostics live outside the checksum-closed active build', () => {
  assert.equal(MARKET_BACKTEST_DIAGNOSTIC_ROOT, 'state/market-data/backtests/taipei');
  const active = resolve(MARKET_DATA_ROOT);
  const diagnostics = resolve(MARKET_BACKTEST_DIAGNOSTIC_ROOT);
  assert.equal(diagnostics === active || diagnostics.startsWith(`${active}${sep}`), false);
});
