import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRunLifecycle, type LifecycleDependencies } from './run-lifecycle.ts';
import { readManifest, writeManifest, createManifest } from './manifest.ts';
import type { Profile } from './profiles.ts';

const profile: Profile = { id: 'test-lifecycle', displayName: 'Original', fetch: {}, evaluation: { maxDaysOnMarket: 30 } };
const range = { from: '2026-10-20', to: '2026-10-21', label: '2026-10-20_2026-10-21' };
const instant = '2026-10-30T00:00:00.000Z';

async function fixture(fn: (deps: LifecycleDependencies) => Promise<void>) {
  const cwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ibigfun-lifecycle-'));
  process.chdir(root);
  try {
    await fn({
      now: () => instant,
      fetch: async () => { throw new Error('unexpected fetch'); },
      enrich: async () => { throw new Error('unexpected enrich'); },
      notify: () => { throw new Error('unexpected notification'); },
      emit: () => {},
    });
  } finally { process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); }
}

test('resume retries an interrupted step using the saved profile and original range, then stops for the agent', () => fixture(async (deps) => {
  const m = createManifest(profile.id, range.from, range.to, instant);
  m.profileSnapshot = profile;
  m.steps.fetch.status = 'running';
  m.steps.fetch.attempt = 1;
  writeManifest(m, instant);
  const calls: string[] = [];
  deps.fetch = async (context) => {
    assert.deepEqual(context, { profile, range });
    calls.push('fetch');
    return { summary: { count: 0 } };
  };
  deps.enrich = async () => { calls.push('enrich'); return {}; };
  const lifecycle = createRunLifecycle(deps);
  assert.equal(await lifecycle.resume({ profile: { ...profile, displayName: 'Changed' }, range }), 'report');
  assert.deepEqual(calls, ['fetch', 'enrich']);
  const saved = readManifest(profile.id, range.label)!;
  assert.equal(saved.steps.fetch.attempt, 2);
  assert.equal(saved.steps.enrich.status, 'ok');
  assert.equal(saved.steps.report.status, 'pending');
  assert.equal(await lifecycle.resume({ profile, range }), 'report');
  assert.deepEqual(calls, ['fetch', 'enrich']);
}));

test('failure alerts preserve pending delivery and marking upstream invalidates downstream work', () => fixture(async (deps) => {
  const m = createManifest(profile.id, range.from, range.to, instant);
  m.profileSnapshot = profile;
  m.steps.fetch.status = 'ok';
  m.steps.enrich.status = 'ok';
  writeManifest(m, instant);
  let alerts = 0;
  deps.notify = (params, task, file) => {
    assert.equal(params.status, 'fail');
    assert.equal(task, profile.displayName);
    assert.match(fs.readFileSync(file, 'utf8'), /temporary outage/);
    alerts++;
    return { exitCode: 0, stderr: '', command: 'fake-notifier' };
  };
  const lifecycle = createRunLifecycle(deps);
  const request = { profile, range, reason: 'temporary outage', tool: 'codex' };
  assert.equal(await lifecycle.fail(request), 'alerted');
  assert.equal(await lifecycle.fail(request), 'already-alerted');
  assert.equal(alerts, 1);
  assert.equal(readManifest(profile.id, range.label)!.steps.notify.status, 'pending');
  lifecycle.mark({ profile, range, step: 'fetch', status: 'ok' });
  const saved = readManifest(profile.id, range.label)!;
  assert.equal(saved.steps.enrich.status, 'pending');
  assert.equal(saved.steps.report.status, 'pending');
  assert.equal(saved.steps.notify.status, 'pending');
  assert.equal(saved.failure?.reason, 'temporary outage');
}));

function approve(lifecycle: ReturnType<typeof createRunLifecycle>) {
  const m = createManifest(profile.id, range.from, range.to, instant);
  m.profileSnapshot = profile;
  m.steps.fetch.status = 'ok';
  m.steps.enrich.status = 'ok';
  writeManifest(m, instant);
  const dir = path.join('state/runs', profile.id, range.label);
  fs.writeFileSync(path.join(dir, 'report.md'), 'No listings.\n本次取得 0｜推薦 0｜候選 0｜風險 0｜排除 0\n');
  fs.writeFileSync(path.join(dir, 'enriched.json'), JSON.stringify({
    listings: [], tenureEligible: 0, tenureExpired: 0, tenureReview: 0,
    marketReliable: 0, marketReview: 0, marketUnavailable: 0, marketDataStale: 0,
  }));
  lifecycle.mark({ profile, range, step: 'report', status: 'ok', artifact: path.join(dir, 'report.md'),
    notificationStatus: 'ok', title: 'Original report', tool: 'claude' });
  return dir;
}

test('failed delivery retains approval and retries only notify with the recovery title and current tool', () => fixture(async (deps) => {
  let deliveries = 0;
  deps.notify = (params, task, file) => {
    assert.equal(params.tool, 'codex');
    assert.equal(params.title, 'Original report（補送）');
    assert.equal(task, profile.displayName);
    assert.match(path.basename(file), /^approved-report-[a-f0-9]{64}\.md$/);
    deliveries++;
    return { exitCode: deliveries === 1 ? 1 : 0, stderr: 'provider error', command: 'fake-notifier' };
  };
  const lifecycle = createRunLifecycle(deps);
  approve(lifecycle);
  const approval = readManifest(profile.id, range.label)!.reportApproval;
  const request = { profile, range, recovery: true, tool: 'codex' };
  assert.equal(await lifecycle.resume(request), 'failed');
  assert.deepEqual(readManifest(profile.id, range.label)!.reportApproval, approval);
  assert.equal(await lifecycle.resume(request), 'complete');
  assert.equal(await lifecycle.resume(request), 'complete');
  assert.equal(deliveries, 2);
}));

test('changed evidence returns to report without side effects during preview, then persists invalidation', () => fixture(async (deps) => {
  const lifecycle = createRunLifecycle(deps);
  const dir = approve(lifecycle);
  const manifest = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  const journal = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8');
  fs.appendFileSync(path.join(dir, 'enriched.json'), '\n');
  const request = { profile, range, only: 'notify' };
  assert.equal(await lifecycle.resume({ ...request, dryRun: true }), 'report');
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), manifest);
  assert.equal(fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'), journal);
  assert.equal(await lifecycle.resume(request), 'report');
  const saved = readManifest(profile.id, range.label)!;
  assert.equal(saved.steps.report.status, 'pending');
  assert.equal(saved.steps.notify.status, 'pending');
  assert.equal(saved.reportApproval, undefined);
  assert.match(saved.steps.report.error!.message, /changed/);
}));

test('forcing enrichment invalidates approval even with only, and partial work retains failure', () => fixture(async (deps) => {
  deps.enrich = async () => ({});
  const lifecycle = createRunLifecycle(deps);
  approve(lifecycle);
  const m = readManifest(profile.id, range.label)!;
  m.failure = { reason: 'earlier failure', where: 'report' };
  writeManifest(m, instant);
  assert.equal(await lifecycle.resume({ profile, range, force: 'enrich', only: 'enrich' }), 'partial');
  const saved = readManifest(profile.id, range.label)!;
  assert.equal(saved.steps.fetch.status, 'ok');
  assert.equal(saved.steps.enrich.status, 'ok');
  assert.equal(saved.steps.report.status, 'pending');
  assert.equal(saved.reportApproval, undefined);
  assert.equal(saved.notify, null);
  assert.equal(saved.failure?.reason, 'earlier failure');
}));

test('failure preview writes only its details file and completed legacy runs never send again', () => fixture(async (deps) => {
  const lifecycle = createRunLifecycle(deps);
  assert.equal(await lifecycle.fail({ profile, range, reason: 'outage', tool: 'codex', dryRun: true }), 'preview');
  const dir = path.join('state/runs', profile.id, range.label);
  assert.deepEqual(fs.readdirSync(dir), ['fail-details.md']);
  const m = createManifest(profile.id, range.from, range.to, instant);
  for (const step of Object.values(m.steps)) step.status = 'ok';
  writeManifest(m, instant);
  assert.equal(await lifecycle.resume({ profile, range }), 'complete');
  lifecycle.mark({ profile, range, step: 'report', status: 'ok' });
  assert.equal(await lifecycle.fail({ profile, range, reason: 'outage', tool: 'codex' }), 'complete');
  assert.equal(readManifest(profile.id, range.label)!.reportApproval, undefined);
}));
