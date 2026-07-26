import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weightedMadOutliers, weightedQuantile } from './statistics.ts';

test('weighted quantile respects high-weight observations', () => {
  assert.equal(weightedQuantile([
    { value: 80, weight: 1 },
    { value: 100, weight: 8 },
    { value: 140, weight: 1 },
  ], 0.5), 100);
});

test('weighted quantile accepts observations without IDs when values tie', () => {
  assert.equal(weightedQuantile([
    { value: 100, weight: 1 },
    { value: 100, weight: 1 },
    { value: 120, weight: 1 },
  ], 0.5), 100);
});

test('weighted quantile rejects non-positive and non-finite weights', () => {
  assert.throws(
    () => weightedQuantile([{ id: 'bad', value: 100, weight: 0 }], 0.5),
    /positive finite weight/,
  );
  assert.throws(
    () => weightedQuantile([{ id: 'bad', value: 100, weight: Number.NaN }], 0.5),
    /positive finite weight/,
  );
});

test('weighted MAD only removes outliers when five observations establish a baseline', () => {
  const four = [100, 101, 102, 103].map((value, index) => ({ id: `four-${index}`, value, weight: 1 }));
  assert.deepEqual(weightedMadOutliers(four), []);

  const five = [100, 101, 102, 103, 1_000].map((value, index) => ({ id: `five-${index}`, value, weight: 1 }));
  assert.deepEqual(weightedMadOutliers(five).map((observation) => observation.id), ['five-4']);
});
