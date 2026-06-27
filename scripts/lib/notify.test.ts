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
