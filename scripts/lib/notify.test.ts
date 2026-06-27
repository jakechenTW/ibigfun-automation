import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeNotifyArgs, composeNotifyCommand, renderFailDetails, NOTIFY_TASK } from './notify.ts';

const params = { tool: 'claude', status: 'warn', title: '3 件待覆核' } as const;

test('composeNotifyArgs builds the canonical argv with the given details file', () => {
  assert.deepEqual(composeNotifyArgs(params, 'state/runs/2026-06-26/report.md'), [
    '--tool', 'claude',
    '--status', 'warn',
    '--task', NOTIFY_TASK,
    '--title', '3 件待覆核',
    '--details-file', 'state/runs/2026-06-26/report.md',
  ]);
});

test('composeNotifyCommand quotes args with spaces for safe display', () => {
  const cmd = composeNotifyCommand(params, 'state/runs/2026-06-26/report.md');
  assert.ok(cmd.startsWith('ai-notify --tool claude --status warn'));
  assert.ok(cmd.includes("--task '每日 iBigFun 投資房源監測'"));
  assert.ok(cmd.includes("--title '3 件待覆核'"));
  assert.ok(cmd.includes('--details-file state/runs/2026-06-26/report.md'));
});

test('renderFailDetails includes the range, reason, and journal tail lines', () => {
  const range = { from: '2026-06-20', to: '2026-06-25', label: '2026-06-20_2026-06-25' };
  const tail = [
    { ts: '2026-06-27T00:00:00.000Z', step: 'fetch', level: 'error', event: 'step.error', msg: 'fetch failed: boom' },
  ] as const;
  const md = renderFailDetails(range, 'login blocked', tail as any);
  assert.ok(md.includes('2026-06-20_2026-06-25'));
  assert.ok(md.includes('2026-06-20 → 2026-06-25'));
  assert.ok(md.includes('login blocked'));
  assert.ok(md.includes('fetch:step.error fetch failed: boom'));
});
