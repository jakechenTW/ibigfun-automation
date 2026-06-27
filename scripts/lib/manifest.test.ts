import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  createManifest, setStep, writeManifest, readManifest, STEP_ORDER, STEP_KIND, planNextSteps,
} from './manifest.ts';
import { runDir } from './runpaths.ts';

test('createManifest seeds all four steps as pending with correct kinds', () => {
  const m = createManifest('investment', '2026-06-26', '2026-06-26', '2026-06-27T00:00:00.000Z');
  assert.deepEqual(STEP_ORDER, ['fetch', 'enrich', 'report', 'notify']);
  assert.equal(m.profileId, 'investment');
  assert.equal(m.from, '2026-06-26');
  assert.equal(m.to, '2026-06-26');
  assert.equal(m.failure, null);
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
  const m = createManifest('investment', '2026-06-26', '2026-06-26', '2026-06-27T00:00:00.000Z');
  setStep(m, 'fetch', { status: 'ok', summary: { listings: 87 } });
  assert.equal(m.steps.fetch.status, 'ok');
  assert.deepEqual(m.steps.fetch.summary, { listings: 87 });
  assert.equal(m.steps.fetch.kind, 'script'); // untouched
});

test('planNextSteps: fresh manifest runs every step in order', () => {
  const m = createManifest('investment', '2026-06-26', '2026-06-26', 'now');
  const plan = planNextSteps(m);
  assert.deepEqual(plan.map((p) => p.step), ['fetch', 'enrich', 'report', 'notify']);
  assert.ok(plan.every((p) => p.action === 'run'));
});

test('planNextSteps: ok steps are skipped, resume picks up at first non-ok', () => {
  const m = createManifest('investment', '2026-06-26', '2026-06-26', 'now');
  setStep(m, 'fetch', { status: 'ok' });
  setStep(m, 'enrich', { status: 'ok' });
  const plan = planNextSteps(m);
  assert.equal(plan.find((p) => p.step === 'fetch')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'enrich')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'report')!.action, 'run');
});

test('planNextSteps: --force re-runs an already-ok step', () => {
  const m = createManifest('investment', '2026-06-26', '2026-06-26', 'now');
  setStep(m, 'fetch', { status: 'ok' });
  const plan = planNextSteps(m, { force: ['fetch'] });
  assert.equal(plan.find((p) => p.step === 'fetch')!.action, 'run');
});

test('planNextSteps: --only runs just that step, skips the rest', () => {
  const m = createManifest('investment', '2026-06-26', '2026-06-26', 'now');
  const plan = planNextSteps(m, { only: 'enrich' });
  assert.equal(plan.find((p) => p.step === 'enrich')!.action, 'run');
  assert.equal(plan.find((p) => p.step === 'fetch')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'notify')!.action, 'skip');
});

test('planNextSteps: --from skips steps before the named one', () => {
  const m = createManifest('investment', '2026-06-26', '2026-06-26', 'now');
  const plan = planNextSteps(m, { from: 'report' });
  assert.equal(plan.find((p) => p.step === 'fetch')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'enrich')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'report')!.action, 'run');
});

test('writeManifest then readManifest round-trips and produces valid JSON', () => {
  const profileId = 'investment';
  const date = '0004-04-04';
  try {
    const m = createManifest(profileId, date, date, '2026-06-27T00:00:00.000Z');
    setStep(m, 'fetch', { status: 'ok', summary: { listings: 5 } });
    writeManifest(m, '2026-06-27T00:01:00.000Z');
    const back = readManifest(profileId, date);
    assert.equal(back!.profileId, profileId);
    assert.equal(back!.from, date);
    assert.equal(back!.to, date);
    assert.equal(back!.updatedAt, '2026-06-27T00:01:00.000Z');
    assert.equal(back!.steps.fetch.status, 'ok');
    assert.deepEqual(back!.steps.fetch.summary, { listings: 5 });
    assert.equal(fs.existsSync(`state/runs/${profileId}/${date}/manifest.json.tmp`), false);
  } finally {
    fs.rmSync(runDir(profileId, date), { recursive: true, force: true });
  }
});

test('a multi-day range writes under a profile/from_to label and round-trips', () => {
  const profileId = 'owner-occupied';
  const from = '0004-04-04', to = '0004-04-06', label = '0004-04-04_0004-04-06';
  try {
    const m = createManifest(profileId, from, to, '2026-06-27T00:00:00.000Z');
    writeManifest(m, '2026-06-27T00:01:00.000Z');
    assert.ok(fs.existsSync(`state/runs/${profileId}/${label}/manifest.json`));
    const back = readManifest(profileId, label);
    assert.equal(back!.profileId, profileId);
    assert.equal(back!.from, from);
    assert.equal(back!.to, to);
  } finally {
    fs.rmSync(runDir(profileId, label), { recursive: true, force: true });
  }
});
