import * as fs from 'node:fs';
import { manifestPath, runDir } from './runpaths.ts';
import { rangeLabel } from './date.ts';
import type { Profile } from './profiles.ts';
import type { ReportApproval } from './report-delivery.ts';

export type StepName = 'fetch' | 'enrich' | 'report' | 'notify';
export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
export type StepKind = 'script' | 'agent';

export const STEP_ORDER: StepName[] = ['fetch', 'enrich', 'report', 'notify'];
export const STEP_KIND: Record<StepName, StepKind> = {
  fetch: 'script', enrich: 'script', report: 'agent', notify: 'script',
};

export interface StepState {
  kind: StepKind;
  status: StepStatus;
  attempt: number;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  artifacts: string[];
  summary: Record<string, unknown> | null;
  error: { message: string; where: string } | null;
}

export interface NotifyParams {
  tool: 'codex' | 'claude';
  status: 'ok' | 'warn' | 'fail';
  title: string;
}

export interface Manifest {
  reportApproval?: ReportApproval;
  profileSnapshot?: Profile;
  failureNotification?: { sentAt: string };
  recovery?: { startedAt: string };
  profileId: string;
  from: string;
  to: string;
  createdAt: string;
  updatedAt: string;
  notify: NotifyParams | null;
  steps: Record<StepName, StepState>;
  failure: { reason: string; where: string } | null;
}

function emptyStep(kind: StepKind): StepState {
  return {
    kind, status: 'pending', attempt: 0, startedAt: null, endedAt: null,
    durationMs: null, artifacts: [], summary: null, error: null,
  };
}

export function createManifest(profileId: string, from: string, to: string, now: string): Manifest {
  return {
    profileId, from, to, createdAt: now, updatedAt: now, notify: null, failure: null,
    steps: {
      fetch: emptyStep('script'), enrich: emptyStep('script'),
      report: emptyStep('agent'), notify: emptyStep('script'),
    },
  };
}

export function readManifest(profileId: string, label: string): Manifest | null {
  const p = manifestPath(profileId, label);
  if (!fs.existsSync(p)) return null;
  const m = JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest;
  // Older versions used the report delivery slot for the failure alert.
  if (m.failure && m.steps.notify.status === 'ok' && !m.failureNotification) {
    m.failureNotification = { sentAt: m.steps.notify.endedAt ?? m.updatedAt };
    setStep(m, 'notify', { status: 'pending', endedAt: null, summary: null });
  }
  return m;
}

export function writeManifest(m: Manifest, now: string): void {
  m.updatedAt = now;
  const label = rangeLabel(m.from, m.to);
  fs.mkdirSync(runDir(m.profileId, label), { recursive: true });
  const final = manifestPath(m.profileId, label);
  const tmp = final + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, final);
}

export function loadOrCreateManifest(profileId: string, from: string, to: string, now: string): Manifest {
  return readManifest(profileId, rangeLabel(from, to)) ?? createManifest(profileId, from, to, now);
}

export function setStep(m: Manifest, name: StepName, patch: Partial<StepState>): void {
  m.steps[name] = { ...m.steps[name], ...patch };
}

/** Clear a prior headless failure once a later resumed run completes. */
export function clearFailure(m: Manifest): void {
  if (isRunComplete(m)) m.failure = null;
}

export function isRunComplete(m: Manifest): boolean {
  return STEP_ORDER.every((step) => m.steps[step].status === 'ok');
}

/** Any changed upstream artifact requires a new report and delivery. */
export function invalidateAfter(m: Manifest, step: StepName): void {
  for (const name of STEP_ORDER.slice(STEP_ORDER.indexOf(step) + 1)) {
    m.steps[name] = emptyStep(STEP_KIND[name]);
  }
  if (step === 'fetch' || step === 'enrich' || step === 'report') delete m.reportApproval;
  if (step === 'fetch' || step === 'enrich') m.notify = null;
}

export interface PlanOpts {
  only?: StepName;
  from?: StepName;
  force?: StepName[];
}
export interface PlanItem {
  step: StepName;
  action: 'run' | 'skip';
  reason: string;
}

/**
 * Pure resume logic: given a manifest and options, decide which steps to run.
 * Skips already-ok steps (resume picks up at the first non-ok step); honors
 * --only / --from / --force. Execution-time control (stop at first failure,
 * halt at agent steps) lives in pipeline.ts, not here.
 */
export function planNextSteps(m: Manifest, opts: PlanOpts = {}): PlanItem[] {
  const force = new Set(opts.force ?? []);
  const fromIdx = opts.from ? STEP_ORDER.indexOf(opts.from) : 0;
  return STEP_ORDER.map((step, idx): PlanItem => {
    if (opts.only && step !== opts.only) return { step, action: 'skip', reason: 'not --only target' };
    if (idx < fromIdx) return { step, action: 'skip', reason: 'before --from' };
    if (force.has(step)) return { step, action: 'run', reason: 'forced' };
    if (m.steps[step].status === 'ok') return { step, action: 'skip', reason: 'already ok' };
    return { step, action: 'run', reason: 'not yet ok' };
  });
}
