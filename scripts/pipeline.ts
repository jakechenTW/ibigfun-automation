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
  const present = argv.some((a) => a === '--date' || a.startsWith('--date='));
  if (!present) return previousTaipeiDay(new Date());
  const raw = flag(argv, '--date');
  if (raw === undefined || raw.startsWith('--') || !isValidDateString(raw)) {
    fail(`invalid --date "${raw ?? ''}"; expected YYYY-MM-DD.`);
  }
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
