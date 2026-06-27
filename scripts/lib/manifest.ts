import * as fs from 'node:fs';
import { manifestPath, runDir } from './runpaths.ts';
import { rangeLabel } from './date.ts';

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

export function createManifest(from: string, to: string, now: string): Manifest {
  return {
    from, to, createdAt: now, updatedAt: now, notify: null, failure: null,
    steps: {
      fetch: emptyStep('script'), enrich: emptyStep('script'),
      report: emptyStep('agent'), notify: emptyStep('script'),
    },
  };
}

export function readManifest(label: string): Manifest | null {
  const p = manifestPath(label);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest;
}

export function writeManifest(m: Manifest, now: string): void {
  m.updatedAt = now;
  const label = rangeLabel(m.from, m.to);
  fs.mkdirSync(runDir(label), { recursive: true });
  const final = manifestPath(label);
  const tmp = final + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, final);
}

export function loadOrCreateManifest(from: string, to: string, now: string): Manifest {
  return readManifest(rangeLabel(from, to)) ?? createManifest(from, to, now);
}

export function setStep(m: Manifest, name: StepName, patch: Partial<StepState>): void {
  m.steps[name] = { ...m.steps[name], ...patch };
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
