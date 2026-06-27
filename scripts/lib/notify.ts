import { spawnSync } from 'node:child_process';
import type { NotifyParams } from './manifest.ts';
import type { JournalEvent } from './journal.ts';
import type { RunRange } from './range.ts';

export const NOTIFY_TASK = '每日 iBigFun 投資房源監測';

/** Canonical ai-notify argv (see AGENTS.md "Canonical Notification Command"). */
export function composeNotifyArgs(p: NotifyParams, detailsFile: string): string[] {
  return [
    '--tool', p.tool,
    '--status', p.status,
    '--task', NOTIFY_TASK,
    '--title', p.title,
    '--details-file', detailsFile,
  ];
}

function shellQuote(arg: string): string {
  return /[^A-Za-z0-9_./-]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}

/** Human-readable command string for --dry-run / journaling. Display only. */
export function composeNotifyCommand(p: NotifyParams, detailsFile: string): string {
  return 'ai-notify ' + composeNotifyArgs(p, detailsFile).map(shellQuote).join(' ');
}

/** Execute ai-notify for real; returns its exit code + stderr. */
export function runNotify(p: NotifyParams, detailsFile: string): { exitCode: number; stderr: string } {
  const r = spawnSync('ai-notify', composeNotifyArgs(p, detailsFile), { encoding: 'utf8' });
  if (r.error) return { exitCode: 1, stderr: r.error.message };
  return { exitCode: r.status ?? 1, stderr: r.stderr ?? '' };
}

/**
 * Markdown body for a fail notification. Built ONLY from the operator reason
 * and the (already redact()-ed) journal tail — never raw secrets.
 */
export function renderFailDetails(range: RunRange, reason: string, tail: JournalEvent[]): string {
  const lines = [
    `# 監測中斷 ${range.label}`,
    ``,
    `- 區間: ${range.from} → ${range.to}`,
    `- 原因: ${reason}`,
    ``,
    `## journal (最後 ${tail.length} 筆)`,
    ...tail.map((e) => `- ${e.ts} [${e.level}] ${e.step}:${e.event} ${e.msg}`),
  ];
  return lines.join('\n') + '\n';
}
