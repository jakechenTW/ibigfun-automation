/**
 * Thin pipeline orchestrator for the daily iBigFun monitor.
 *
 * Steps: fetch (script) -> enrich (script) -> report (agent) -> notify (script).
 * One run per profile/date range, recorded under
 * state/runs/<profile>/<label>/ (manifest.json + journal.jsonl). Resume = run
 * again: ok steps are skipped, execution picks up at the first non-ok step and
 * stops at the agent `report` step.
 *
 * Commands:
 *   pipeline run    --profile <id> [--date <d> | --from <d> --to <d>] [--only <step>] [--force <step>] [--dry-run]
 *   pipeline status --profile <id> [--date <d> | --from <d> --to <d>]
 *   pipeline mark <step> --status <ok|failed> [--artifact <p>]
 *                 --profile <id> [--status-notify <ok|warn|fail>] [--title <s>] --tool <codex|claude>
 *   pipeline fail   --profile <id> [--date <d> | --from <d> --to <d>] --reason "<short>" --tool <codex|claude>
 *                   [--title <s>] [--dry-run]
 *
 * Default (no date flags): yesterday in Taipei time (single-day run).
 * Exit codes: 0 ok / stopped-at-agent · 1 a step failed · 2 bad input.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadOrCreateManifest, readManifest, writeManifest, setStep, planNextSteps,
  STEP_ORDER, type StepName, type NotifyParams,
} from './lib/manifest.ts';
import { readJournal, journalLogger } from './lib/journal.ts';
import { runStep } from './lib/run.ts';
import { composeNotifyCommand, runNotify, renderFailDetails } from './lib/notify.ts';
import { fetchStep, enrichStep } from './lib/steps.ts';
import { resolveRange, rangeFlags, type RunRange } from './lib/range.ts';
import { runDir, reportPath } from './lib/runpaths.ts';
import { resolveProfileFromArgs, profileFlags, type Profile } from './lib/profiles.ts';

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
function resolveProfileOrExit(argv: string[]): Profile {
  try {
    return resolveProfileFromArgs(argv);
  } catch (e) {
    fail((e as Error).message);
  }
}
function resolveRangeOrExit(argv: string[]): RunRange {
  try {
    return resolveRange(argv, new Date());
  } catch (e) {
    fail((e as Error).message);
  }
}
function asStep(v: string | undefined, label: string): StepName | undefined {
  if (v === undefined) return undefined;
  if (!(STEP_ORDER as string[]).includes(v)) fail(`invalid ${label} "${v}"; expected one of ${STEP_ORDER.join('|')}.`);
  return v as StepName;
}
function requiredTool(argv: string[]): 'codex' | 'claude' {
  const tool = flag(argv, '--tool');
  if (tool !== 'codex' && tool !== 'claude') fail('--tool must be codex|claude.');
  return tool;
}

async function cmdRun(argv: string[]): Promise<void> {
  const profile = resolveProfileOrExit(argv);
  const range = resolveRangeOrExit(argv);
  const dryRun = has(argv, '--dry-run');
  const m = loadOrCreateManifest(profile.id, range.from, range.to, now());
  writeManifest(m, now());
  const plan = planNextSteps(m, {
    only: asStep(flag(argv, '--only'), '--only'),
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
        `  Profile: ${profile.id} (${profile.displayName})\n` +
        `  Read: AGENTS.md, docs/reporting-rules.md, ${profile.ruleDocPath}\n` +
        `  Template: ${profile.templatePath}\n` +
        `  Do the agent work, write ${reportPath(profile.id, range.label)}, then run:\n` +
        `    npm run pipeline -- mark report ${profileFlags(profile)} ${rangeFlags(range)} --status ok --artifact ${reportPath(profile.id, range.label)} \\\n` +
        `      --status-notify <ok|warn|fail> --title "<short>" --tool <codex|claude>\n` +
        `  Then re-run: npm run pipeline -- run ${profileFlags(profile)} ${rangeFlags(range)}\n`);
      process.exit(0);
    }
    if (item.step === 'notify') {
      if (!m.notify) fail('notify requires report to be marked first (--status-notify + --title set m.notify).');
      if (dryRun) {
        console.error(`[dry-run] would send:\n  ${composeNotifyCommand(m.notify, profile.notifyTask, reportPath(profile.id, range.label))}`);
        continue;
      }
      const status = await runStep(m, 'notify', async (logger) => {
        const { exitCode, stderr } = runNotify(m.notify as NotifyParams, profile.notifyTask, reportPath(profile.id, range.label));
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
    const status = await runStep(m, item.step, (logger) => fn({ profile, range }, logger), now);
    if (status === 'failed') {
      console.error(`✗ ${item.step} failed — run "npm run pipeline -- status ${profileFlags(profile)} ${rangeFlags(range)}" for the error + journal.`);
      process.exit(1);
    }
    console.error(`✓ ${item.step} ok`);
  }
  console.error(`\nRun ${profile.id}/${range.label} reached the end of the plan.`);
}

function cmdStatus(argv: string[]): void {
  const profile = resolveProfileOrExit(argv);
  const range = resolveRangeOrExit(argv);
  const m = readManifest(profile.id, range.label);
  if (!m) { console.error(`No run found for ${profile.id}/${range.label} (state/runs/${profile.id}/${range.label}/ absent).`); process.exit(0); }
  console.error(`Run ${profile.id}/${range.label}  (updated ${m.updatedAt})`);
  for (const name of STEP_ORDER) {
    const s = m.steps[name];
    const dur = s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '–';
    const sum = s.summary ? ` ${JSON.stringify(s.summary)}` : '';
    console.error(`  ${name.padEnd(7)} ${s.status.padEnd(8)} ${dur}${sum}`);
    if (s.error) console.error(`      error: ${s.error.message} (at ${s.error.where})`);
  }
  if (m.failure) console.error(`  FAILED: ${m.failure.reason} (at ${m.failure.where})`);
  if (m.notify) console.error(`  notify params: ${m.notify.tool} / ${m.notify.status} / "${m.notify.title}"`);
  const tail = readJournal(profile.id, range.label).slice(-12);
  if (tail.length) {
    console.error(`\n  journal (last ${tail.length}):`);
    for (const e of tail) console.error(`    ${e.ts} [${e.level}] ${e.step}:${e.event} ${e.msg}`);
  }
}

function cmdMark(argv: string[]): void {
  const step = asStep(argv[0], 'step');
  if (!step) fail('usage: pipeline mark <step> --status <ok|failed> [...]');
  const profile = resolveProfileOrExit(argv);
  const range = resolveRangeOrExit(argv);
  const m = readManifest(profile.id, range.label) ?? loadOrCreateManifest(profile.id, range.from, range.to, now());
  const status = flag(argv, '--status');
  if (status !== 'ok' && status !== 'failed') fail('--status must be ok|failed.');
  const artifact = flag(argv, '--artifact');

  if (step === 'report' && status === 'ok') {
    const sNotify = flag(argv, '--status-notify');
    const title = flag(argv, '--title');
    const tool = requiredTool(argv);
    if (sNotify !== 'ok' && sNotify !== 'warn' && sNotify !== 'fail') {
      fail('marking report ok requires --status-notify <ok|warn|fail>.');
    }
    if (!title) fail('marking report ok requires --title "<short>".');
    m.notify = { tool, status: sNotify, title } as NotifyParams;
  }

  setStep(m, step, {
    status, endedAt: now(),
    artifacts: artifact ? [artifact] : m.steps[step].artifacts,
  });
  writeManifest(m, now());
  journalLogger(profile.id, range.label, step, now).event('info', 'step.mark', `marked ${step} ${status}`,
    { artifact, notify: step === 'report' ? m.notify : undefined });
  console.error(`✓ marked ${step} ${status} for ${profile.id}/${range.label}.`);
}

async function cmdFail(argv: string[]): Promise<void> {
  const profile = resolveProfileOrExit(argv);
  const range = resolveRangeOrExit(argv);
  const reason = flag(argv, '--reason');
  if (!reason || reason.startsWith('--')) fail('fail requires --reason "<short>".');
  const tool = requiredTool(argv);
  const title = flag(argv, '--title') ?? '每日監測中斷';
  const dryRun = has(argv, '--dry-run');

  const m = readManifest(profile.id, range.label) ?? loadOrCreateManifest(profile.id, range.from, range.to, now());
  if (m.steps.notify.status === 'ok') {
    console.error('notify already sent for this run; not sending a fail notification.');
    process.exit(0);
  }

  const tail = readJournal(profile.id, range.label).slice(-20);
  const detailsFile = path.join(runDir(profile.id, range.label), 'fail-details.md');
  fs.mkdirSync(runDir(profile.id, range.label), { recursive: true });
  fs.writeFileSync(detailsFile, renderFailDetails(profile.id, range, reason, tail));

  const params: NotifyParams = { tool, status: 'fail', title };
  if (dryRun) {
    console.error(`[dry-run] wrote ${detailsFile}; would send:\n  ${composeNotifyCommand(params, profile.notifyTask, detailsFile)}`);
    process.exit(0);
  }
  m.failure = { reason, where: 'pipeline fail' };
  journalLogger(profile.id, range.label, 'notify', now).event('error', 'run.fail', `run failed: ${reason}`, { reason });
  const { exitCode, stderr } = runNotify(params, profile.notifyTask, detailsFile);
  journalLogger(profile.id, range.label, 'notify', now).event(exitCode === 0 ? 'info' : 'error', 'notify.sent',
    `fail notification ai-notify exited ${exitCode}`, { exitCode, stderr });
  if (exitCode !== 0) {
    writeManifest(m, now());
    console.error(`✗ fail notification failed: ${stderr.trim()}`);
    process.exit(1);
  }
  setStep(m, 'notify', { status: 'ok', endedAt: now() });
  writeManifest(m, now());
  console.error(`✓ fail notification sent for ${profile.id}/${range.label} (${reason}).`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') return cmdRun(rest);
  if (cmd === 'status') return cmdStatus(rest);
  if (cmd === 'mark') return cmdMark(rest);
  if (cmd === 'fail') return cmdFail(rest);
  fail(`unknown command "${cmd ?? ''}"; expected run|status|mark|fail.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
