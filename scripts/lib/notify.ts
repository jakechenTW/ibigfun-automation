import { spawnSync } from 'node:child_process';
import type { NotifyParams } from './manifest.ts';
import type { JournalEvent } from './journal.ts';
import type { RunRange } from './range.ts';

/** Canonical notifier argv (see docs/notifications.md "Notifier contract"). */
export function composeNotifyArgs(p: NotifyParams, task: string, detailsFile: string): string[] {
  return [
    '--tool', p.tool,
    '--status', p.status,
    '--task', task,
    '--title', p.title,
    '--details-file', detailsFile,
  ];
}

/** Resolve the notifier command: NOTIFY_CMD if set (non-blank), else the `ai-notify` default. */
export function resolveNotifyCommand(env: NodeJS.ProcessEnv = process.env): { command: string; explicit: boolean } {
  const raw = env.NOTIFY_CMD?.trim();
  return { command: raw || 'ai-notify', explicit: !!raw };
}

function shellQuote(arg: string): string {
  return /[^A-Za-z0-9_./-]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}

/** Human-readable command string for --dry-run / journaling. Display only. */
export function composeNotifyCommand(
  p: NotifyParams,
  task: string,
  detailsFile: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const { command } = resolveNotifyCommand(env);
  return command + ' ' + composeNotifyArgs(p, task, detailsFile).map(shellQuote).join(' ');
}

export type SpawnFn = (
  cmd: string,
  args: string[],
) => { status: number | null; stderr?: string; error?: Error & { code?: string } };

export interface NotifyResult {
  exitCode: number;
  stderr: string;
  command: string;
  skipped?: boolean;
}

/**
 * Execute the notifier. Resolves the command from NOTIFY_CMD (default `ai-notify`).
 * If no notifier is configured AND the default is not installed, the run does not
 * fail: the report is already written to `detailsFile`, so we print a skip notice
 * and return exitCode 0 (skipped: true). An explicitly configured notifier that is
 * missing or exits non-zero is a real error.
 */
export function runNotify(
  p: NotifyParams,
  task: string,
  detailsFile: string,
  opts: { env?: NodeJS.ProcessEnv; spawn?: SpawnFn } = {},
): NotifyResult {
  const env = opts.env ?? process.env;
  const spawn: SpawnFn =
    opts.spawn ?? ((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }));
  const { command, explicit } = resolveNotifyCommand(env);
  const r = spawn(command, composeNotifyArgs(p, task, detailsFile));
  if (r.error) {
    const notFound = r.error.code === 'ENOENT';
    if (notFound && !explicit) {
      console.error(
        `notification skipped — no notifier found (set NOTIFY_CMD to enable); report at ${detailsFile}`,
      );
      return { exitCode: 0, stderr: '', command, skipped: true };
    }
    return { exitCode: 1, stderr: r.error.message, command };
  }
  return { exitCode: r.status ?? 1, stderr: r.stderr ?? '', command };
}

/**
 * Markdown body for a fail notification. Built ONLY from the operator reason
 * and the (already redact()-ed) journal tail — never raw secrets.
 */
export function renderFailDetails(profileId: string, range: RunRange, reason: string, tail: JournalEvent[]): string {
  const lines = [
    `# 監測中斷 ${range.label}`,
    ``,
    `- Profile: ${profileId}`,
    `- 區間: ${range.from} → ${range.to}`,
    `- 原因: ${reason}`,
    ``,
    `## journal (最後 ${tail.length} 筆)`,
    ...tail.map((e) => `- ${e.ts} [${e.level}] ${e.step}:${e.event} ${e.msg}`),
  ];
  return lines.join('\n') + '\n';
}
