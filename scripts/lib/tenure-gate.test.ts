import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTenureGate } from './tenure-gate.ts';

test('listing-age gate has an inclusive maximum', () => {
  assert.equal(classifyTenureGate(0, 365), 'eligible');
  assert.equal(classifyTenureGate(365, 365), 'eligible');
  assert.equal(classifyTenureGate(366, 365), 'expired');
});

test('unknown tenure requires review', () => {
  assert.equal(classifyTenureGate(null, 365), 'review');
});
