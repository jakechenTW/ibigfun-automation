import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createManifest } from './manifest.ts';
import { readJournal } from './journal.ts';
import { runDir } from './runpaths.ts';
import { runStep } from './run.ts';

// Deterministic clock: returns a new ISO timestamp each call, 1s apart.
function fakeClock() {
  let t = Date.parse('2026-06-27T00:00:00.000Z');
  return () => { const s = new Date(t).toISOString(); t += 1000; return s; };
}

test('runStep marks ok, records summary/artifacts, journals start+end', async () => {
  const date = '0003-03-03';
  try {
    const m = createManifest(date, date, 'seed');
    const status = await runStep(m, 'fetch',
      async () => ({ summary: { listings: 3 }, artifacts: ['state/runs/0003-03-03/listings.json'] }),
      fakeClock());
    assert.equal(status, 'ok');
    assert.equal(m.steps.fetch.status, 'ok');
    assert.equal(m.steps.fetch.attempt, 1);
    assert.deepEqual(m.steps.fetch.summary, { listings: 3 });
    assert.deepEqual(m.steps.fetch.artifacts, ['state/runs/0003-03-03/listings.json']);
    assert.equal(typeof m.steps.fetch.durationMs, 'number');
    const events = readJournal(date).map((e) => e.event);
    assert.ok(events.includes('step.start'));
    assert.ok(events.includes('step.end'));
  } finally {
    fs.rmSync(runDir(date), { recursive: true, force: true });
  }
});

test('runStep marks failed and captures the error on throw', async () => {
  const date = '0003-03-04';
  try {
    const m = createManifest(date, date, 'seed');
    const status = await runStep(m, 'enrich',
      async () => { throw new Error('ORS exploded'); },
      fakeClock());
    assert.equal(status, 'failed');
    assert.equal(m.steps.enrich.status, 'failed');
    assert.equal(m.steps.enrich.error!.message, 'ORS exploded');
    assert.equal(m.steps.enrich.error!.where, 'enrich');
    const events = readJournal(date).map((e) => e.event);
    assert.ok(events.includes('step.error'));
  } finally {
    fs.rmSync(runDir(date), { recursive: true, force: true });
  }
});
