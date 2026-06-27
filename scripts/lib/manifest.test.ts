import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createManifest, setStep, STEP_ORDER, STEP_KIND,
} from './manifest.ts';

test('createManifest seeds all four steps as pending with correct kinds', () => {
  const m = createManifest('2026-06-26', '2026-06-27T00:00:00.000Z');
  assert.deepEqual(STEP_ORDER, ['fetch', 'enrich', 'report', 'notify']);
  assert.equal(m.targetDate, '2026-06-26');
  assert.equal(m.notify, null);
  for (const name of STEP_ORDER) {
    assert.equal(m.steps[name].status, 'pending');
    assert.equal(m.steps[name].kind, STEP_KIND[name]);
    assert.equal(m.steps[name].attempt, 0);
  }
  assert.equal(m.steps.report.kind, 'agent');
  assert.equal(m.steps.notify.kind, 'script');
});

test('setStep merges a patch without dropping untouched fields', () => {
  const m = createManifest('2026-06-26', '2026-06-27T00:00:00.000Z');
  setStep(m, 'fetch', { status: 'ok', summary: { listings: 87 } });
  assert.equal(m.steps.fetch.status, 'ok');
  assert.deepEqual(m.steps.fetch.summary, { listings: 87 });
  assert.equal(m.steps.fetch.kind, 'script'); // untouched
});
