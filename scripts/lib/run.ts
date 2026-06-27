import { Manifest, StepName, setStep, writeManifest } from './manifest.ts';
import { Logger, journalLogger } from './journal.ts';
import { rangeLabel } from './date.ts';

export interface StepOutput {
  summary?: Record<string, unknown>;
  artifacts?: string[];
}

export type StepFn = (logger: Logger) => Promise<StepOutput>;

/**
 * Run one script step under the run record: transition the manifest
 * (running → ok/failed), time it, capture errors, and bookend the journal
 * with step.start / step.end (or step.error). `now` is injected for tests.
 */
export async function runStep(
  m: Manifest,
  name: StepName,
  fn: StepFn,
  now: () => string,
): Promise<'ok' | 'failed'> {
  const logger = journalLogger(rangeLabel(m.from, m.to), name, now);
  const startedAt = now();
  const t0 = Date.parse(startedAt);
  setStep(m, name, {
    status: 'running', attempt: m.steps[name].attempt + 1,
    startedAt, endedAt: null, durationMs: null, error: null,
  });
  writeManifest(m, startedAt);
  logger.event('info', 'step.start', `${name} started`);
  try {
    const out = await fn(logger);
    const endedAt = now();
    const durationMs = Date.parse(endedAt) - t0;
    setStep(m, name, {
      status: 'ok', endedAt, durationMs,
      summary: out.summary ?? null,
      artifacts: out.artifacts ?? m.steps[name].artifacts,
    });
    writeManifest(m, endedAt);
    logger.event('info', 'step.end', `${name} ok`, { durationMs, summary: out.summary });
    return 'ok';
  } catch (e) {
    const err = e as Error;
    const endedAt = now();
    setStep(m, name, {
      status: 'failed', endedAt, durationMs: Date.parse(endedAt) - t0,
      error: { message: err.message, where: name },
    });
    writeManifest(m, endedAt);
    logger.event('error', 'step.error', `${name} failed: ${err.message}`);
    return 'failed';
  }
}
