import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeNotifyArgs, composeNotifyCommand, renderFailDetails } from './notify.ts';

const params = { tool: 'claude', status: 'warn', title: '3 件待覆核' } as const;
const investmentTask = '每日 iBigFun 投資房源監測';
const ownerTask = '每日 iBigFun 自住房源監測';

test('composeNotifyArgs builds argv with the profile task and details file', () => {
  assert.deepEqual(composeNotifyArgs(params, investmentTask, 'state/runs/investment/2026-06-26/report.md'), [
    '--tool', 'claude',
    '--status', 'warn',
    '--task', investmentTask,
    '--title', '3 件待覆核',
    '--details-file', 'state/runs/investment/2026-06-26/report.md',
  ]);
});

test('composeNotifyCommand quotes args with spaces for safe display', () => {
  const cmd = composeNotifyCommand(params, ownerTask, 'state/runs/owner-occupied/2026-06-26/report.md');
  assert.ok(cmd.startsWith('ai-notify --tool claude --status warn'));
  assert.ok(cmd.includes("--task '每日 iBigFun 自住房源監測'"));
  assert.ok(cmd.includes("--title '3 件待覆核'"));
  assert.ok(cmd.includes('--details-file state/runs/owner-occupied/2026-06-26/report.md'));
});

test('renderFailDetails includes the profile, range, reason, and journal tail lines', () => {
  const range = { from: '2026-06-20', to: '2026-06-25', label: '2026-06-20_2026-06-25' };
  const tail = [
    { ts: '2026-06-27T00:00:00.000Z', step: 'fetch', level: 'error', event: 'step.error', msg: 'fetch failed: boom' },
  ] as const;
  const md = renderFailDetails('owner-occupied', range, 'login blocked', tail as any);
  assert.ok(md.includes('owner-occupied'));
  assert.ok(md.includes('2026-06-20_2026-06-25'));
  assert.ok(md.includes('2026-06-20 → 2026-06-25'));
  assert.ok(md.includes('login blocked'));
  assert.ok(md.includes('fetch:step.error fetch failed: boom'));
});

import { resolveNotifyCommand, runNotify } from './notify.ts';

test('resolveNotifyCommand defaults to ai-notify when NOTIFY_CMD unset', () => {
  assert.deepEqual(resolveNotifyCommand({}), { command: 'ai-notify', explicit: false });
});

test('resolveNotifyCommand uses NOTIFY_CMD when set', () => {
  assert.deepEqual(resolveNotifyCommand({ NOTIFY_CMD: 'my-notify' }), { command: 'my-notify', explicit: true });
});

test('resolveNotifyCommand treats blank/whitespace NOTIFY_CMD as unset', () => {
  assert.deepEqual(resolveNotifyCommand({ NOTIFY_CMD: '   ' }), { command: 'ai-notify', explicit: false });
});

test('runNotify returns the spawn exit code on success', () => {
  const spawn = () => ({ status: 0, stderr: '' });
  const r = runNotify(params, investmentTask, 'r.md', { env: { NOTIFY_CMD: 'my-notify' }, spawn });
  assert.equal(r.exitCode, 0);
  assert.equal(r.skipped, undefined);
  assert.equal(r.command, 'my-notify');
});

test('runNotify soft-skips with exit 0 when the default notifier is missing', () => {
  const spawn = () => ({ status: null, error: Object.assign(new Error('not found'), { code: 'ENOENT' }) });
  const r = runNotify(params, investmentTask, 'r.md', { env: {}, spawn });
  assert.equal(r.exitCode, 0);
  assert.equal(r.skipped, true);
});

test('runNotify surfaces a real error when an explicitly configured notifier is missing', () => {
  const spawn = () => ({ status: null, error: Object.assign(new Error('not found'), { code: 'ENOENT' }) });
  const r = runNotify(params, investmentTask, 'r.md', { env: { NOTIFY_CMD: 'broken-notify' }, spawn });
  assert.equal(r.exitCode, 1);
  assert.equal(r.skipped, undefined);
});

test('runNotify surfaces non-zero exit from a configured notifier', () => {
  const spawn = () => ({ status: 3, stderr: 'boom' });
  const r = runNotify(params, investmentTask, 'r.md', { env: { NOTIFY_CMD: 'my-notify' }, spawn });
  assert.equal(r.exitCode, 3);
  assert.equal(r.stderr, 'boom');
});

test('composeNotifyCommand prefixes the resolved command name', () => {
  const cmd = composeNotifyCommand(params, investmentTask, 'r.md', { NOTIFY_CMD: 'my-notify' });
  assert.ok(cmd.startsWith('my-notify --tool claude'));
});
