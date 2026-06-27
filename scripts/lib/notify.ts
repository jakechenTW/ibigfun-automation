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
