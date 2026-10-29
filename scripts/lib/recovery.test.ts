import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createManifest, STEP_ORDER, type Manifest } from './manifest.ts';

const cli = fileURLToPath(new URL('../pipeline.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
const profileId = 'test-recovery';

function fixture(fn: (f: {
  root: string;
  run: (...args: string[]) => ReturnType<typeof spawnSync>;
  seed: (date: string, modify?: (m: Manifest) => void, to?: string) => string;
  read: (label: string) => Manifest;
  sent: () => string[][];
  bodies: () => string[];
}) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ibigfun-recovery-'));
  const profile = { displayName: 'Test profile', fetch: {}, evaluation: { maxDaysOnMarket: 30 } };
  const dir = path.join(root, 'profiles', profileId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile));
  for (const file of ['evaluation.md', 'notify-template.md']) fs.writeFileSync(path.join(dir, file), 'test');
  const deliveries = path.join(root, 'deliveries.jsonl');
  const bodies = path.join(root, 'bodies.jsonl');
  const notifier = path.join(root, 'notify.mjs');
  fs.writeFileSync(notifier, '#!/usr/bin/env node\n' +
    'import fs from "node:fs"; fs.appendFileSync(process.env.DELIVERIES, JSON.stringify(process.argv.slice(2))+"\\n");\n' +
    'fs.appendFileSync(process.env.BODIES, JSON.stringify(fs.readFileSync(process.argv[process.argv.indexOf("--details-file")+1], "utf8"))+"\\n");\n');
  fs.chmodSync(notifier, 0o755);
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', loader, cli, ...args, '--profile', profileId], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NOTIFY_CMD: notifier, DELIVERIES: deliveries, BODIES: bodies },
  });
  const read = (label: string) => JSON.parse(fs.readFileSync(path.join(root, 'state/runs', profileId, label, 'manifest.json'), 'utf8')) as Manifest;
  try {
    fn({ root, read,
      run,
      seed: (date, modify = () => {}, to = date) => {
        const m = createManifest(profileId, date, to, '2026-10-27T00:00:00Z');
        m.profileSnapshot = { ...profile, id: profileId };
        modify(m);
        const label = date === to ? date : `${date}_${to}`;
        const runDir = path.join(root, 'state/runs', profileId, label);
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(m));
        fs.writeFileSync(path.join(runDir, 'report.md'), 'No listings.\n本次取得 0｜推薦 0｜候選 0｜風險 0｜排除 0\n');
        fs.writeFileSync(path.join(runDir, 'enriched.json'), JSON.stringify({
          listings: [], tenureEligible: 0, tenureExpired: 0, tenureReview: 0,
          marketReliable: 0, marketReview: 0, marketUnavailable: 0, marketDataStale: 0,
        }));
        if (m.steps.report.status === 'ok' && m.steps.notify.status !== 'ok' && m.profileSnapshot) {
          const result = run('mark', 'report', '--from', date, '--to', to, '--status', 'ok',
            '--artifact', path.join(runDir, 'report.md'), '--tool', m.notify!.tool,
            '--status-notify', m.notify!.status, '--title', m.notify!.title);
          assert.equal(result.status, 0, String(result.stderr));
          const approved = read(label);
          approved.steps.notify = m.steps.notify;
          fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(approved));
        }
        return label;
      },
      bodies: () => fs.existsSync(bodies) ? fs.readFileSync(bodies, 'utf8').trim().split('\n').map((s) => JSON.parse(s)) : [],
      sent: () => fs.existsSync(deliveries) ? fs.readFileSync(deliveries, 'utf8').trim().split('\n').map((s) => JSON.parse(s)) : [],
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function ready(m: Manifest) {
  for (const step of ['fetch', 'enrich', 'report'] as const) m.steps[step].status = 'ok';
  m.notify = { tool: 'claude', status: 'warn', title: `⚠️ ${m.from} Test｜候選 1 筆` };
}

test('recover retries old delivery once, preserves original report and skips completed/current/future runs', () => fixture((f) => {
  f.seed('2026-10-21', (m) => { ready(m); m.steps.notify.status = 'failed'; });
  f.seed('2026-10-22', (m) => { ready(m); m.steps.notify.status = 'ok'; });
  f.seed('2026-10-26', ready);
  f.seed('2026-10-28', ready);
  const result = f.run('recover', '--date', '2026-10-26', '--tool', 'codex');
  assert.equal(result.status, 0, String(result.stderr));
  const sent = f.sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], 'codex');
  assert.match(sent[0][7], /2026-10-21.*補送/);
  assert.equal(f.read('2026-10-21').steps.notify.status, 'ok');
  assert.equal(f.read('2026-10-26').steps.notify.status, 'pending');
  assert.equal(f.run('recover', '--date', '2026-10-26', '--tool', 'codex').status, 0);
  assert.equal(f.sent().length, 1);
}));

test('failure alert is separate and does not suppress a later recovered report', () => fixture((f) => {
  f.seed('2026-10-21', ready);
  assert.equal(f.run('fail', '--date', '2026-10-21', '--reason', 'temporary outage', '--tool', 'codex').status, 0);
  assert.equal(f.read('2026-10-21').steps.notify.status, 'pending');
  assert.ok(f.read('2026-10-21').failureNotification);
  assert.equal(f.run('fail', '--date', '2026-10-21', '--reason', 'still down', '--tool', 'codex').status, 0);
  assert.equal(f.sent().length, 1);
  assert.equal(f.run('recover', '--date', '2026-10-26', '--tool', 'codex').status, 0);
  assert.equal(f.sent().length, 2);
  assert.equal(f.read('2026-10-21').failure, null);
}));

test('legacy fail-notify ok is migrated and report work is returned oldest first, including ranges', () => fixture((f) => {
  f.seed('2026-10-22', (m) => {
    m.steps.fetch.status = 'ok'; m.steps.enrich.status = 'ok';
    m.steps.notify.status = 'ok'; m.failure = { reason: 'report interrupted', where: 'pipeline fail' };
  });
  f.seed('2026-10-19', (m) => { m.steps.fetch.status = 'ok'; m.steps.enrich.status = 'ok'; }, '2026-10-20');
  const result = f.run('recover', '--date', '2026-10-26', '--tool', 'codex');
  assert.equal(result.status, 0, String(result.stderr));
  const output = JSON.parse(String(result.stdout));
  assert.deepEqual(output.runs.map((r: { label: string }) => r.label), ['2026-10-19_2026-10-20', '2026-10-22']);
  assert.ok(output.runs.every((r: { outcome: string }) => r.outcome === 'report'));
  assert.equal(f.read('2026-10-22').steps.notify.status, 'pending');
  assert.equal(f.sent().length, 0);
}));

test('a missing report returns to agent work without blocking deliveries; dry-run changes nothing', () => fixture((f) => {
  const label = f.seed('2026-10-21', ready);
  f.seed('2026-10-22', ready);
  const file = path.join(f.root, 'state/runs', profileId, label, 'manifest.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(f.run('recover', '--date', '2026-10-26', '--tool', 'codex', '--dry-run').status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(f.sent().length, 0);
  fs.unlinkSync(path.join(f.root, 'state/runs', profileId, label, 'report.md'));
  const result = f.run('recover', '--date', '2026-10-26', '--tool', 'codex');
  assert.equal(result.status, 0);
  assert.equal(f.read(label).steps.report.status, 'pending');
  assert.equal(JSON.parse(String(result.stdout)).runs[0].outcome, 'report');
  assert.equal(f.read('2026-10-22').steps.notify.status, 'ok');
  assert.equal(f.sent().length, 1);
}));

test('forcing upstream work invalidates report and notification even with --only', () => fixture((f) => {
  f.seed('2026-10-21', (m) => { ready(m); m.steps.notify.status = 'ok'; });
  // A dry run never fetches or mutates the completed run.
  assert.equal(f.run('run', '--date', '2026-10-21', '--force', 'fetch', '--only', 'fetch', '--dry-run').status, 0);
  assert.ok(STEP_ORDER.every((step) => f.read('2026-10-21').steps[step].status === 'ok'));
  // The missing listings fixture makes enrichment fail before any provider calls.
  assert.equal(f.run('run', '--date', '2026-10-21', '--force', 'enrich', '--only', 'enrich').status, 1);
  const m = f.read('2026-10-21');
  assert.equal(m.steps.fetch.status, 'ok');
  assert.equal(m.steps.enrich.status, 'failed');
  assert.equal(m.steps.report.status, 'pending');
  assert.equal(m.steps.notify.status, 'pending');
  assert.equal(m.notify, null);
  assert.equal(f.sent().length, 0);
}));

test('notifier errors stay pending until a later successful invocation', () => fixture((f) => {
  f.seed('2026-10-21', ready);
  f.seed('2026-10-22', ready);
  const notifier = path.join(f.root, 'notify.mjs');
  const original = fs.readFileSync(notifier, 'utf8');
  fs.writeFileSync(notifier, original.replace('import fs',
    'if (process.argv.some((arg) => arg.includes("2026-10-21"))) process.exit(7);\nimport fs'));
  assert.equal(f.run('recover', '--date', '2026-10-26', '--tool', 'codex').status, 1);
  assert.equal(f.read('2026-10-21').steps.notify.status, 'failed');
  assert.equal(f.read('2026-10-21').steps.report.status, 'ok');
  assert.equal(f.read('2026-10-22').steps.notify.status, 'ok');
  fs.writeFileSync(notifier, original);
  assert.equal(f.run('recover', '--date', '2026-10-26', '--tool', 'codex').status, 0);
  assert.equal(f.read('2026-10-21').steps.notify.attempt, 2);
  assert.equal(f.sent().length, 2);
}));

test('a completed report mark is idempotent, and a legacy effective profile is retained', () => fixture((f) => {
  f.seed('2026-10-21', (m) => { ready(m); m.steps.notify.status = 'ok'; });
  assert.equal(f.run('mark', 'report', '--date', '2026-10-21', '--status', 'ok').status, 0);
  assert.equal(f.read('2026-10-21').steps.notify.status, 'ok');
  f.seed('2026-10-22', (m) => { ready(m); delete m.profileSnapshot; });
  fs.writeFileSync(path.join(f.root, 'state/runs', profileId, '2026-10-22', 'effective-profile.json'),
    JSON.stringify({ displayName: 'Original profile', fetch: { price_segment: { max: '1234' } } }));
  assert.equal(f.run('recover', '--date', '2026-10-26', '--tool', 'codex').status, 0);
  assert.deepEqual(f.read('2026-10-22').profileSnapshot?.fetch, { price_segment: { max: '1234' } });
  assert.equal(f.sent().length, 0);
  assert.equal(f.read('2026-10-22').steps.report.status, 'pending');
  assert.equal(f.run('mark', 'report', '--date', '2026-10-22', '--status', 'ok',
    '--artifact', path.join(f.root, 'state/runs', profileId, '2026-10-22/report.md'),
    '--tool', 'codex', '--status-notify', 'ok', '--title', 'Original report').status, 0);
  assert.equal(f.run('run', '--date', '2026-10-22').status, 0);
  assert.equal(f.sent()[0][5], 'Original profile');
}));

test('region-gated routing degradation is retried from enrich instead of recycling an unusable report input', () => fixture((f) => {
  f.seed('2026-10-21', (m) => {
    m.profileSnapshot!.evaluation.requireResolvedRegionGate = true;
    m.steps.fetch.status = 'ok'; m.steps.enrich.status = 'ok';
    m.steps.enrich.summary = { routeErrors: 2 };
  });
  assert.equal(f.run('fail', '--date', '2026-10-21', '--reason', 'route unavailable', '--tool', 'codex').status, 0);
  const m = f.read('2026-10-21');
  assert.equal(m.steps.fetch.status, 'ok');
  assert.equal(m.steps.enrich.status, 'failed');
  assert.equal(m.steps.report.status, 'pending');
  assert.equal(m.steps.notify.status, 'pending');
}));


test('forcing a report requires a new report approval before any delivery', () => fixture((f) => {
  f.seed('2026-10-21', (m) => { ready(m); m.steps.notify.status = 'ok'; });
  assert.equal(f.run('run', '--date', '2026-10-21', '--force', 'report').status, 0);
  assert.equal(f.read('2026-10-21').steps.report.status, 'pending');
  assert.equal(f.read('2026-10-21').steps.notify.status, 'pending');
  assert.equal(f.run('run', '--date', '2026-10-21').status, 0);
  assert.equal(f.sent().length, 0);
  assert.equal(f.read('2026-10-21').steps.report.status, 'pending');
}));

test('legacy report approval returns to report work without sending or changing files in dry-run', () => fixture((f) => {
  f.seed('2026-10-21', ready);
  const file = path.join(f.root, 'state/runs', profileId, '2026-10-21', 'manifest.json');
  const legacy = f.read('2026-10-21');
  delete legacy.reportApproval;
  fs.writeFileSync(file, JSON.stringify(legacy));
  const before = fs.readFileSync(file, 'utf8');
  const preview = f.run('recover', '--date', '2026-10-26', '--tool', 'codex', '--dry-run');
  assert.equal(JSON.parse(String(preview.stdout)).runs[0].outcome, 'report');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const result = f.run('recover', '--date', '2026-10-26', '--tool', 'codex');
  assert.equal(JSON.parse(String(result.stdout)).runs[0].outcome, 'report');
  assert.equal(f.read('2026-10-21').steps.report.status, 'pending');
  assert.equal(f.sent().length, 0);
}));

test('CLI approval rejects another artifact and changed approved content returns to report work', () => fixture((f) => {
  f.seed('2026-10-21', ready);
  const dir = path.join(f.root, 'state/runs', profileId, '2026-10-21');
  fs.copyFileSync(path.join(dir, 'report.md'), path.join(f.root, 'other.md'));
  const mark = (artifact: string) => f.run('mark', 'report', '--date', '2026-10-21', '--status', 'ok',
    '--artifact', artifact, '--tool', 'codex', '--status-notify', 'ok', '--title', 'Approved report');
  assert.equal(mark(path.join(f.root, 'other.md')).status, 2);
  fs.appendFileSync(path.join(dir, 'report.md'), 'Changed conclusion.\n');
  const result = f.run('recover', '--date', '2026-10-26', '--tool', 'codex');
  assert.equal(JSON.parse(String(result.stdout)).runs[0].outcome, 'report');
  assert.equal(f.read('2026-10-21').reportApproval, undefined);
  assert.equal(f.sent().length, 0);
  assert.equal(mark(path.join(dir, 'report.md')).status, 0);
  assert.equal(f.run('run', '--date', '2026-10-21').status, 0);
  assert.deepEqual(f.bodies(), [fs.readFileSync(path.join(dir, 'report.md'), 'utf8')]);
  assert.match(f.sent()[0][9], /approved-report-[a-f0-9]{64}\.md$/);
}));

for (const missing of [false, true]) {
  test(`a ${missing ? 'missing' : 'damaged'} delivery copy returns to report work even with only notify`, () => fixture((f) => {
    f.seed('2026-10-21', ready);
    const dir = path.join(f.root, 'state/runs', profileId, '2026-10-21');
    const copy = path.join(dir, fs.readdirSync(dir).find((name) => name.startsWith('approved-report-'))!);
    if (missing) fs.unlinkSync(copy);
    else fs.writeFileSync(copy, 'unapproved content');
    const result = f.run('run', '--date', '2026-10-21', '--only', 'notify');
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(f.read('2026-10-21').steps.report.status, 'pending');
    assert.equal(f.read('2026-10-21').steps.notify.status, 'pending');
    assert.equal(f.read('2026-10-21').reportApproval, undefined);
    assert.equal(f.sent().length, 0);
    assert.match(fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'), /approval-invalidated/);
  }));
}

test('an approved run with a missing profile snapshot requires reapproval before any reconstruction', () => fixture((f) => {
  f.seed('2026-10-21', (m) => { ready(m); m.profileSnapshot!.evaluation.requireResolvedRegionGate = false; });
  fs.writeFileSync(path.join(f.root, 'profiles', profileId, 'profile.json'), JSON.stringify({
    displayName: 'Test profile', fetch: {}, evaluation: { maxDaysOnMarket: 30, requireResolvedRegionGate: false },
  }));
  const dir = path.join(f.root, 'state/runs', profileId, '2026-10-21');
  const m = f.read('2026-10-21');
  delete m.profileSnapshot;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  const result = f.run('recover', '--date', '2026-10-26', '--tool', 'codex');
  assert.equal(JSON.parse(String(result.stdout)).runs[0].outcome, 'report');
  assert.equal(f.read('2026-10-21').reportApproval, undefined);
  assert.equal(f.sent().length, 0);
}));

test('a legacy report with a malformed effective profile returns report work and retains its files', () => fixture((f) => {
  f.seed('2026-10-21', (m) => { ready(m); delete m.profileSnapshot; });
  const dir = path.join(f.root, 'state/runs', profileId, '2026-10-21');
  fs.writeFileSync(path.join(dir, 'effective-profile.json'), '{broken');
  const result = f.run('recover', '--date', '2026-10-26', '--tool', 'codex');
  assert.equal(JSON.parse(String(result.stdout)).runs[0].outcome, 'report');
  assert.equal(f.read('2026-10-21').steps.report.status, 'pending');
  assert.equal(fs.readFileSync(path.join(dir, 'effective-profile.json'), 'utf8'), '{broken');
  assert.equal(f.run('mark', 'report', '--date', '2026-10-21', '--status', 'ok',
    '--artifact', path.join(dir, 'report.md'), '--tool', 'codex', '--status-notify', 'ok', '--title', 'Report').status, 2);
  assert.equal(f.sent().length, 0);
}));

test('forcing report or enrichment removes an existing approval', () => fixture((f) => {
  for (const [date, step] of [['2026-10-20', 'report'], ['2026-10-21', 'enrich']]) {
    f.seed(date, ready);
    assert.ok(f.read(date).reportApproval);
    const result = f.run('run', '--date', date, '--force', step, '--only', step);
    assert.equal(result.status, step === 'report' ? 0 : 1);
    assert.equal(f.read(date).reportApproval, undefined);
    assert.equal(f.read(date).steps.report.status, 'pending');
    assert.equal(f.read(date).steps.notify.status, 'pending');
  }
  assert.equal(f.sent().length, 0);
}));

test('a damaged saved profile returns report work without trying to render its invalid identity', () => fixture((f) => {
  f.seed('2026-10-21', ready);
  const file = path.join(f.root, 'state/runs', profileId, '2026-10-21/manifest.json');
  const m = f.read('2026-10-21');
  Object.assign(m, { profileSnapshot: {} });
  fs.writeFileSync(file, JSON.stringify(m));
  const result = f.run('recover', '--date', '2026-10-26', '--tool', 'codex');
  assert.equal(JSON.parse(String(result.stdout)).runs[0].outcome, 'report');
  assert.equal(f.read('2026-10-21').reportApproval, undefined);
  assert.equal(f.sent().length, 0);
}));
