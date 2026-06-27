import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRange, rangeFlags } from './range.ts';

// 2026-06-27T01:00:00Z is 09:00 in Asia/Taipei → previous Taipei day = 2026-06-26.
const NOW = new Date('2026-06-27T01:00:00Z');

test('no flags → previous Taipei day as a single-day range', () => {
  assert.deepEqual(resolveRange([], NOW), {
    from: '2026-06-26', to: '2026-06-26', label: '2026-06-26',
  });
});

test('--date is a single-day range (label is the bare date)', () => {
  assert.deepEqual(resolveRange(['--date', '2026-06-20'], NOW), {
    from: '2026-06-20', to: '2026-06-20', label: '2026-06-20',
  });
});

test('--date=VALUE form is accepted', () => {
  assert.equal(resolveRange(['--date=2026-06-20'], NOW).label, '2026-06-20');
});

test('--from/--to make a multi-day range with a from_to label', () => {
  assert.deepEqual(resolveRange(['--from', '2026-06-20', '--to', '2026-06-25'], NOW), {
    from: '2026-06-20', to: '2026-06-25', label: '2026-06-20_2026-06-25',
  });
});

test('--from === --to collapses to a single-day label', () => {
  assert.equal(resolveRange(['--from', '2026-06-20', '--to', '2026-06-20'], NOW).label, '2026-06-20');
});

test('rejects --date together with --from/--to', () => {
  assert.throws(() => resolveRange(['--date', '2026-06-20', '--from', '2026-06-20', '--to', '2026-06-21'], NOW), /not both/);
});

test('rejects only one of --from/--to', () => {
  assert.throws(() => resolveRange(['--from', '2026-06-20'], NOW), /both --from and --to/);
});

test('rejects a reversed range', () => {
  assert.throws(() => resolveRange(['--from', '2026-06-25', '--to', '2026-06-20'], NOW), /after --to/);
});

test('rejects a malformed date', () => {
  assert.throws(() => resolveRange(['--date', '2026-6-1'], NOW), /invalid --date/);
});

test('rejects --date with a missing value', () => {
  assert.throws(() => resolveRange(['--date'], NOW), /invalid --date/);
});

test('rangeFlags reproduces single-day (--date) and range (--from/--to)', () => {
  assert.equal(rangeFlags({ from: '2026-06-26', to: '2026-06-26', label: '2026-06-26' }), '--date 2026-06-26');
  assert.equal(
    rangeFlags({ from: '2026-06-20', to: '2026-06-25', label: '2026-06-20_2026-06-25' }),
    '--from 2026-06-20 --to 2026-06-25',
  );
});
