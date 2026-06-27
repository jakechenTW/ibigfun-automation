import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistory, type RawHistoryRow } from './history.ts';

const rows: RawHistoryRow[] = [
  { price: '1588', source: '樂屋網', date: '2026-06-26', active: true },
  { price: '1,588', source: '591', date: '2026-06-05', active: false }, // delisted
  { price: '1588', source: '  ', date: '2026-06-12', active: true },     // blank source
  { price: '1588', source: '591', date: '案件名稱', active: true },       // header / junk date
  { price: '', source: '好房網', date: '2026-04-04', active: false },     // empty price -> null
];

test('keeps only valid-date rows and normalizes fields', () => {
  const out = normalizeHistory(rows);
  assert.equal(out.length, 4); // the "案件名稱" junk-date row is dropped
  assert.deepEqual(out[0], { date: '2026-06-26', source: '樂屋網', price: '1588', active: true });
  assert.equal(out[1].active, false);          // delisted preserved
  assert.equal(out[1].price, '1,588');         // comma kept (parsed later)
  assert.equal(out[2].source, '');             // blank source trimmed to ''
  assert.equal(out[3].price, null);            // empty price -> null
});

test('empty input yields empty array', () => {
  assert.deepEqual(normalizeHistory([]), []);
});
