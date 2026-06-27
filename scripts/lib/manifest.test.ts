import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createManifest, setStep, STEP_ORDER, STEP_KIND, planNextSteps,
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

import { planNextSteps } from './manifest.ts';

test('planNextSteps: fresh manifest runs every step in order', () => {
  const m = createManifest('2026-06-26', 'now');
  const plan = planNextSteps(m);
  assert.deepEqual(plan.map((p) => p.step), ['fetch', 'enrich', 'report', 'notify']);
  assert.ok(plan.every((p) => p.action === 'run'));
});

test('planNextSteps: ok steps are skipped, resume picks up at first non-ok', () => {
  const m = createManifest('2026-06-26', 'now');
  setStep(m, 'fetch', { status: 'ok' });
  setStep(m, 'enrich', { status: 'ok' });
  const plan = planNextSteps(m);
  assert.equal(plan.find((p) => p.step === 'fetch')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'enrich')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'report')!.action, 'run');
});

test('planNextSteps: --force re-runs an already-ok step', () => {
  const m = createManifest('2026-06-26', 'now');
  setStep(m, 'fetch', { status: 'ok' });
  const plan = planNextSteps(m, { force: ['fetch'] });
  assert.equal(plan.find((p) => p.step === 'fetch')!.action, 'run');
});

test('planNextSteps: --only runs just that step, skips the rest', () => {
  const m = createManifest('2026-06-26', 'now');
  const plan = planNextSteps(m, { only: 'enrich' });
  assert.equal(plan.find((p) => p.step === 'enrich')!.action, 'run');
  assert.equal(plan.find((p) => p.step === 'fetch')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'notify')!.action, 'skip');
});

test('planNextSteps: --from skips steps before the named one', () => {
  const m = createManifest('2026-06-26', 'now');
  const plan = planNextSteps(m, { from: 'report' });
  assert.equal(plan.find((p) => p.step === 'fetch')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'enrich')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'report')!.action, 'run');
});
