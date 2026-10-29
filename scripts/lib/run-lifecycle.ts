import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadOrCreateManifest, readManifest, writeManifest, setStep, planNextSteps,
  clearFailure, invalidateAfter, isRunComplete, STEP_ORDER, type StepName, type NotifyParams, type Manifest } from './manifest.ts';
import { readJournal, journalLogger } from './journal.ts';
import { runStep, type StepOutput } from './run.ts';
import type { Logger } from './journal.ts';
import { defaultFailTitle, renderFailDetails, type NotifyResult } from './notify.ts';
import type { RunRange } from './range.ts';
import { runDir, valuationReviewPath, effectiveProfilePath } from './runpaths.ts';
import { parseProfile, type Profile, type RunContext } from './profiles.ts';
import { approveReport, prepareReportDelivery } from './report-delivery.ts';
import { rangeLabel } from './date.ts';

export type RunOutcome = 'complete' | 'report' | 'failed' | 'partial';
export type LifecycleEvent =
  | { type: 'approval-invalidated'; reason: string }
  | { type: 'skip'; step: StepName; reason: string }
  | { type: 'report' | 'end'; profile: Profile; range: RunRange }
  | { type: 'preview-notify'; params: NotifyParams; task: string; detailsFile: string; failure: boolean }
  | { type: 'step-failed' | 'preview-step'; step: StepName; profile: Profile; range: RunRange }
  | { type: 'delivered'; status: NotifyParams['status'] }
  | { type: 'step-ok'; step: StepName }
  | { type: 'marked'; step: StepName; status: string; profile: Profile; range: RunRange }
  | { type: 'report-already-delivered' | 'failure-already-delivered' | 'failure-already-alerted' }
  | { type: 'failure-alert-failed'; stderr: string }
  | { type: 'failure-alert-sent'; profile: Profile; range: RunRange; reason: string };

export interface LifecycleDependencies {
  now: () => string;
  fetch: (context: RunContext, logger: Logger) => Promise<StepOutput>;
  enrich: (context: RunContext, logger: Logger) => Promise<StepOutput>;
  notify: (params: NotifyParams, task: string, detailsFile: string) => NotifyResult;
  emit: (event: LifecycleEvent) => void;
}

export class LifecycleInputError extends Error {}
function fail(message: string): never { throw new LifecycleInputError(message); }
function asStep(value: string | undefined, label: string): StepName | undefined {
  if (value === undefined) return undefined;
  if (!(STEP_ORDER as string[]).includes(value)) fail(`invalid ${label} "${value}"; expected one of ${STEP_ORDER.join('|')}.`);
  return value as StepName;
}
function requiredTool(tool: string | undefined): NotifyParams['tool'] {
  if (tool !== 'codex' && tool !== 'claude') fail('--tool must be codex|claude.');
  return tool;
}

export interface ResumeRequest {
  profile: Profile;
  range: RunRange;
  dryRun?: boolean;
  recovery?: boolean;
  tool?: string;
  force?: string;
  only?: string;
}

export interface MarkRequest {
  profile: Profile;
  range: RunRange;
  step?: string;
  status?: string;
  artifact?: string;
  notificationStatus?: string;
  title?: string;
  tool?: string;
}
export interface FailureRequest {
  profile: Profile;
  range: RunRange;
  reason?: string;
  tool?: string;
  title?: string;
  dryRun?: boolean;
}

/** Older successful fetches saved effective filters outside the manifest. */
function runProfile(m: Manifest, requested: Profile): Profile {
  if (m.profileSnapshot) {
    if (m.profileSnapshot.id !== m.profileId) throw new Error('saved profile identity does not match run');
    parseProfile(m.profileId, m.profileSnapshot);
    return m.profileSnapshot;
  }
  const file = effectiveProfilePath(m.profileId, rangeLabel(m.from, m.to));
  return fs.existsSync(file)
    ? parseProfile(m.profileId, { ...requested, ...JSON.parse(fs.readFileSync(file, 'utf8')) })
    : requested;
}

/** Shared operations for ordinary runs and recovery, with real persisted state. */
export function createRunLifecycle(deps: LifecycleDependencies) {
  const { now, fetch, enrich, notify, emit } = deps;
  function returnToReport(m: Manifest, error: unknown, dryRun: boolean): void {
    const reason = (error as Error).message;
    setStep(m, 'report', { status: 'pending', error: { message: reason, where: 'report approval' } });
    invalidateAfter(m, 'report');
    emit({ type: 'approval-invalidated', reason });
    if (!dryRun) {
      writeManifest(m, now());
      journalLogger(m.profileId, rangeLabel(m.from, m.to), 'report', now)
        .event('warn', 'report.approval-invalidated', reason);
    }
  }

  async function resume(request: ResumeRequest): Promise<RunOutcome> {
    const { profile: requestedProfile, range, dryRun = false } = request;
    const m = loadOrCreateManifest(requestedProfile.id, range.from, range.to, now());
    if (request.recovery) m.recovery ??= { startedAt: now() };
    const approvalMissingProfile = !!m.reportApproval && !m.profileSnapshot;
    let profile = requestedProfile;
    try {
      if (!approvalMissingProfile) profile = runProfile(m, requestedProfile);
    } catch (error) {
      if (!isRunComplete(m) && m.steps.fetch.status === 'ok' && m.steps.enrich.status === 'ok') {
        returnToReport(m, new Error('saved profile is invalid; repair it before report approval'), dryRun);
        return 'report';
      }
      throw error;
    }
    if (!approvalMissingProfile) m.profileSnapshot ??= profile;
    if (m.notify && request.tool) m.notify.tool = requiredTool(request.tool);
    const forced = asStep(request.force, '--force');
    const only = asStep(request.only, '--only');
    if (forced) {
      setStep(m, forced, { status: 'pending' });
      invalidateAfter(m, forced);
    }
    const firstScript = (['fetch', 'enrich'] as const).find((step) =>
      (!only || only === step) && (m.steps[step].status !== 'ok' || forced === step));
    if (firstScript) invalidateAfter(m, firstScript);
    let needsApproval = false;
    if (m.steps.report.status === 'ok' && !isRunComplete(m)) {
      try { prepareReportDelivery(m, profile); }
      catch (error) {
        returnToReport(m, error, dryRun);
        needsApproval = true;
      }
    }
    if (!dryRun) writeManifest(m, now());
    if (needsApproval && only === 'notify') return 'report';
    const plan = planNextSteps(m, {
      only,
      force: forced ? [forced] : [],
    });

    for (const item of plan) {
      if (item.action === 'skip') {
        emit({ type: 'skip', step: item.step, reason: item.reason });
        continue;
      }
      if (item.step === 'report') {
        emit({ type: 'report', profile, range });
        return 'report';
      }
      if (item.step === 'notify') {
        if (!m.notify || !['fetch', 'enrich', 'report'].every((s) => m.steps[s as StepName].status === 'ok')) {
          throw new Error('notify requires completed fetch, enrich, and report steps.');
        }
        let delivery: ReturnType<typeof prepareReportDelivery>;
        try { delivery = prepareReportDelivery(m, profile); }
        catch (error) { returnToReport(m, error, dryRun); return 'report'; }
        const { params, task, detailsFile } = delivery;
        if (dryRun) {
          emit({ type: 'preview-notify', params, task, detailsFile, failure: false });
          continue;
        }
        const status = await runStep(m, 'notify', async (logger) => {
          const { exitCode, stderr, command, skipped } = notify(params, task, detailsFile);
          logger.event(exitCode === 0 ? 'info' : 'error', 'notify.sent',
            `${command} exited ${exitCode}`, { exitCode, stderr });
          if (exitCode !== 0) throw new Error(`${command} exited ${exitCode}: ${stderr.trim()}`);
          if (skipped) throw new Error('notification not delivered: no notifier installed; retained for recovery');
          return { summary: { exitCode, status: m.notify!.status } };
        }, now);
        if (status === 'failed') { emit({ type: 'step-failed', step: 'notify', profile, range }); return 'failed'; }
        emit({ type: 'delivered', status: m.notify.status });
        continue;
      }
      // script steps: fetch / enrich
      if (dryRun) {
        emit({ type: 'preview-step', step: item.step, profile, range });
        continue;
      }
      const fn = item.step === 'fetch' ? fetch : enrich;
      const status = await runStep(m, item.step, (logger) => fn({ profile, range }, logger), now);
      if (status === 'failed') {
        emit({ type: 'step-failed', step: item.step, profile, range });
        return 'failed';
      }
      emit({ type: 'step-ok', step: item.step });
    }
    clearFailure(m);
    if (!dryRun) writeManifest(m, now());
    emit({ type: 'end', profile, range });
    return isRunComplete(m) ? 'complete' : 'partial';
  }

  function mark(request: MarkRequest): void {
    const step = asStep(request.step, 'step');
    if (!step) fail('usage: pipeline mark <step> --status <ok|failed> [...]');
    let { profile } = request;
    const { range } = request;
    const m = readManifest(profile.id, range.label) ?? loadOrCreateManifest(profile.id, range.from, range.to, now());
    try { profile = runProfile(m, profile); }
    catch { fail('saved profile is invalid; repair it before report approval'); }
    const status = request.status;
    if (status !== 'ok' && status !== 'failed') fail('--status must be ok|failed.');
    if (step === 'report' && status === 'ok' && isRunComplete(m)) {
      emit({ type: 'report-already-delivered' });
      return;
    }
    const artifact = request.artifact;

    if (step === 'report' && status === 'ok') {
      const sNotify = request.notificationStatus;
      const title = request.title;
      const tool = requiredTool(request.tool);
      if (sNotify !== 'ok' && sNotify !== 'warn' && sNotify !== 'fail') {
        fail('marking report ok requires --status-notify <ok|warn|fail>.');
      }
      if (!title) fail('marking report ok requires --title "<short>".');
      if (!artifact) fail('marking report ok requires --artifact <report.md>.');
      try {
        approveReport(m, profile, artifact, { tool, status: sNotify, title }, now());
      } catch (error) {
        fail(`cannot mark report ok: ${(error as Error).message}`);
      }
      emit({ type: 'marked', step: 'report', status: 'ok', profile, range });
      return;
    }

    invalidateAfter(m, step);
    setStep(m, step, {
      status, endedAt: now(),
      artifacts: artifact
        ? [artifact, ...(step === 'report' && fs.existsSync(valuationReviewPath(profile.id, range.label))
          ? [valuationReviewPath(profile.id, range.label)] : [])]
        : m.steps[step].artifacts,
    });
    writeManifest(m, now());
    journalLogger(profile.id, range.label, step, now).event('info', 'step.mark', `marked ${step} ${status}`,
      { artifact, notify: step === 'report' ? m.notify : undefined });
    emit({ type: 'marked', step, status, profile, range });
  }

  async function recordFailure(request: FailureRequest): Promise<'complete' | 'preview' | 'already-alerted' | 'failed' | 'alerted'> {
    let { profile } = request;
    const { range } = request;
    const reason = request.reason;
    if (!reason || reason.startsWith('--')) fail('fail requires --reason "<short>".');
    const tool = requiredTool(request.tool);
    const title = request.title ?? defaultFailTitle(profile.displayName, range);
    const dryRun = request.dryRun ?? false;

    const m = readManifest(profile.id, range.label) ?? loadOrCreateManifest(profile.id, range.from, range.to, now());
    profile = m.profileSnapshot ?? profile;
    if (isRunComplete(m)) {
      emit({ type: 'failure-already-delivered' });
      return 'complete';
    }

    const tail = readJournal(profile.id, range.label).slice(-20);
    const detailsFile = path.join(runDir(profile.id, range.label), 'fail-details.md');
    fs.mkdirSync(runDir(profile.id, range.label), { recursive: true });
    fs.writeFileSync(detailsFile, renderFailDetails(profile.displayName, range, reason, tail));

    const params: NotifyParams = { tool, status: 'fail', title };
    if (dryRun) {
      emit({ type: 'preview-notify', params, task: profile.displayName, detailsFile, failure: true });
      return 'preview';
    }
    m.failure = { reason, where: 'pipeline fail' };
    // A region-gated report may have stopped because enrichment degraded without
    // throwing. Recompute primary routes on the next run, using the original fetch.
    if (profile.evaluation.requireResolvedRegionGate && Number(m.steps.enrich.summary?.routeErrors) > 0
      && m.steps.report.status !== 'ok') {
      setStep(m, 'enrich', { status: 'failed' });
      invalidateAfter(m, 'enrich');
    }
    writeManifest(m, now());
    if (m.failureNotification) {
      emit({ type: 'failure-already-alerted' });
      return 'already-alerted';
    }
    journalLogger(profile.id, range.label, 'notify', now).event('error', 'run.fail', `run failed: ${reason}`, { reason });
    const { exitCode, stderr, command, skipped } = notify(params, profile.displayName, detailsFile);
    journalLogger(profile.id, range.label, 'notify', now).event(exitCode === 0 ? 'info' : 'error', 'notify.sent',
      `fail notification ${command} exited ${exitCode}`, { exitCode, stderr });
    if (exitCode !== 0 || skipped) {
      writeManifest(m, now());
      emit({ type: 'failure-alert-failed', stderr });
      return 'failed';
    }
    m.failureNotification = { sentAt: now() };
    writeManifest(m, now());
    emit({ type: 'failure-alert-sent', profile, range, reason });
    return 'alerted';
  }

  return { resume, mark, fail: recordFailure };
}
