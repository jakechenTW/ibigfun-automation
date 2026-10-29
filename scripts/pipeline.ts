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
 *   pipeline recover --profile <id> [--date <d> | --from <d> --to <d>] --tool <codex|claude> [--dry-run]
 *   pipeline mark <step> --status <ok|failed> [--artifact <p>]
 *                 --profile <id> [--status-notify <ok|warn|fail>] [--title <s>] --tool <codex|claude>
 *   pipeline fail   --profile <id> [--date <d> | --from <d> --to <d>] --reason "<short>" --tool <codex|claude>
 *                   [--title <s>] [--dry-run]
 *
 * Default (no date flags): yesterday in Taipei time (single-day run).
 * Exit codes: 0 ok / stopped-at-agent · 1 a step failed · 2 bad input.
 */
import { readManifest, STEP_ORDER, type StepName } from './lib/manifest.ts';
import { readJournal } from './lib/journal.ts';
import { composeNotifyCommand, runNotify } from './lib/notify.ts';
import { fetchStep, enrichStep } from './lib/steps.ts';
import { resolveRange, rangeFlags, type RunRange } from './lib/range.ts';
import { reportPath } from './lib/runpaths.ts';
import { resolveProfileFromArgs, profileFlags, type Profile } from './lib/profiles.ts';
import { recoveryBacklog } from './lib/recovery.ts';
import { createRunLifecycle, LifecycleInputError, type LifecycleEvent } from './lib/run-lifecycle.ts';

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

function renderLifecycleEvent(event: LifecycleEvent): void {
  switch (event.type) {
    case 'approval-invalidated': console.error(`Report requires approval: ${event.reason}`); break;
    case 'skip': console.error(`· ${event.step}: skip (${event.reason})`); break;
    case 'report': {
      const { profile, range } = event;
      console.error(
        `\n■ report is an agent step — it cannot be auto-run.\n` +
        `  Profile: ${profile.id} (${profile.displayName})\n` +
        `  Read: AGENTS.md, docs/reporting-rules.md, docs/credentials.md, docs/automation-state.md, ` +
        `profiles/${profile.id}/evaluation.md\n` +
        `  Template: profiles/${profile.id}/notify-template.md\n` +
        `  Do the agent work, write ${reportPath(profile.id, range.label)}, then run:\n` +
        `    npm run pipeline -- mark report ${profileFlags(profile)} ${rangeFlags(range)} --status ok --artifact ${reportPath(profile.id, range.label)} \\\n` +
        `      --status-notify <ok|warn|fail> --title "<short>" --tool <codex|claude>\n` +
        `  Then re-run: npm run pipeline -- run ${profileFlags(profile)} ${rangeFlags(range)}\n`);
      break;
    }
    case 'preview-notify':
      console.error(`[dry-run] ${event.failure ? `wrote ${event.detailsFile}; would send` : 'would send'}:\n  ${composeNotifyCommand(event.params, event.task, event.detailsFile)}`);
      break;
    case 'step-failed':
      console.error(event.step === 'notify' ? '✗ notify failed; see status.'
        : `✗ ${event.step} failed — run "npm run pipeline -- status ${profileFlags(event.profile)} ${rangeFlags(event.range)}" for the error + journal.`);
      break;
    case 'delivered': console.error(`✓ notify sent (${event.status})`); break;
    case 'preview-step': console.error(`[dry-run] would run ${event.step} for ${event.profile.id}/${event.range.label}`); break;
    case 'step-ok': console.error(`✓ ${event.step} ok`); break;
    case 'end': console.error(`\nRun ${event.profile.id}/${event.range.label} reached the end of the plan.`); break;
    case 'marked': console.error(`✓ marked ${event.step} ${event.status} for ${event.profile.id}/${event.range.label}.`); break;
    case 'report-already-delivered': console.error('report already delivered; use run --force report to explicitly replace it.'); break;
    case 'failure-already-delivered': console.error('notify already sent for this run; not sending a fail notification.'); break;
    case 'failure-already-alerted': console.error('failure alert already sent; run remains pending for recovery.'); break;
    case 'failure-alert-failed': console.error(`✗ fail notification failed: ${event.stderr.trim()}`); break;
    case 'failure-alert-sent': console.error(`✓ fail notification sent for ${event.profile.id}/${event.range.label} (${event.reason}).`); break;
  }
}

const lifecycle = createRunLifecycle({
  now: () => new Date().toISOString(), fetch: fetchStep, enrich: enrichStep,
  notify: runNotify, emit: renderLifecycleEvent,
});

async function cmdRun(argv: string[]) {
  return lifecycle.resume({
    profile: resolveProfileOrExit(argv), range: resolveRangeOrExit(argv),
    dryRun: has(argv, '--dry-run'), recovery: has(argv, '--recovery'),
    tool: flag(argv, '--tool'), force: flag(argv, '--force'), only: flag(argv, '--only'),
  });
}

async function cmdRecover(argv: string[]): Promise<void> {
  const profile = resolveProfileOrExit(argv);
  const target = resolveRangeOrExit(argv);
  const tool = requiredTool(argv);
  const backlog = recoveryBacklog(profile.id, target);
  const results: { from: string; to: string; label: string; outcome: string }[] = [];
  for (const m of backlog.runs) {
    const range = { from: m.from, to: m.to, label: m.from === m.to ? m.from : `${m.from}_${m.to}` };
    let outcome: string;
    try {
      outcome = await lifecycle.resume({
        profile: resolveProfileOrExit(['--profile', profile.id]), range,
        tool, recovery: true, dryRun: has(argv, '--dry-run'),
      });
    } catch (error) {
      console.error(`Recovery ${profile.id}/${range.label}: ${(error as Error).message}`);
      outcome = 'failed';
    }
    results.push({ ...range, outcome });
  }
  // Machine-readable work list: the agent must finish each "report" item using its own range.
  console.log(JSON.stringify({ profileId: profile.id, target, runs: results, errors: backlog.errors }, null, 2));
  if (backlog.errors.length || results.some((r) => r.outcome === 'failed')) process.exitCode = 1;
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
  if (m.failureNotification) console.error(`  failure alert sent: ${m.failureNotification.sentAt} (report delivery tracked separately)`);
  if (m.recovery) console.error(`  recovery started: ${m.recovery.startedAt}`);
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
  lifecycle.mark({
    profile: resolveProfileOrExit(argv), range: resolveRangeOrExit(argv), step,
    status: flag(argv, '--status'), artifact: flag(argv, '--artifact'),
    notificationStatus: flag(argv, '--status-notify'), title: flag(argv, '--title'), tool: flag(argv, '--tool'),
  });
}

async function cmdFail(argv: string[]): Promise<void> {
  const result = await lifecycle.fail({
    profile: resolveProfileOrExit(argv), range: resolveRangeOrExit(argv),
    reason: flag(argv, '--reason'), tool: flag(argv, '--tool'), title: flag(argv, '--title'),
    dryRun: has(argv, '--dry-run'),
  });
  if (result === 'failed') process.exitCode = 1;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') {
    if (await cmdRun(rest) === 'failed') process.exitCode = 1;
    return;
  }
  if (cmd === 'recover') return cmdRecover(rest);
  if (cmd === 'status') return cmdStatus(rest);
  if (cmd === 'mark') return cmdMark(rest);
  if (cmd === 'fail') return cmdFail(rest);
  fail(`unknown command "${cmd ?? ''}"; expected run|recover|status|mark|fail.`);
}

main().catch((err) => {
  if (err instanceof LifecycleInputError) fail(err.message);
  console.error(err);
  process.exit(1);
});
