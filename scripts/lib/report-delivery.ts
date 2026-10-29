import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { invalidateAfter, setStep, writeManifest, type Manifest, type NotifyParams } from './manifest.ts';
import { journalLogger } from './journal.ts';
import { enrichedPath, reportPath, runDir, valuationReviewPath } from './runpaths.ts';
import { rangeLabel } from './date.ts';
import type { Profile } from './profiles.ts';
import { validateNotificationCounts, validateNotificationReport } from './report-format.ts';
import { assertReportHasResolvedRegionTriage, validateReportEvidence } from './report-notify.ts';

export interface ReportApproval {
  schemaVersion: 1;
  approvedAt: string;
  reportSha256: string;
  enrichedSha256: string;
  valuationReviewSha256: string | null;
  context: {
    profileId: string;
    from: string;
    to: string;
    profile: Profile;
    status: NotifyParams['status'];
    title: string;
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function context(m: Manifest, profile: Profile, params: NotifyParams): ReportApproval['context'] {
  return { profileId: m.profileId, from: m.from, to: m.to, profile,
    status: params.status, title: params.title };
}

function inputs(m: Manifest) {
  const label = rangeLabel(m.from, m.to);
  const reviewFile = valuationReviewPath(m.profileId, label);
  let review: Buffer | null;
  try { review = fs.readFileSync(reviewFile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    review = null;
  }
  return { report: fs.readFileSync(reportPath(m.profileId, label)),
    enriched: fs.readFileSync(enrichedPath(m.profileId, label)), review };
}

function copyPath(m: Manifest, digest: string): string {
  return path.join(runDir(m.profileId, rangeLabel(m.from, m.to)), `approved-report-${digest}.md`);
}

/** Publish complete bytes without replacing any existing approved version. */
function publishCopy(file: string, bytes: Buffer): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(tmp, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!fs.readFileSync(file).equals(bytes)) throw new Error('approved report copy is damaged; restore or remove it before approval');
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Approval commits only after its delivery copy is complete. */
export function approveReport(
  m: Manifest, profile: Profile, artifact: string, params: NotifyParams, approvedAt: string,
): void {
  if (m.steps.fetch.status !== 'ok' || m.steps.enrich.status !== 'ok') {
    throw new Error('report approval requires completed fetch and enrich steps');
  }
  if (profile.id !== m.profileId) throw new Error('report approval profile does not match run');
  if (!['ok', 'warn', 'fail'].includes(params.status) || !params.title.trim()) {
    throw new Error('report approval requires a notification status and title');
  }
  const label = rangeLabel(m.from, m.to);
  const canonical = reportPath(m.profileId, label);
  if (fs.realpathSync(artifact) !== fs.realpathSync(canonical)) {
    throw new Error('report approval requires the canonical report.md for this run');
  }
  const bytes = inputs(m);
  const report = bytes.report.toString('utf8');
  const enriched = JSON.parse(bytes.enriched.toString('utf8'));
  const review = bytes.review === null ? undefined : JSON.parse(bytes.review.toString('utf8'));
  validateNotificationReport(report);
  if (profile.evaluation.requireResolvedRegionGate) assertReportHasResolvedRegionTriage(report);
  validateReportEvidence(params.status, enriched, review);
  validateNotificationCounts(report, enriched.listings.length);
  const approval: ReportApproval = {
    schemaVersion: 1, approvedAt, reportSha256: sha256(bytes.report), enrichedSha256: sha256(bytes.enriched),
    valuationReviewSha256: bytes.review === null ? null : sha256(bytes.review),
    context: structuredClone(context(m, profile, params)),
  };
  publishCopy(copyPath(m, approval.reportSha256), bytes.report);
  const committed = structuredClone(m);
  invalidateAfter(committed, 'report');
  committed.profileSnapshot = structuredClone(profile);
  committed.notify = { ...params };
  committed.reportApproval = approval;
  setStep(committed, 'report', { status: 'ok', endedAt: approvedAt, error: null,
    artifacts: [canonical, ...(bytes.review === null ? [] : [valuationReviewPath(m.profileId, label)])] });
  writeManifest(committed, approvedAt);
  Object.assign(m, committed);
  journalLogger(m.profileId, label, 'report', () => approvedAt)
    .event('info', 'report.approved', 'report version approved');
}

/** No current-time policy reevaluation: delivery preserves the approved historical assessment. */
export function prepareReportDelivery(m: Manifest, profile: Profile): {
  params: NotifyParams; task: string; detailsFile: string;
} {
  if (!(['fetch', 'enrich', 'report'] as const).every((step) => m.steps[step].status === 'ok')) {
    throw new Error('delivery requires completed fetch, enrich, and report steps');
  }
  if (!m.profileSnapshot || !isDeepStrictEqual(m.profileSnapshot, profile)) {
    throw new Error('saved profile snapshot is missing or changed');
  }
  const approval = m.reportApproval;
  if (!approval || approval.schemaVersion !== 1) throw new Error('report approval is missing or unsupported');
  const digest = /^[a-f0-9]{64}$/;
  if (typeof approval.approvedAt !== 'string' || !Number.isFinite(Date.parse(approval.approvedAt))
    || typeof approval.reportSha256 !== 'string' || !digest.test(approval.reportSha256)
    || typeof approval.enrichedSha256 !== 'string' || !digest.test(approval.enrichedSha256)
    || !(approval.valuationReviewSha256 === null || (typeof approval.valuationReviewSha256 === 'string'
      && digest.test(approval.valuationReviewSha256)))) throw new Error('report approval is malformed');
  if (!m.notify || !isDeepStrictEqual(approval.context, context(m, profile, m.notify))) {
    throw new Error('report approval conditions changed');
  }
  const bytes = inputs(m);
  if (sha256(bytes.report) !== approval.reportSha256 || sha256(bytes.enriched) !== approval.enrichedSha256
    || (bytes.review === null ? null : sha256(bytes.review)) !== approval.valuationReviewSha256) {
    throw new Error('report or evidence changed since approval');
  }
  const detailsFile = copyPath(m, approval.reportSha256);
  if (sha256(fs.readFileSync(detailsFile)) !== approval.reportSha256) throw new Error('approved report copy is damaged');
  return { detailsFile, task: approval.context.profile.displayName,
    params: { ...m.notify, title: m.recovery && !m.notify.title.includes('補送')
      ? `${m.notify.title}（補送）` : m.notify.title } };
}
