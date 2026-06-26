import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previousTaipeiDay, isValidDateString } from './date.ts';

test('previousTaipeiDay: instant in Taipei morning returns prior calendar day', () => {
  // 2026-06-27T00:30:00Z => Taipei 2026-06-27 08:30 => prev day 2026-06-26
  assert.equal(previousTaipeiDay(new Date('2026-06-27T00:30:00Z')), '2026-06-26');
});

test('previousTaipeiDay: late-UTC instant that is next day in Taipei', () => {
  // 2026-06-26T17:00:00Z => Taipei 2026-06-27 01:00 => prev day 2026-06-26
  assert.equal(previousTaipeiDay(new Date('2026-06-26T17:00:00Z')), '2026-06-26');
});

test('previousTaipeiDay: UTC instant still same Taipei day', () => {
  // 2026-06-26T15:00:00Z => Taipei 2026-06-26 23:00 => prev day 2026-06-25
  assert.equal(previousTaipeiDay(new Date('2026-06-26T15:00:00Z')), '2026-06-25');
});

test('previousTaipeiDay: crosses month boundary', () => {
  // 2026-07-01T00:00:00Z => Taipei 2026-07-01 08:00 => prev day 2026-06-30
  assert.equal(previousTaipeiDay(new Date('2026-07-01T00:00:00Z')), '2026-06-30');
});

test('isValidDateString accepts a well-formed date', () => {
  assert.equal(isValidDateString('2026-06-26'), true);
});

test('isValidDateString rejects bad month, junk, and unpadded values', () => {
  assert.equal(isValidDateString('2026-13-01'), false);
  assert.equal(isValidDateString('not-a-date'), false);
  assert.equal(isValidDateString('2026-6-1'), false);
  assert.equal(isValidDateString('2026-02-30'), false);
});
