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

interface FailureGuidance {
  label: string;
  nextAction: string;
}

const FAILURE_GUIDANCE: Record<string, FailureGuidance> = {
  fetch: {
    label: '抓取房源',
    nextAction: '確認 iBigFun 登入與連線狀態後，重新執行本次任務',
  },
  enrich: {
    label: '補充房源資料',
    nextAction: '確認路線與官方市場資料狀態後，重新執行本次任務',
  },
  report: {
    label: '產生報告',
    nextAction: '查看本機 pipeline 狀態與報告輸入後，重新產生本次報告',
  },
  notify: {
    label: '發送通知',
    nextAction: '確認 NOTIFY_CMD 或 ai-notify 設定後，重新執行通知步驟',
  },
};

const UNKNOWN_FAILURE_GUIDANCE: FailureGuidance = {
  label: '未知',
  nextAction: '查看本機 pipeline 狀態，排除原因後重新執行本次任務',
};

function failureGuidance(tail: JournalEvent[]): FailureGuidance {
  const lastStep = [...tail].reverse().find((event) => event.step.trim())?.step;
  return lastStep ? FAILURE_GUIDANCE[lastStep] ?? UNKNOWN_FAILURE_GUIDANCE : UNKNOWN_FAILURE_GUIDANCE;
}

export function defaultFailTitle(profileName: string, range: RunRange): string {
  return `❌ ${range.label} ${profileName}中斷`;
}

/** Markdown body for a concise, safe fail notification. */
export function renderFailDetails(
  profileName: string,
  range: RunRange,
  reason: string,
  tail: JournalEvent[],
): string {
  const guidance = failureGuidance(tail);
  return [
    `# ❌ ${range.label} ${profileName}中斷`,
    '',
    `- 區間：${range.from} → ${range.to}`,
    `- 中斷步驟：${guidance.label}`,
    `- 原因：${reason}`,
    `- 建議：${guidance.nextAction}`,
  ].join('\n') + '\n';
}
