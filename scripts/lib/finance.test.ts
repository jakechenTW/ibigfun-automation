import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyMortgage,
  mortgageForPrice,
  discountPercent,
  rentCoverage,
} from './finance.ts';

test('mortgageForPrice reproduces the report figure (~3,203/mo per 100萬)', () => {
  const m = mortgageForPrice(1_000_000); // 100萬 total -> 80萬 loan
  assert.ok(Math.abs(m - 3203) < 1, `got ${m}`);
});

test('zero-rate loan is principal split evenly', () => {
  assert.equal(monthlyMortgage(360000, 0, 30), 1000);
});

test('discountPercent: 55 vs 35.2 -> 36%', () => {
  assert.ok(Math.abs(discountPercent(55, 35.2) - 36.0) < 0.1);
});

test('rentCoverage: 34000 / 40449 -> ~0.84', () => {
  assert.ok(Math.abs(rentCoverage(34000, 40449) - 0.84) < 0.01);
});
