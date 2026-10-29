import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createManifest, readManifest, type Manifest } from './manifest.ts';
import type { Profile } from './profiles.ts';
import { approveReport, prepareReportDelivery } from './report-delivery.ts';
import { runNotify } from './notify.ts';

const body = 'No listings.\n本次取得 0｜推薦 0｜候選 0｜風險 0｜排除 0\n';
const evidence = { listings: [], tenureEligible: 0, tenureExpired: 0, tenureReview: 0,
  marketReliable: 0, marketReview: 0, marketUnavailable: 0, marketDataStale: 0 };
const profile: Profile = { id: 'approval-test', displayName: 'Test', fetch: {}, evaluation: { maxDaysOnMarket: 30 } };
const params = { tool: 'codex', status: 'ok', title: '2026-10-20 Test' } as const;
const now = '2026-10-21T00:00:00.000Z';

function fixture(fn: (m: Manifest, dir: string) => void) {
  const cwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-approval-'));
  process.chdir(root);
  try {
    const m = createManifest(profile.id, '2026-10-20', '2026-10-20', now);
    m.profileSnapshot = structuredClone(profile);
    m.steps.fetch.status = m.steps.enrich.status = 'ok';
    const dir = `state/runs/${profile.id}/2026-10-20`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/report.md`, body);
    fs.writeFileSync(`${dir}/enriched.json`, JSON.stringify(evidence));
    fn(m, dir);
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('report approval persists and delivery reads the approved copy instead of the editable report', () => fixture((m, dir) => {
  approveReport(m, profile, path.resolve(`${dir}/report.md`), params, now);
  const persisted = readManifest(profile.id, '2026-10-20')!;
  assert.equal(persisted.steps.report.status, 'ok');
  const delivery = prepareReportDelivery(persisted, profile);
  assert.notEqual(path.resolve(delivery.detailsFile), path.resolve(`${dir}/report.md`));
  fs.writeFileSync(`${dir}/report.md`, 'changed after delivery preparation');
  let received = '';
  runNotify(delivery.params, delivery.task, delivery.detailsFile, {
    spawn: (_cmd, args) => {
      received = fs.readFileSync(args[args.indexOf('--details-file') + 1], 'utf8');
      return { status: 0 };
    },
  });
  assert.equal(received, body);
}));

test('failed manifest commit leaves no usable approval even when a copy was published', () => fixture((m, dir) => {
  fs.mkdirSync(`${dir}/manifest.json`);
  assert.throws(() => approveReport(m, profile, `${dir}/report.md`, params, now));
  assert.equal(m.reportApproval, undefined);
  fs.rmdirSync(`${dir}/manifest.json`);
  assert.throws(() => prepareReportDelivery(m, profile), /completed/);
  approveReport(m, profile, `${dir}/report.md`, params, now);
  assert.equal(fs.readFileSync(prepareReportDelivery(m, profile).detailsFile, 'utf8'), body);
}));

test('delivery preparation rejects report approval after upstream or report state becomes incomplete', () => fixture((m, dir) => {
  approveReport(m, profile, `${dir}/report.md`, params, now);
  m.steps.enrich.status = 'failed';
  assert.throws(() => prepareReportDelivery(m, profile), /completed/);
}));

for (const [name, mutate] of Object.entries({
  report: (_m: Manifest, dir: string) => fs.appendFileSync(`${dir}/report.md`, ' '),
  evidence: (_m: Manifest, dir: string) => fs.appendFileSync(`${dir}/enriched.json`, ' '),
  'new valuation review': (_m: Manifest, dir: string) => fs.writeFileSync(`${dir}/valuation-review.json`, '{}'),
  'missing evidence': (_m: Manifest, dir: string) => fs.unlinkSync(`${dir}/enriched.json`),
  'missing report': (_m: Manifest, dir: string) => fs.unlinkSync(`${dir}/report.md`),
  'notification status': (m: Manifest) => { m.notify!.status = 'warn'; },
  title: (m: Manifest) => { m.notify!.title = 'Changed'; },
  'profile name': (m: Manifest) => { m.profileSnapshot!.displayName = 'Changed'; },
  evaluation: (m: Manifest) => { m.profileSnapshot!.evaluation.maxDaysOnMarket = 10; },
  filters: (m: Manifest) => { m.profileSnapshot!.fetch = { price: '1' }; },
  range: (m: Manifest) => { m.to = '2026-10-22'; },
  'unsupported version': (m: Manifest) => { Object.assign(m.reportApproval!, { schemaVersion: 99 }); },
  'malformed approval': (m: Manifest) => { Object.assign(m.reportApproval!, { reportSha256: '../report' }); },
  'missing copy': (m: Manifest) => fs.unlinkSync(prepareReportDelivery(m, m.profileSnapshot!).detailsFile),
  'damaged copy': (m: Manifest) => fs.writeFileSync(prepareReportDelivery(m, m.profileSnapshot!).detailsFile, 'changed'),
})) {
  test(`report approval rejects changed ${name}`, () => fixture((m, dir) => {
    approveReport(m, profile, `${dir}/report.md`, params, now);
    mutate(m, dir);
    assert.throws(() => prepareReportDelivery(m, m.profileSnapshot!));
  }));
}

test('report approval rejects noncanonical files and failed validation without saving approval', () => fixture((m, dir) => {
  fs.writeFileSync('different.md', body);
  assert.throws(() => approveReport(m, profile, 'different.md', params, now), /canonical/);
  for (const invalid of ['# A title', body.replace('取得 0', '取得 1')]) {
    fs.writeFileSync(`${dir}/report.md`, invalid);
    assert.throws(() => approveReport(m, profile, `${dir}/report.md`, params, now));
    assert.equal(m.reportApproval, undefined);
    assert.equal(fs.existsSync(`${dir}/manifest.json`), false);
  }
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('approved-report-')), false);
}));

test('report approval preserves tenure, market, region and review evidence gates', () => fixture((m, dir) => {
  for (const badEvidence of [{ listings: [] }, { ...evidence, marketDataStale: 1 }]) {
    fs.writeFileSync(`${dir}/enriched.json`, JSON.stringify(badEvidence));
    assert.throws(() => approveReport(m, profile, `${dir}/report.md`, params, now));
    assert.equal(m.reportApproval, undefined);
  }
  fs.writeFileSync(`${dir}/enriched.json`, JSON.stringify(evidence));
  fs.writeFileSync(`${dir}/report.md`, body + '步行時間待確認\n');
  assert.throws(() => approveReport(m, { ...profile, evaluation: { ...profile.evaluation, requireResolvedRegionGate: true } },
    `${dir}/report.md`, params, now), /triage/);
  fs.writeFileSync(`${dir}/report.md`, body);
  fs.writeFileSync(`${dir}/valuation-review.json`, '{}');
  assert.throws(() => approveReport(m, profile, `${dir}/report.md`, { ...params, status: 'warn' }, now));
  assert.equal(m.reportApproval, undefined);
}));

test('delivery preserves historical approval and allows the current agent and recovery suffix', () => fixture((m, dir) => {
  approveReport(m, profile, `${dir}/report.md`, params, now);
  m.recovery = { startedAt: '2027-01-01T00:00:00Z' };
  m.notify!.tool = 'claude';
  const delivery = prepareReportDelivery(m, profile);
  assert.deepEqual(delivery.params, { tool: 'claude', status: 'ok', title: `${params.title}（補送）` });
  assert.equal(delivery.task, 'Test');
  assert.equal(m.notify!.title, params.title);
  assert.equal(m.reportApproval!.approvedAt, now);
}));

for (const remove of [false, true]) {
  test(`report approval binds ${remove ? 'removal' : 'modification'} of existing valuation evidence`, () => fixture((m, dir) => {
    fs.writeFileSync(`${dir}/report.md`, 'No eligible listings.\n本次取得 1｜推薦 0｜候選 0｜風險 0｜排除 1\n### 排除摘要\n- 刊登超過上限：1 筆\n');
    fs.writeFileSync(`${dir}/enriched.json`, JSON.stringify({ ...evidence, tenureExpired: 1,
      listings: [{ id: 123, tenureGate: 'expired', marketEstimate: { status: 'unavailable', unavailableReasons: ['no-comparables'],
        marketUnitPriceMedian: null, marketUnitPriceP25: null, marketUnitPriceP75: null } }] }));
    fs.writeFileSync(`${dir}/valuation-review.json`, JSON.stringify({ schemaVersion: 1, reviews: [{
      listingId: 123, source: 'Test', sourceUrl: 'https://example.invalid/review', checkedAt: now,
      officialStatus: 'unavailable', officialUnavailableReasons: ['no-comparables'], externalUnitPriceWan: null,
      externalTotalPriceWan: null, officialMedianWan: null, officialP25Wan: null, officialP75Wan: null,
      differencePercent: null, accepted: false, rationale: 'No evidence', resultingBucket: 'excluded',
    }] }));
    approveReport(m, profile, `${dir}/report.md`, { ...params, status: 'warn' }, now);
    if (remove) fs.unlinkSync(`${dir}/valuation-review.json`);
    else fs.appendFileSync(`${dir}/valuation-review.json`, '\n');
    assert.throws(() => prepareReportDelivery(m, profile), /evidence changed/);
  }));
}

test('copy publication failure cannot replace an earlier approved version', () => fixture((m, dir) => {
  approveReport(m, profile, `${dir}/report.md`, params, now);
  const before = fs.readFileSync(`${dir}/manifest.json`, 'utf8');
  const delivery = prepareReportDelivery(m, profile);
  fs.writeFileSync(delivery.detailsFile, 'damaged');
  assert.throws(() => approveReport(m, profile, `${dir}/report.md`, params, now), /damaged/);
  assert.equal(fs.readFileSync(`${dir}/manifest.json`, 'utf8'), before);
  assert.equal(fs.readFileSync(delivery.detailsFile, 'utf8'), 'damaged');
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
}));

test('delivery preparation requires the saved profile snapshot, even when the caller supplies its old value', () => fixture((m, dir) => {
  approveReport(m, profile, `${dir}/report.md`, params, now);
  delete m.profileSnapshot;
  assert.throws(() => prepareReportDelivery(m, profile), /profile snapshot/);
}));
