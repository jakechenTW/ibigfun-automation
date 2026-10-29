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
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadOrCreateManifest, readManifest, writeManifest, setStep, planNextSteps,
  clearFailure, invalidateAfter, isRunComplete, STEP_ORDER, type StepName, type NotifyParams,
} from './lib/manifest.ts';
import { readJournal, journalLogger } from './lib/journal.ts';
import { runStep } from './lib/run.ts';
import { composeNotifyCommand, defaultFailTitle, runNotify, renderFailDetails } from './lib/notify.ts';
import { fetchStep, enrichStep } from './lib/steps.ts';
import { resolveRange, rangeFlags, type RunRange } from './lib/range.ts';
import { runDir, reportPath, enrichedPath, valuationReviewPath, effectiveProfilePath } from './lib/runpaths.ts';
import { resolveProfileFromArgs, profileFlags, parseProfile, type Profile } from './lib/profiles.ts';
import { assertReportHasResolvedRegionTriage, validateReportEvidence } from './lib/report-notify.ts';
import { validateNotificationCounts, validateNotificationReport } from './lib/report-format.ts';
import { recoveryBacklog } from './lib/recovery.ts';

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

async function cmdRun(argv: string[]): Promise<'complete' | 'report' | 'failed' | 'partial'> {
  const requestedProfile = resolveProfileOrExit(argv);
  const range = resolveRangeOrExit(argv);
  const dryRun = has(argv, '--dry-run');
  const m = loadOrCreateManifest(requestedProfile.id, range.from, range.to, now());
  // Older successful fetches saved the effective filters outside the manifest.
  const effectiveFile = effectiveProfilePath(requestedProfile.id, range.label);
  if (!m.profileSnapshot && fs.existsSync(effectiveFile)) {
    m.profileSnapshot = parseProfile(requestedProfile.id, {
      ...requestedProfile, ...JSON.parse(fs.readFileSync(effectiveFile, 'utf8')),
    });
  }
  const profile = m.profileSnapshot ?? requestedProfile;
  m.profileSnapshot ??= profile;
  if (m.steps.report.status === 'ok' && m.steps.notify.status !== 'ok'
    && !fs.existsSync(reportPath(profile.id, range.label))) {
    setStep(m, 'report', { status: 'pending' });
    invalidateAfter(m, 'report');
  }
  if (has(argv, '--recovery')) m.recovery ??= { startedAt: now() };
  if (m.notify && flag(argv, '--tool')) m.notify.tool = requiredTool(argv);
  const forced = asStep(flag(argv, '--force'), '--force');
  const only = asStep(flag(argv, '--only'), '--only');
  if (forced) {
    setStep(m, forced, { status: 'pending' });
    invalidateAfter(m, forced);
  }
  const firstScript = (['fetch', 'enrich'] as const).find((step) =>
    (!only || only === step) && (m.steps[step].status !== 'ok' || forced === step));
  if (firstScript) invalidateAfter(m, firstScript);
  if (!dryRun) writeManifest(m, now());
  const plan = planNextSteps(m, {
    only,
    force: forced ? [forced] : [],
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
        `  Read: AGENTS.md, docs/reporting-rules.md, docs/credentials.md, docs/automation-state.md, ` +
        `profiles/${profile.id}/evaluation.md\n` +
        `  Template: profiles/${profile.id}/notify-template.md\n` +
        `  Do the agent work, write ${reportPath(profile.id, range.label)}, then run:\n` +
        `    npm run pipeline -- mark report ${profileFlags(profile)} ${rangeFlags(range)} --status ok --artifact ${reportPath(profile.id, range.label)} \\\n` +
        `      --status-notify <ok|warn|fail> --title "<short>" --tool <codex|claude>\n` +
        `  Then re-run: npm run pipeline -- run ${profileFlags(profile)} ${rangeFlags(range)}\n`);
      return 'report';
    }
    if (item.step === 'notify') {
      if (!m.notify || !['fetch', 'enrich', 'report'].every((s) => m.steps[s as StepName].status === 'ok')) {
        throw new Error('notify requires completed fetch, enrich, and report steps.');
      }
      const params = { ...m.notify,
        title: m.recovery && !m.notify.title.includes('補送') ? `${m.notify.title}（補送）` : m.notify.title };
      if (dryRun) {
        console.error(`[dry-run] would send:\n  ${composeNotifyCommand(params, profile.displayName, reportPath(profile.id, range.label))}`);
        continue;
      }
      const status = await runStep(m, 'notify', async (logger) => {
        const detailsFile = reportPath(profile.id, range.label);
        if (!fs.existsSync(detailsFile)) throw new Error(`report artifact missing: ${detailsFile}`);
        const { exitCode, stderr, command, skipped } = runNotify(params, profile.displayName, detailsFile);
        logger.event(exitCode === 0 ? 'info' : 'error', 'notify.sent',
          `${command} exited ${exitCode}`, { exitCode, stderr });
        if (exitCode !== 0) throw new Error(`${command} exited ${exitCode}: ${stderr.trim()}`);
        if (skipped) throw new Error('notification not delivered: no notifier installed; retained for recovery');
        return { summary: { exitCode, status: m.notify!.status } };
      }, now);
      if (status === 'failed') { console.error('✗ notify failed; see status.'); return 'failed'; }
      console.error(`✓ notify sent (${m.notify.status})`);
      continue;
    }
    // script steps: fetch / enrich
    if (dryRun) {
      console.error(`[dry-run] would run ${item.step} for ${profile.id}/${range.label}`);
      continue;
    }
    const fn = item.step === 'fetch' ? fetchStep : enrichStep;
    const status = await runStep(m, item.step, (logger) => fn({ profile, range }, logger), now);
    if (status === 'failed') {
      console.error(`✗ ${item.step} failed — run "npm run pipeline -- status ${profileFlags(profile)} ${rangeFlags(range)}" for the error + journal.`);
      return 'failed';
    }
    console.error(`✓ ${item.step} ok`);
  }
  clearFailure(m);
  if (!dryRun) writeManifest(m, now());
  console.error(`\nRun ${profile.id}/${range.label} reached the end of the plan.`);
  return isRunComplete(m) ? 'complete' : 'partial';
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
      outcome = await cmdRun(['--profile', profile.id, '--from', m.from, '--to', m.to,
        '--tool', tool, '--recovery', ...(has(argv, '--dry-run') ? ['--dry-run'] : [])]);
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
  let profile = resolveProfileOrExit(argv);
  const range = resolveRangeOrExit(argv);
  const m = readManifest(profile.id, range.label) ?? loadOrCreateManifest(profile.id, range.from, range.to, now());
  profile = m.profileSnapshot ?? profile;
  const status = flag(argv, '--status');
  if (status !== 'ok' && status !== 'failed') fail('--status must be ok|failed.');
  if (step === 'report' && status === 'ok' && isRunComplete(m)) {
    console.error('report already delivered; use run --force report to explicitly replace it.');
    return;
  }
  const artifact = flag(argv, '--artifact');

  if (step === 'report' && status === 'ok') {
    const sNotify = flag(argv, '--status-notify');
    const title = flag(argv, '--title');
    const tool = requiredTool(argv);
    if (sNotify !== 'ok' && sNotify !== 'warn' && sNotify !== 'fail') {
      fail('marking report ok requires --status-notify <ok|warn|fail>.');
    }
    if (!title) fail('marking report ok requires --title "<short>".');
    if (!artifact) fail('marking report ok requires --artifact <report.md>.');
    if (!fs.existsSync(artifact)) fail(`cannot mark report ok: report artifact ${artifact} is missing.`);
    try {
      const report = fs.readFileSync(artifact, 'utf8');
      validateNotificationReport(report);
      if (profile.evaluation.requireResolvedRegionGate) {
        assertReportHasResolvedRegionTriage(report);
      }
    } catch (error) {
      fail(`cannot mark report ok: ${(error as Error).message}`);
    }
    const enrichedFile = enrichedPath(profile.id, range.label);
    const reviewPath = valuationReviewPath(profile.id, range.label);
    const hasValuationReview = fs.existsSync(reviewPath);
    let enriched: unknown;
    if (!fs.existsSync(enrichedFile)) {
      fail(`cannot mark report ok: required enriched artifact ${enrichedFile} is missing.`);
    }
    try {
      enriched = JSON.parse(fs.readFileSync(enrichedFile, 'utf8'));
    } catch (error) {
      fail(`cannot mark report ok: malformed enriched artifact ${enrichedFile}: ${(error as Error).message}`);
    }
    let valuationReview: unknown;
    if (hasValuationReview) {
      try {
        valuationReview = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
      } catch (error) {
        fail(`cannot mark report ok: malformed ${reviewPath}: ${(error as Error).message}`);
      }
    }
    try {
      validateReportEvidence(sNotify, enriched, valuationReview);
      validateNotificationCounts(
        fs.readFileSync(artifact, 'utf8'),
        (enriched as { listings: unknown[] }).listings.length,
      );
    } catch (error) {
      fail(`cannot mark report ok: ${(error as Error).message}`);
    }
    m.notify = { tool, status: sNotify, title } as NotifyParams;
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
  console.error(`✓ marked ${step} ${status} for ${profile.id}/${range.label}.`);
}

async function cmdFail(argv: string[]): Promise<void> {
  let profile = resolveProfileOrExit(argv);
  const range = resolveRangeOrExit(argv);
  const reason = flag(argv, '--reason');
  if (!reason || reason.startsWith('--')) fail('fail requires --reason "<short>".');
  const tool = requiredTool(argv);
  const title = flag(argv, '--title') ?? defaultFailTitle(profile.displayName, range);
  const dryRun = has(argv, '--dry-run');

  const m = readManifest(profile.id, range.label) ?? loadOrCreateManifest(profile.id, range.from, range.to, now());
  profile = m.profileSnapshot ?? profile;
  if (isRunComplete(m)) {
    console.error('notify already sent for this run; not sending a fail notification.');
    process.exit(0);
  }

  const tail = readJournal(profile.id, range.label).slice(-20);
  const detailsFile = path.join(runDir(profile.id, range.label), 'fail-details.md');
  fs.mkdirSync(runDir(profile.id, range.label), { recursive: true });
  fs.writeFileSync(detailsFile, renderFailDetails(profile.displayName, range, reason, tail));

  const params: NotifyParams = { tool, status: 'fail', title };
  if (dryRun) {
    console.error(`[dry-run] wrote ${detailsFile}; would send:\n  ${composeNotifyCommand(params, profile.displayName, detailsFile)}`);
    process.exit(0);
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
    console.error('failure alert already sent; run remains pending for recovery.');
    return;
  }
  journalLogger(profile.id, range.label, 'notify', now).event('error', 'run.fail', `run failed: ${reason}`, { reason });
  const { exitCode, stderr, command, skipped } = runNotify(params, profile.displayName, detailsFile);
  journalLogger(profile.id, range.label, 'notify', now).event(exitCode === 0 ? 'info' : 'error', 'notify.sent',
    `fail notification ${command} exited ${exitCode}`, { exitCode, stderr });
  if (exitCode !== 0 || skipped) {
    writeManifest(m, now());
    console.error(`✗ fail notification failed: ${stderr.trim()}`);
    process.exit(1);
  }
  m.failureNotification = { sentAt: now() };
  writeManifest(m, now());
  console.error(`✓ fail notification sent for ${profile.id}/${range.label} (${reason}).`);
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

main().catch((err) => { console.error(err); process.exit(1); });
