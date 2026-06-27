# Observable / Debuggable / Resumable Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a thin orchestrator + per-run record so the daily pipeline (fetch → enrich → report → notify) is observable, debuggable, and resumable at step granularity.

**Architecture:** One target date = one run, stored under `state/runs/<date>/` as `manifest.json` (resumable state machine) + `journal.jsonl` (append-only event timeline). A thin `scripts/pipeline.ts` orchestrator runs script steps via a `runStep` wrapper, stops at agent steps, and auto-runs `notify` with idempotency + dry-run guards. Existing `fetch`/`enrich` gain an injected `Logger` so their events flow to the journal while their standalone CLIs keep working.

**Tech Stack:** TypeScript (ESM, `tsx`), Node `node:test`, `node:fs`, `node:child_process`. **Zero new dependencies.**

## Global Constraints

- **Zero new dependencies** — fs + JSONL only; no DB, no job-queue, no libs.
- **ESM imports use explicit `.ts` extensions** (e.g. `from './manifest.ts'`), matching the existing codebase.
- **Step list is exactly** `['fetch', 'enrich', 'report', 'notify']`; kinds: fetch/enrich/notify = `script`, report = `agent`.
- **Run directory is `state/runs/<date>/`** — under `state/`, which `.gitignore` already ignores (line 7: `state/`). Verify, do not re-add.
- **Safety (AGENTS.md):** nothing written to `journal.jsonl` may contain `IBIGFUN_ACCOUNT`/`IBIGFUN_PASSWORD`, cookies, `Set-Cookie`, or the login POST body. All event `data` passes through `redact()`.
- **Canonical notify command shape** (verbatim): `ai-notify --tool <codex|claude> --status <ok|warn|fail> --task "每日 iBigFun 投資房源監測" --title "<short>" --details-file reports/<date>.md`.
- **New test files must be appended to the `test` script's file list in `package.json`** so `npm test` runs them.
- **Run with** `node --import tsx --test <file>` for a single test file; `npm test` for the whole suite.

---

## File Structure

**Create:**
- `scripts/lib/runpaths.ts` — run-dir path layout (leaf module, no deps).
- `scripts/lib/manifest.ts` — manifest types, CRUD, step transitions, `planNextSteps`.
- `scripts/lib/manifest.test.ts`
- `scripts/lib/journal.ts` — `JournalEvent`, `redact`, append/read, `Logger` + console/journal loggers.
- `scripts/lib/journal.test.ts`
- `scripts/lib/run.ts` — `runStep` wrapper tying manifest + journal together.
- `scripts/lib/run.test.ts`
- `scripts/lib/notify.ts` — compose `ai-notify` argv/command (pure) + `runNotify`.
- `scripts/lib/notify.test.ts`
- `scripts/lib/steps.ts` — `fetchStep` / `enrichStep` reusable step bodies.
- `scripts/pipeline.ts` — orchestrator CLI (`run` / `status` / `mark`).

**Modify:**
- `scripts/lib/extract.ts` — accept optional `Logger`, emit structured events, return `{ listings, dropped }`.
- `scripts/lib/extract.test.ts` — update for new return shape.
- `scripts/fetch.ts` — thin wrapper over `fetchStep`.
- `scripts/enrich.ts` — thin wrapper over `enrichStep`.
- `package.json` — add `pipeline` script + register new test files.
- `AGENTS.md` — document the pipeline orchestrator.

---

## Task 1: Manifest types, paths, and CRUD

**Files:**
- Create: `scripts/lib/runpaths.ts`
- Create: `scripts/lib/manifest.ts`
- Create: `scripts/lib/manifest.test.ts`
- Modify: `package.json` (register test file)

**Interfaces:**
- Produces: `runDir(date)`, `manifestPath(date)`, `journalPath(date)` (from runpaths). `StepName`, `StepStatus`, `StepKind`, `StepState`, `NotifyParams`, `Manifest`, `STEP_ORDER`, `STEP_KIND`, `createManifest(date, now)`, `readManifest(date)`, `writeManifest(m, now)`, `loadOrCreateManifest(date, now)`, `setStep(m, name, patch)`.
- Consumes: nothing (leaf).

- [ ] **Step 1: Write `scripts/lib/runpaths.ts`**

```ts
import * as path from 'node:path';

/** Per-run directory: state/runs/<date>/ (under the git-ignored state/). */
export function runDir(date: string): string {
  return path.join('state', 'runs', date);
}
export function manifestPath(date: string): string {
  return path.join(runDir(date), 'manifest.json');
}
export function journalPath(date: string): string {
  return path.join(runDir(date), 'journal.jsonl');
}
```

- [ ] **Step 2: Write the failing test `scripts/lib/manifest.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createManifest, setStep, STEP_ORDER, STEP_KIND,
} from './manifest.ts';

test('createManifest seeds all four steps as pending with correct kinds', () => {
  const m = createManifest('2026-06-26', '2026-06-27T00:00:00.000Z');
  assert.deepEqual(STEP_ORDER, ['fetch', 'enrich', 'report', 'notify']);
  assert.equal(m.targetDate, '2026-06-26');
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
  const m = createManifest('2026-06-26', '2026-06-27T00:00:00.000Z');
  setStep(m, 'fetch', { status: 'ok', summary: { listings: 87 } });
  assert.equal(m.steps.fetch.status, 'ok');
  assert.deepEqual(m.steps.fetch.summary, { listings: 87 });
  assert.equal(m.steps.fetch.kind, 'script'); // untouched
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --import tsx --test scripts/lib/manifest.test.ts`
Expected: FAIL — `Cannot find module './manifest.ts'`.

- [ ] **Step 4: Write `scripts/lib/manifest.ts` (types + CRUD)**

```ts
import * as fs from 'node:fs';
import { manifestPath, runDir } from './runpaths.ts';

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
  targetDate: string;
  createdAt: string;
  updatedAt: string;
  notify: NotifyParams | null;
  steps: Record<StepName, StepState>;
}

function emptyStep(kind: StepKind): StepState {
  return {
    kind, status: 'pending', attempt: 0, startedAt: null, endedAt: null,
    durationMs: null, artifacts: [], summary: null, error: null,
  };
}

export function createManifest(date: string, now: string): Manifest {
  return {
    targetDate: date, createdAt: now, updatedAt: now, notify: null,
    steps: {
      fetch: emptyStep('script'), enrich: emptyStep('script'),
      report: emptyStep('agent'), notify: emptyStep('script'),
    },
  };
}

export function readManifest(date: string): Manifest | null {
  const p = manifestPath(date);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest;
}

export function writeManifest(m: Manifest, now: string): void {
  m.updatedAt = now;
  fs.mkdirSync(runDir(m.targetDate), { recursive: true });
  fs.writeFileSync(manifestPath(m.targetDate), JSON.stringify(m, null, 2));
}

export function loadOrCreateManifest(date: string, now: string): Manifest {
  return readManifest(date) ?? createManifest(date, now);
}

export function setStep(m: Manifest, name: StepName, patch: Partial<StepState>): void {
  m.steps[name] = { ...m.steps[name], ...patch };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test scripts/lib/manifest.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Register the test file in `package.json`**

In the `"test"` script string, append ` scripts/lib/manifest.test.ts` to the end of the file list (before the closing quote).

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/runpaths.ts scripts/lib/manifest.ts scripts/lib/manifest.test.ts package.json
git commit -m "feat: run manifest types, paths, and CRUD"
```

---

## Task 2: `planNextSteps` resume logic

**Files:**
- Modify: `scripts/lib/manifest.ts`
- Modify: `scripts/lib/manifest.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `STEP_ORDER`, `StepName`, `createManifest`, `setStep` (Task 1).
- Produces: `PlanOpts { only?, from?, force? }`, `PlanItem { step, action: 'run'|'skip', reason }`, `planNextSteps(m, opts?)`.

- [ ] **Step 1: Write the failing tests (append to `scripts/lib/manifest.test.ts`)**

```ts
import { planNextSteps } from './manifest.ts';

test('planNextSteps: fresh manifest runs every step in order', () => {
  const m = createManifest('2026-06-26', 'now');
  const plan = planNextSteps(m);
  assert.deepEqual(plan.map((p) => p.step), ['fetch', 'enrich', 'report', 'notify']);
  assert.ok(plan.every((p) => p.action === 'run'));
});

test('planNextSteps: ok steps are skipped, resume picks up at first non-ok', () => {
  const m = createManifest('2026-06-26', 'now');
  setStep(m, 'fetch', { status: 'ok' });
  setStep(m, 'enrich', { status: 'ok' });
  const plan = planNextSteps(m);
  assert.equal(plan.find((p) => p.step === 'fetch')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'enrich')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'report')!.action, 'run');
});

test('planNextSteps: --force re-runs an already-ok step', () => {
  const m = createManifest('2026-06-26', 'now');
  setStep(m, 'fetch', { status: 'ok' });
  const plan = planNextSteps(m, { force: ['fetch'] });
  assert.equal(plan.find((p) => p.step === 'fetch')!.action, 'run');
});

test('planNextSteps: --only runs just that step, skips the rest', () => {
  const m = createManifest('2026-06-26', 'now');
  const plan = planNextSteps(m, { only: 'enrich' });
  assert.equal(plan.find((p) => p.step === 'enrich')!.action, 'run');
  assert.equal(plan.find((p) => p.step === 'fetch')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'notify')!.action, 'skip');
});

test('planNextSteps: --from skips steps before the named one', () => {
  const m = createManifest('2026-06-26', 'now');
  const plan = planNextSteps(m, { from: 'report' });
  assert.equal(plan.find((p) => p.step === 'fetch')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'enrich')!.action, 'skip');
  assert.equal(plan.find((p) => p.step === 'report')!.action, 'run');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test scripts/lib/manifest.test.ts`
Expected: FAIL — `planNextSteps is not a function` / not exported.

- [ ] **Step 3: Implement `planNextSteps` (append to `scripts/lib/manifest.ts`)**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test scripts/lib/manifest.test.ts`
Expected: PASS (all manifest tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/manifest.ts scripts/lib/manifest.test.ts
git commit -m "feat: planNextSteps step-level resume logic"
```

---

## Task 3: Journal, redaction, and loggers

**Files:**
- Create: `scripts/lib/journal.ts`
- Create: `scripts/lib/journal.test.ts`
- Modify: `package.json` (register test file)

**Interfaces:**
- Consumes: `journalPath`, `runDir` (Task 1).
- Produces: `Level`, `JournalEvent`, `Logger { event(level, event, msg, data?) }`, `redact(value)`, `appendJournal(date, ev)`, `readJournal(date)`, `journalLogger(date, step, nowFn)`, `consoleLogger(step)`.

- [ ] **Step 1: Write the failing test `scripts/lib/journal.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from './journal.ts';

test('redact replaces secret-looking keys with [redacted]', () => {
  const out = redact({
    cookie: 'ibigfun_session=abc',
    password: 'hunter2',
    IBIGFUN_ACCOUNT: 'me@example.com',
    authorization: 'Bearer x',
    httpStatus: 429,
    url: '/on-market/123/history',
  }) as Record<string, unknown>;
  assert.equal(out.cookie, '[redacted]');
  assert.equal(out.password, '[redacted]');
  assert.equal(out.IBIGFUN_ACCOUNT, '[redacted]'); // matches /account/i
  assert.equal(out.authorization, '[redacted]');
  assert.equal(out.httpStatus, 429); // safe field kept
  assert.equal(out.url, '/on-market/123/history');
});

test('redact recurses into nested objects and arrays', () => {
  const out = redact({ resp: { setCookie: 'x', status: 200 }, ids: [1, 2] }) as any;
  assert.equal(out.resp.setCookie, '[redacted]'); // matches /cookie/i
  assert.equal(out.resp.status, 200);
  assert.deepEqual(out.ids, [1, 2]);
});

test('redact truncates long strings to a bounded snippet', () => {
  const long = 'a'.repeat(800);
  const out = redact(long) as string;
  assert.ok(out.length < 600);
  assert.ok(out.endsWith('…'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test scripts/lib/journal.test.ts`
Expected: FAIL — `Cannot find module './journal.ts'`.

- [ ] **Step 3: Write `scripts/lib/journal.ts`**

```ts
import * as fs from 'node:fs';
import { journalPath, runDir } from './runpaths.ts';

export type Level = 'info' | 'warn' | 'error';

export interface JournalEvent {
  ts: string;
  step: string;
  level: Level;
  event: string;
  msg: string;
  data?: unknown;
}

export interface Logger {
  event(level: Level, event: string, msg: string, data?: unknown): void;
}

const SECRET_KEY = /cookie|password|passwd|account|authorization|session|token|secret/i;
const SNIPPET_MAX = 500;

/** Safety net: strip secret-looking keys and cap string length before logging. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > SNIPPET_MAX ? value.slice(0, SNIPPET_MAX) + '…' : value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

export function appendJournal(date: string, ev: JournalEvent): void {
  fs.mkdirSync(runDir(date), { recursive: true });
  const safe: JournalEvent = {
    ...ev,
    data: ev.data === undefined ? undefined : redact(ev.data),
  };
  fs.appendFileSync(journalPath(date), JSON.stringify(safe) + '\n');
}

export function readJournal(date: string): JournalEvent[] {
  const p = journalPath(date);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as JournalEvent);
}

/** Logger that appends redacted events to the run journal. */
export function journalLogger(date: string, step: string, nowFn: () => string): Logger {
  return {
    event(level, event, msg, data) {
      appendJournal(date, { ts: nowFn(), step, level, event, msg, data });
    },
  };
}

/** Logger that writes to console.error — preserves standalone-CLI behavior. */
export function consoleLogger(step: string): Logger {
  return {
    event(level, _event, msg) {
      const tag = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'info';
      console.error(`${tag} ${step}: ${msg}`);
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test scripts/lib/journal.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add an append/read round-trip test (append to `scripts/lib/journal.test.ts`)**

```ts
import * as fs from 'node:fs';
import { appendJournal, readJournal } from './journal.ts';
import { runDir } from './runpaths.ts';

test('appendJournal then readJournal round-trips and redacts data', () => {
  const date = '0002-02-02'; // throwaway run dir
  try {
    appendJournal(date, { ts: 't1', step: 'fetch', level: 'info', event: 'step.start', msg: 'go' });
    appendJournal(date, { ts: 't2', step: 'fetch', level: 'error', event: 'history.drop',
      msg: 'boom', data: { cookie: 'secret', listingId: 5 } });
    const evs = readJournal(date);
    assert.equal(evs.length, 2);
    assert.equal(evs[0].event, 'step.start');
    assert.deepEqual(evs[1].data, { cookie: '[redacted]', listingId: 5 });
  } finally {
    fs.rmSync(runDir(date), { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --import tsx --test scripts/lib/journal.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Register the test file in `package.json`**

Append ` scripts/lib/journal.test.ts` to the `"test"` script file list.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/journal.ts scripts/lib/journal.test.ts package.json
git commit -m "feat: run journal with redaction and loggers"
```

---

## Task 4: `runStep` wrapper

**Files:**
- Create: `scripts/lib/run.ts`
- Create: `scripts/lib/run.test.ts`
- Modify: `package.json` (register test file)

**Interfaces:**
- Consumes: `Manifest`, `StepName`, `setStep`, `writeManifest` (Task 1); `Logger`, `journalLogger`, `readJournal` (Task 3).
- Produces: `StepOutput { summary?, artifacts? }`, `StepFn = (logger: Logger) => Promise<StepOutput>`, `runStep(m, name, fn, now) => Promise<'ok'|'failed'>`.

- [ ] **Step 1: Write the failing test `scripts/lib/run.test.ts`**

```ts
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
    const m = createManifest(date, 'seed');
    const status = await runStep(m, 'fetch',
      async () => ({ summary: { listings: 3 }, artifacts: ['state/listings-0003-03-03.json'] }),
      fakeClock());
    assert.equal(status, 'ok');
    assert.equal(m.steps.fetch.status, 'ok');
    assert.equal(m.steps.fetch.attempt, 1);
    assert.deepEqual(m.steps.fetch.summary, { listings: 3 });
    assert.deepEqual(m.steps.fetch.artifacts, ['state/listings-0003-03-03.json']);
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
    const m = createManifest(date, 'seed');
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test scripts/lib/run.test.ts`
Expected: FAIL — `Cannot find module './run.ts'`.

- [ ] **Step 3: Write `scripts/lib/run.ts`**

```ts
import { Manifest, StepName, setStep, writeManifest } from './manifest.ts';
import { Logger, journalLogger } from './journal.ts';

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
  const logger = journalLogger(m.targetDate, name, now);
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test scripts/lib/run.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Register the test file in `package.json`**

Append ` scripts/lib/run.test.ts` to the `"test"` script file list.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/run.ts scripts/lib/run.test.ts package.json
git commit -m "feat: runStep wrapper ties manifest + journal per step"
```

---

## Task 5: Notify command composition + runner

**Files:**
- Create: `scripts/lib/notify.ts`
- Create: `scripts/lib/notify.test.ts`
- Modify: `package.json` (register test file)

**Interfaces:**
- Consumes: `NotifyParams` (Task 1).
- Produces: `NOTIFY_TASK`, `composeNotifyArgs(p, date) => string[]`, `composeNotifyCommand(p, date) => string`, `runNotify(p, date) => { exitCode, stderr }`.

- [ ] **Step 1: Write the failing test `scripts/lib/notify.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeNotifyArgs, composeNotifyCommand, NOTIFY_TASK } from './notify.ts';

const params = { tool: 'claude', status: 'warn', title: '3 件待覆核' } as const;

test('composeNotifyArgs builds the canonical argv in order', () => {
  assert.deepEqual(composeNotifyArgs(params, '2026-06-26'), [
    '--tool', 'claude',
    '--status', 'warn',
    '--task', NOTIFY_TASK,
    '--title', '3 件待覆核',
    '--details-file', 'reports/2026-06-26.md',
  ]);
});

test('composeNotifyCommand quotes args with spaces for safe display', () => {
  const cmd = composeNotifyCommand(params, '2026-06-26');
  assert.ok(cmd.startsWith('ai-notify --tool claude --status warn'));
  assert.ok(cmd.includes("--task '每日 iBigFun 投資房源監測'"));
  assert.ok(cmd.includes("--title '3 件待覆核'"));
  assert.ok(cmd.includes('--details-file reports/2026-06-26.md'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test scripts/lib/notify.test.ts`
Expected: FAIL — `Cannot find module './notify.ts'`.

- [ ] **Step 3: Write `scripts/lib/notify.ts`**

```ts
import { spawnSync } from 'node:child_process';
import type { NotifyParams } from './manifest.ts';

export const NOTIFY_TASK = '每日 iBigFun 投資房源監測';

/** Canonical ai-notify argv (see AGENTS.md "Canonical Notification Command"). */
export function composeNotifyArgs(p: NotifyParams, date: string): string[] {
  return [
    '--tool', p.tool,
    '--status', p.status,
    '--task', NOTIFY_TASK,
    '--title', p.title,
    '--details-file', `reports/${date}.md`,
  ];
}

function shellQuote(arg: string): string {
  return /[^A-Za-z0-9_./-]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}

/** Human-readable command string for --dry-run / journaling. Display only. */
export function composeNotifyCommand(p: NotifyParams, date: string): string {
  return 'ai-notify ' + composeNotifyArgs(p, date).map(shellQuote).join(' ');
}

/** Execute ai-notify for real; returns its exit code + stderr. */
export function runNotify(p: NotifyParams, date: string): { exitCode: number; stderr: string } {
  const r = spawnSync('ai-notify', composeNotifyArgs(p, date), { encoding: 'utf8' });
  if (r.error) return { exitCode: 1, stderr: r.error.message };
  return { exitCode: r.status ?? 1, stderr: r.stderr ?? '' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test scripts/lib/notify.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Register the test file in `package.json`**

Append ` scripts/lib/notify.test.ts` to the `"test"` script file list.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/notify.ts scripts/lib/notify.test.ts package.json
git commit -m "feat: ai-notify command composition + runner"
```

---

## Task 6: Logger-aware fetch + `fetchStep`

**Files:**
- Modify: `scripts/lib/extract.ts`
- Modify: `scripts/lib/extract.test.ts`
- Create: `scripts/lib/steps.ts`
- Modify: `scripts/fetch.ts`

**Interfaces:**
- Consumes: `Logger`, `consoleLogger` (Task 3); existing `CollectDeps`, `defaultDeps`, `Listing`, `FetchResult`.
- Produces: `collectListings(date, deps?, logger?) => Promise<{ listings: Listing[]; dropped: number }>` (changed return shape); `fetchStep(date, logger) => Promise<StepOutput>` in `steps.ts`.

- [ ] **Step 1: Read the current `collectListings` callers**

Run: `grep -rn "collectListings" scripts`
Expected: callers are `scripts/lib/extract.test.ts` and (indirectly) `scripts/fetch.ts` via `fetchStep` after this task. Confirm no other caller relies on the old `Listing[]` return.

- [ ] **Step 2: Update `scripts/lib/extract.test.ts` for the new return shape and logger**

Find each call to `collectListings(...)` in the test. It currently returns `Listing[]`; change assertions to read `.listings`. Add a logger spy and assert a drop event is emitted. Concretely, locate the existing success-path test and adapt it; then add this test:

```ts
test('collectListings emits a history.drop event when on-market history is empty', async () => {
  const events: string[] = [];
  const logger = { event: (_l: string, ev: string) => { events.push(ev); } };
  const deps = {
    ensureSession: async () => {},
    fetchPage: async () => ({ status: 'ok', total_records: 1, per_page: 30,
      data: [{ id: 1, uuid: 'u1' }] } as any),
    fetchOnMarketHistory: async () => [],          // empty => drop
    fetchOffMarketHistory: async () => [],
  };
  const { listings, dropped } = await collectListings('2026-06-26', deps as any, logger as any);
  assert.equal(listings.length, 1);
  assert.equal(dropped, 1);
  assert.ok(events.includes('history.drop'));
});
```

(Adapt the existing assertions in this file that destructured a bare array so they read `const { listings } = await collectListings(...)`.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --import tsx --test scripts/lib/extract.test.ts`
Expected: FAIL — `collectListings(...)` returns an array (no `.listings`/`.dropped`), and `logger` arg unused.

- [ ] **Step 4: Update `scripts/lib/extract.ts`**

Add the import and an optional `logger` param defaulting to a console logger; replace the three `console.error('WARN history: …')` calls and the final summary `console.error` with structured events; return `{ listings, dropped }`.

```ts
// add to imports at top:
import { consoleLogger, type Logger } from './journal.ts';
```

Change the signature and body of `collectListings`:

```ts
export async function collectListings(
  date: string,
  deps: CollectDeps = defaultDeps(),
  logger: Logger = consoleLogger('fetch'),
): Promise<{ listings: Listing[]; dropped: number }> {
  await deps.ensureSession();

  // 1) Gather all listing rows across pages.
  const first = await deps.fetchPage(date, 1);
  const pages = Math.min(pageCount(first.total_records, first.per_page), MAX_PAGES);
  const items: ListItem[] = [];
  for (let p = 1; p <= Math.max(pages, 1); p++) {
    const res = p === 1 ? first : await deps.fetchPage(date, p);
    if (!res.data || res.data.length === 0) break;
    items.push(...res.data);
  }

  // 2) Fetch per-listing history through a small pool; skip+warn on failure.
  let dropped = 0;
  const listings = await runPool(items, HISTORY_CONCURRENCY, async (it) => {
    let on: HistoryEntry[];
    try {
      on = await deps.fetchOnMarketHistory(it.id);
    } catch (e) {
      logger.event('warn', 'history.drop',
        `listing ${it.id} on-market fetch failed after retries; dropping history`,
        { listingId: it.id, reason: (e as Error).message, phase: 'on-market' });
      dropped++;
      return apiItemToListing(it, []);
    }
    if (on.length === 0) {
      logger.event('warn', 'history.drop',
        `listing ${it.id} returned no on-market records (likely throttled); dropping history`,
        { listingId: it.id, reason: 'empty on-market', phase: 'on-market' });
      dropped++;
      return apiItemToListing(it, []);
    }
    let off: OffMarketEntry[] = [];
    try {
      off = await deps.fetchOffMarketHistory(it.uuid);
    } catch (e) {
      logger.event('warn', 'history.off-market-skip',
        `listing ${it.id} off-market fetch failed after retries; keeping on-market only`,
        { listingId: it.id, reason: (e as Error).message, phase: 'off-market' });
    }
    return apiItemToListing(it, mergeHistory(onMarketToRows(on), offMarketToRows(off)));
  });

  logger.event('info', 'history.summary',
    `${items.length - dropped} listings ok, ${dropped} dropped`,
    { ok: items.length - dropped, dropped });
  return { listings, dropped };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test scripts/lib/extract.test.ts`
Expected: PASS.

- [ ] **Step 6: Write `scripts/lib/steps.ts` with `fetchStep`**

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectListings } from './extract.ts';
import { loadEnv } from './http.ts';
import type { Logger } from './journal.ts';
import type { StepOutput } from './run.ts';
import type { FetchResult } from './types.ts';

export async function fetchStep(date: string, logger: Logger): Promise<StepOutput> {
  loadEnv();
  const { listings, dropped } = await collectListings(date, undefined, logger);
  const result: FetchResult = {
    targetDate: date,
    fetchedAt: new Date().toISOString(),
    count: listings.length,
    listings,
  };
  fs.mkdirSync('state', { recursive: true });
  const outPath = path.join('state', `listings-${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  return { summary: { listings: listings.length, historyDropped: dropped }, artifacts: [outPath] };
}
```

- [ ] **Step 7: Refactor `scripts/fetch.ts` to use `fetchStep`**

Replace the body of `main()` so it delegates to `fetchStep` with a console logger, then prints the written file to stdout (preserving current stdout behavior). Keep the `resolveTargetDate` function and the `main().catch(...)` exit-code handling unchanged.

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { previousTaipeiDay, isValidDateString } from './lib/date.ts';
import { BlockedError } from './lib/errors.ts';
import { consoleLogger } from './lib/journal.ts';
import { fetchStep } from './lib/steps.ts';

// ... resolveTargetDate unchanged ...

async function main(): Promise<void> {
  const targetDate = resolveTargetDate(process.argv.slice(2));
  const { artifacts } = await fetchStep(targetDate, consoleLogger('fetch'));
  console.error(`Wrote listings to ${artifacts[0]}`);
  process.stdout.write(fs.readFileSync(artifacts[0], 'utf8'));
}

// ... main().catch(...) unchanged ...
```

(Remove the now-unused `loadEnv`, `collectListings`, and `FetchResult` imports from `fetch.ts`; `fetchStep` owns them.)

- [ ] **Step 8: Verify fetch still type-checks and the suite passes**

Run: `npm test`
Expected: PASS (all listed test files, including the updated `extract.test.ts`).

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/extract.ts scripts/lib/extract.test.ts scripts/lib/steps.ts scripts/fetch.ts
git commit -m "feat: logger-aware collectListings + fetchStep; thin fetch CLI"
```

---

## Task 7: `enrichStep` + thin enrich CLI

**Files:**
- Modify: `scripts/lib/steps.ts`
- Modify: `scripts/enrich.ts`

**Interfaces:**
- Consumes: `Logger` (Task 3); `StepOutput` (Task 4); existing enrich helpers (`loadExits`, `enrichOffline`, `finalizeWalk`, `routeWalkDistances`, `loadCache`, `saveCache`, `cacheKey`), `EnrichResult`, `EnrichedListing`.
- Produces: `enrichStep(date, logger) => Promise<StepOutput>` in `steps.ts`.

- [ ] **Step 1: Add `enrichStep` to `scripts/lib/steps.ts`**

Move the core of `enrich.ts`'s `main()` into a reusable `enrichStep`. It reads `state/listings-<date>.json`, runs the offline + ORS routing loop, writes `state/enriched-<date>.json`, emits journal events instead of `console.error`, and returns a summary. Throw on a missing input file so `runStep` records the failure.

```ts
// add these imports at the top of steps.ts:
import { loadExits } from './mrt.ts';
import { enrichOffline } from './enrich-offline.ts';
import { finalizeWalk } from './walk.ts';
import { routeWalkDistances } from './routing.ts';
import { loadCache, saveCache, cacheKey } from './route-cache.ts';
import type { EnrichResult, EnrichedListing, FetchResult } from './types.ts';

const MRT_CSV = 'data/taipei_mrt_exits.csv';
const ORS_DELAY_MS = 1600;        // ORS free tier ~40 req/min
const ORS_RETRY_WAIT_MS = 65_000; // wait out the per-minute window once
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function enrichStep(date: string, logger: Logger): Promise<StepOutput> {
  const inPath = path.join('state', `listings-${date}.json`);
  if (!fs.existsSync(inPath)) {
    throw new Error(`${inPath} not found. Run the fetch step for ${date} first.`);
  }
  try { process.loadEnvFile('.env'); } catch { /* vars may already be exported */ }
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) {
    logger.event('warn', 'ors.missing-key',
      'ORS_API_KEY not set — walking distances unavailable; affected listings marked manual-review');
  }

  const input = JSON.parse(fs.readFileSync(inPath, 'utf8')) as FetchResult;
  const exits = loadExits(MRT_CSV);
  const cache = loadCache();

  const offline = input.listings.map((l) => enrichOffline(l, exits));
  const enriched: EnrichedListing[] = [];
  let apiCalls = 0, cacheHits = 0, routeErrors = 0;

  for (const o of offline) {
    let routed: (number | null)[] | null = null;
    const needsRoute = o.candidates.length > 0 && o.coordConsistent !== false;
    if (needsRoute) {
      const key = cacheKey(o.coordinate!, o.candidates);
      if (cache[key]) {
        routed = cache[key];
        cacheHits++;
      } else if (apiKey) {
        const dests = o.candidates.map((c) => ({ lat: c.exit.lat, lng: c.exit.lng }));
        try {
          try {
            routed = await routeWalkDistances(o.coordinate!, dests, apiKey);
          } catch (err) {
            if ((err as Error).message.includes('429')) {
              logger.event('warn', 'ors.rate-limited', 'rate-limited; waiting 65s then retrying once');
              await delay(ORS_RETRY_WAIT_MS);
              routed = await routeWalkDistances(o.coordinate!, dests, apiKey);
            } else {
              throw err;
            }
          }
          cache[key] = routed;
          apiCalls++;
          await delay(ORS_DELAY_MS);
        } catch (err) {
          routeErrors++;
          logger.event('error', 'route.error',
            `route error (${o.district ?? '?'}): ${(err as Error).message}`,
            { district: o.district, reason: (err as Error).message });
          routed = null;
        }
      }
    }
    enriched.push(finalizeWalk(o, routed, date));
  }

  const withinWalkCount = enriched.filter((l) => l.withinWalk === true).length;
  const manualReviewCount = enriched.filter((l) => l.withinWalk === null).length;
  const hardExcludedCount = enriched.filter((l) => l.hardExclusion.excluded).length;
  const result: EnrichResult = {
    targetDate: date, enrichedAt: new Date().toISOString(), count: enriched.length,
    withinWalkCount, manualReviewCount, hardExcludedCount, listings: enriched,
  };

  fs.mkdirSync('state', { recursive: true });
  saveCache(cache);
  const outPath = path.join('state', `enriched-${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  logger.event('info', 'enrich.summary',
    `enriched ${enriched.length}: ${withinWalkCount} within-walk, ${manualReviewCount} manual-review, ` +
      `${hardExcludedCount} hard-excluded (ORS ${apiCalls}, cache ${cacheHits}, errors ${routeErrors})`,
    { count: enriched.length, withinWalk: withinWalkCount, manualReview: manualReviewCount,
      hardExcluded: hardExcludedCount, orsCalls: apiCalls, cacheHits, routeErrors });
  return {
    summary: { withinWalk: withinWalkCount, manualReview: manualReviewCount,
      hardExcluded: hardExcludedCount, orsCalls: apiCalls, cacheHits, routeErrors },
    artifacts: [outPath],
  };
}
```

- [ ] **Step 2: Refactor `scripts/enrich.ts` to delegate to `enrichStep`**

Replace `main()` so it calls `enrichStep` with a console logger and prints the written file to stdout. Keep `resolveTargetDate`, but note the missing-input case is now a thrown `Error` from `enrichStep`; preserve the exit-code-2 "bad input" behavior by catching that specific case.

```ts
import * as fs from 'node:fs';
import { previousTaipeiDay, isValidDateString } from './lib/date.ts';
import { consoleLogger } from './lib/journal.ts';
import { enrichStep } from './lib/steps.ts';

function fail(message: string): never {
  console.error(`BAD INPUT: ${message}`);
  process.exit(2);
}

// ... resolveTargetDate unchanged (still calls fail(...) for a bad --date) ...

async function main(): Promise<void> {
  const targetDate = resolveTargetDate(process.argv.slice(2));
  const inPath = `state/listings-${targetDate}.json`;
  if (!fs.existsSync(inPath)) {
    fail(`${inPath} not found. Run "npm run fetch -- --date ${targetDate}" first.`);
  }
  const { artifacts } = await enrichStep(targetDate, consoleLogger('enrich'));
  console.error(`Wrote enriched listings to ${artifacts[0]}`);
  process.stdout.write(fs.readFileSync(artifacts[0], 'utf8'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

(Remove now-unused imports from `enrich.ts`: `path`, `loadExits`, `enrichOffline`, `finalizeWalk`, `routeWalkDistances`, route-cache helpers, and the enrich types — they live in `steps.ts` now.)

- [ ] **Step 3: Verify the enrich offline test and suite still pass**

Run: `npm test`
Expected: PASS. (`scripts/lib/enrich-offline.test.ts` exercises the pure enrich helpers, which are unchanged.)

- [ ] **Step 4: Smoke-test the standalone enrich CLI against committed state**

Run: `npm run enrich -- --date 2026-06-26`
Expected: writes `state/enriched-2026-06-26.json`, prints an `enrich.summary`-style line to stderr, JSON to stdout. (Uses the committed `state/listings-2026-06-26.json` + `route-cache.json`; no network needed.)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/steps.ts scripts/enrich.ts
git commit -m "feat: enrichStep + thin enrich CLI with journal events"
```

---

## Task 8: Pipeline orchestrator CLI

**Files:**
- Create: `scripts/pipeline.ts`
- Modify: `package.json` (add `pipeline` script)

**Interfaces:**
- Consumes: everything above — `loadOrCreateManifest`, `readManifest`, `writeManifest`, `setStep`, `planNextSteps`, `STEP_ORDER`, `StepName`, `NotifyParams` (Tasks 1–2); `readJournal` (Task 3); `runStep` (Task 4); `composeNotifyCommand`, `runNotify` (Task 5); `fetchStep`, `enrichStep` (Tasks 6–7).
- Produces: the `pipeline` CLI: `run`, `status`, `mark`.

- [ ] **Step 1: Write `scripts/pipeline.ts`**

```ts
/**
 * Thin pipeline orchestrator for the daily iBigFun monitor.
 *
 * Steps: fetch (script) -> enrich (script) -> report (agent) -> notify (script).
 * One run per target date, recorded under state/runs/<date>/ (manifest.json +
 * journal.jsonl). Resume = run again: ok steps are skipped, execution picks up
 * at the first non-ok step and stops at the agent `report` step.
 *
 * Commands:
 *   pipeline run    [--date <d>] [--from <step>] [--only <step>] [--force <step>] [--dry-run]
 *   pipeline status [--date <d>]
 *   pipeline mark <step> --status <ok|failed> [--artifact <p>]
 *                 [--status-notify <ok|warn|fail>] [--title <s>] [--tool <codex|claude>]
 *
 * Exit codes: 0 ok / stopped-at-agent · 1 a step failed · 2 bad input.
 */
import { previousTaipeiDay, isValidDateString } from './lib/date.ts';
import {
  loadOrCreateManifest, readManifest, writeManifest, setStep, planNextSteps,
  STEP_ORDER, type StepName, type NotifyParams,
} from './lib/manifest.ts';
import { readJournal, journalLogger } from './lib/journal.ts';
import { runStep } from './lib/run.ts';
import { composeNotifyCommand, runNotify } from './lib/notify.ts';
import { fetchStep, enrichStep } from './lib/steps.ts';

const now = () => new Date().toISOString();

function fail(msg: string): never {
  console.error(`BAD INPUT: ${msg}`);
  process.exit(2);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1];
}
function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}
function resolveDate(argv: string[]): string {
  const raw = flag(argv, '--date');
  if (raw === undefined) return previousTaipeiDay(new Date());
  if (!isValidDateString(raw)) fail(`invalid --date "${raw}"; expected YYYY-MM-DD.`);
  return raw;
}
function asStep(v: string | undefined, label: string): StepName | undefined {
  if (v === undefined) return undefined;
  if (!(STEP_ORDER as string[]).includes(v)) fail(`invalid ${label} "${v}"; expected one of ${STEP_ORDER.join('|')}.`);
  return v as StepName;
}

async function cmdRun(argv: string[]): Promise<void> {
  const date = resolveDate(argv);
  const dryRun = has(argv, '--dry-run');
  const m = loadOrCreateManifest(date, now());
  writeManifest(m, now());
  const plan = planNextSteps(m, {
    only: asStep(flag(argv, '--only'), '--only'),
    from: asStep(flag(argv, '--from'), '--from'),
    force: asStep(flag(argv, '--force'), '--force') ? [asStep(flag(argv, '--force'), '--force')!] : [],
  });

  for (const item of plan) {
    if (item.action === 'skip') {
      console.error(`· ${item.step}: skip (${item.reason})`);
      continue;
    }
    if (item.step === 'report') {
      console.error(
        `\n■ report is an agent step — it cannot be auto-run.\n` +
        `  Do the agent work (triage, estimate, evaluate, write reports/${date}.md), then run:\n` +
        `    npm run pipeline -- mark report --status ok --artifact reports/${date}.md \\\n` +
        `      --status-notify <ok|warn|fail> --title "<short>" --tool <codex|claude>\n` +
        `  Then re-run: npm run pipeline -- run --date ${date}\n`);
      process.exit(0);
    }
    if (item.step === 'notify') {
      if (!m.notify) fail('notify requires report to be marked first (--status-notify + --title set m.notify).');
      if (dryRun) {
        console.error(`[dry-run] would send:\n  ${composeNotifyCommand(m.notify, date)}`);
        continue;
      }
      const status = await runStep(m, 'notify', async (logger) => {
        const { exitCode, stderr } = runNotify(m.notify as NotifyParams, date);
        logger.event(exitCode === 0 ? 'info' : 'error', 'notify.sent',
          `ai-notify exited ${exitCode}`, { exitCode, stderr });
        if (exitCode !== 0) throw new Error(`ai-notify exited ${exitCode}: ${stderr.trim()}`);
        return { summary: { exitCode, status: m.notify!.status } };
      }, now);
      if (status === 'failed') { console.error('✗ notify failed; see status.'); process.exit(1); }
      console.error(`✓ notify sent (${m.notify.status})`);
      continue;
    }
    // script steps: fetch / enrich
    const fn = item.step === 'fetch' ? fetchStep : enrichStep;
    const status = await runStep(m, item.step, (logger) => fn(date, logger), now);
    if (status === 'failed') {
      console.error(`✗ ${item.step} failed — run "npm run pipeline -- status --date ${date}" for the error + journal.`);
      process.exit(1);
    }
    console.error(`✓ ${item.step} ok`);
  }
  console.error(`\nRun ${date} reached the end of the plan.`);
}

function cmdStatus(argv: string[]): void {
  const date = resolveDate(argv);
  const m = readManifest(date);
  if (!m) { console.error(`No run found for ${date} (state/runs/${date}/ absent).`); process.exit(0); }
  console.error(`Run ${date}  (updated ${m.updatedAt})`);
  for (const name of STEP_ORDER) {
    const s = m.steps[name];
    const dur = s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '–';
    const sum = s.summary ? ` ${JSON.stringify(s.summary)}` : '';
    console.error(`  ${name.padEnd(7)} ${s.status.padEnd(8)} ${dur}${sum}`);
    if (s.error) console.error(`      error: ${s.error.message} (at ${s.error.where})`);
  }
  if (m.notify) console.error(`  notify params: ${m.notify.tool} / ${m.notify.status} / "${m.notify.title}"`);
  const tail = readJournal(date).slice(-12);
  if (tail.length) {
    console.error(`\n  journal (last ${tail.length}):`);
    for (const e of tail) console.error(`    ${e.ts} [${e.level}] ${e.step}:${e.event} ${e.msg}`);
  }
}

function cmdMark(argv: string[]): void {
  const step = asStep(argv[0], 'step');
  if (!step) fail('usage: pipeline mark <step> --status <ok|failed> [...]');
  const date = resolveDate(argv);
  const m = readManifest(date) ?? loadOrCreateManifest(date, now());
  const status = flag(argv, '--status');
  if (status !== 'ok' && status !== 'failed') fail('--status must be ok|failed.');
  const artifact = flag(argv, '--artifact');

  if (step === 'report' && status === 'ok') {
    const sNotify = flag(argv, '--status-notify');
    const title = flag(argv, '--title');
    const tool = (flag(argv, '--tool') ?? 'claude');
    if (sNotify !== 'ok' && sNotify !== 'warn' && sNotify !== 'fail') {
      fail('marking report ok requires --status-notify <ok|warn|fail>.');
    }
    if (!title) fail('marking report ok requires --title "<short>".');
    if (tool !== 'codex' && tool !== 'claude') fail('--tool must be codex|claude.');
    m.notify = { tool, status: sNotify, title } as NotifyParams;
  }

  setStep(m, step, {
    status, endedAt: now(),
    artifacts: artifact ? [artifact] : m.steps[step].artifacts,
  });
  writeManifest(m, now());
  journalLogger(date, step, now).event('info', 'step.mark', `marked ${step} ${status}`,
    { artifact, notify: step === 'report' ? m.notify : undefined });
  console.error(`✓ marked ${step} ${status} for ${date}.`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') return cmdRun(rest);
  if (cmd === 'status') return cmdStatus(rest);
  if (cmd === 'mark') return cmdMark(rest);
  fail(`unknown command "${cmd ?? ''}"; expected run|status|mark.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add the `pipeline` script to `package.json`**

In `"scripts"`, add: `"pipeline": "tsx scripts/pipeline.ts"`.

- [ ] **Step 3: Verify `status` on a fresh date prints cleanly**

Run: `npm run pipeline -- status --date 0009-09-09`
Expected: `No run found for 0009-09-09 ...`, exit 0.

- [ ] **Step 4: Verify the mark → status flow without network**

Run:
```bash
npm run pipeline -- mark report --status ok --artifact reports/0009-09-09.md \
  --status-notify warn --title "smoke test" --tool claude
npm run pipeline -- status --date 0009-09-09
```
Expected: manifest created under `state/runs/0009-09-09/`; status shows `report ok` and `notify params: claude / warn / "smoke test"`.

- [ ] **Step 5: Verify the notify dry-run composes the command without sending**

Run: `npm run pipeline -- run --date 0009-09-09 --only notify --dry-run`
Expected: prints `[dry-run] would send:\n  ai-notify --tool claude --status warn ... --details-file reports/0009-09-09.md`; does NOT execute `ai-notify`.

- [ ] **Step 6: Clean up the smoke-test run dir**

Run: `rm -rf state/runs/0009-09-09`

- [ ] **Step 7: Commit**

```bash
git add scripts/pipeline.ts package.json
git commit -m "feat: pipeline orchestrator CLI (run/status/mark) with notify guards"
```

---

## Task 9: Document the pipeline + final suite check

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: nothing new. Documentation + verification only.

- [ ] **Step 1: Add a "Pipeline Orchestrator" subsection to `AGENTS.md`**

Under "### Tooling" (after the `route` bullet), add:

```markdown
- `npm run pipeline -- run [--date <target>]` — thin orchestrator over the daily
  steps fetch → enrich → report → notify. One run per date is recorded under
  `state/runs/<target>/` (`manifest.json` = resumable state, `journal.jsonl` =
  event timeline). Already-ok steps are skipped, so **re-running resumes** from
  the first non-ok step; it stops at the agent `report` step and prints the
  `mark` command to run when the report is written. `notify` is auto-run from the
  status/title recorded at the report mark (idempotent; `--dry-run` prints the
  composed `ai-notify` command without sending).
  - `npm run pipeline -- status [--date <target>]` — per-step status, timing,
    summary, last error, and the journal tail.
  - `npm run pipeline -- mark report --status ok --artifact reports/<target>.md
    --status-notify <ok|warn|fail> --title "<short>" --tool <codex|claude>` —
    mark the agent report step done and record the notify parameters.
  - `fetch`/`enrich` remain runnable standalone; under the pipeline their
    warnings/summaries flow to the journal instead of stderr.
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — all test files including `manifest.test.ts`, `journal.test.ts`, `run.test.ts`, `notify.test.ts`, and the updated `extract.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document the pipeline orchestrator in AGENTS.md"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** run dir + manifest (Task 1), resume/`planNextSteps` (Task 2), journal + redact (Task 3), `runStep` (Task 4), notify wrapper + compose/`--dry-run` (Tasks 5, 8), idempotency = `planNextSteps` skips ok `notify` (Task 2, exercised in Task 8), fetch/enrich logger integration (Tasks 6–7), thin orchestrator `run`/`status`/`mark` (Task 8), safety/`.gitignore` (Global Constraints + redact), docs (Task 9), tests throughout.
- **Type consistency:** `StepName`, `StepState`, `Manifest`, `NotifyParams`, `Logger`, `StepFn`/`StepOutput` names are defined once (Tasks 1, 3, 4) and reused verbatim downstream. `collectListings` return shape changes to `{ listings, dropped }` in Task 6 and every caller is updated in the same task.
- **Guard placement:** notify idempotency is the `planNextSteps` "already ok → skip" rule (no special-casing); `--dry-run` is handled in `cmdRun` before `runNotify`; a missing-report guard (`!m.notify`) fails fast before sending.
```
