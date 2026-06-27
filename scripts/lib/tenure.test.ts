import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTenure } from './tenure.ts';
import type { ListingHistoryEntry } from './types.ts';

const e = (date: string, price: string | null, source = '591', active = true): ListingHistoryEntry => ({
  date, price, source, active,
});

test('earliest date (incl. delisted) drives firstListedDate and daysOnMarket', () => {
  const t = computeTenure(
    [e('2026-06-26', '1588', '樂屋網'), e('2026-06-05', '1,588', '591', false), e('2025-09-07', '1588', '591', false)],
    '2026-06-26',
  );
  assert.equal(t.firstListedDate, '2025-09-07');
  assert.equal(t.daysOnMarket, 292);
  assert.equal(t.recordCount, 3);
  assert.equal(t.sourceCount, 2); // 樂屋網, 591
  assert.equal(t.priceTrend, 'flat');
  assert.equal(t.firstPrice, 1588);
  assert.equal(t.latestPrice, 1588);
});

test('priceTrend dropped uses earliest vs latest by date', () => {
  const t = computeTenure([e('2026-01-01', '1680'), e('2026-03-01', '1588')], '2026-03-10');
  assert.equal(t.priceTrend, 'dropped');
  assert.equal(t.firstPrice, 1680);
  assert.equal(t.latestPrice, 1588);
});

test('priceTrend raised', () => {
  const t = computeTenure([e('2026-01-01', '1500'), e('2026-02-01', '1588')], '2026-02-10');
  assert.equal(t.priceTrend, 'raised');
});

test('no parseable prices -> unknown trend, null prices', () => {
  const t = computeTenure([e('2026-01-01', null), e('2026-02-01', '')], '2026-02-10');
  assert.equal(t.priceTrend, 'unknown');
  assert.equal(t.firstPrice, null);
  assert.equal(t.latestPrice, null);
});

test('empty history -> all null/zero/unknown', () => {
  const t = computeTenure([], '2026-06-26');
  assert.deepEqual(t, {
    firstListedDate: null, daysOnMarket: null, recordCount: 0,
    sourceCount: 0, priceTrend: 'unknown', firstPrice: null, latestPrice: null,
  });
});

test('invalid targetDate -> daysOnMarket null but rest computed', () => {
  const t = computeTenure([e('2025-09-07', '1588')], '');
  assert.equal(t.firstListedDate, '2025-09-07');
  assert.equal(t.daysOnMarket, null);
  assert.equal(t.recordCount, 1);
});

test('comma-formatted prices are parsed (comma value drives firstPrice)', () => {
  const t = computeTenure([e('2026-01-01', '1,680'), e('2026-03-01', '1588')], '2026-03-10');
  assert.equal(t.firstPrice, 1680);
  assert.equal(t.latestPrice, 1588);
  assert.equal(t.priceTrend, 'dropped');
});
