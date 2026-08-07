import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeNotifyArgs,
  composeNotifyCommand,
  defaultFailTitle,
  renderFailDetails,
} from './notify.ts';

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

test('renderFailDetails maps each pipeline step to safe guidance without copying journal content', () => {
  const range = { from: '2026-06-20', to: '2026-06-25', label: '2026-06-20_2026-06-25' };
  const cases = [
    ['fetch', '抓取房源', '確認 iBigFun 登入與連線狀態後，重新執行本次任務'],
    ['enrich', '補充房源資料', '確認路線與官方市場資料狀態後，重新執行本次任務'],
    ['report', '產生報告', '查看本機 pipeline 狀態與報告輸入後，重新產生本次報告'],
    ['notify', '發送通知', '確認 NOTIFY_CMD 或 ai-notify 設定後，重新執行通知步驟'],
  ] as const;
  for (const [step, label, action] of cases) {
    const tail = [
      { ts: '2026-06-27T00:00:00.000Z', step, level: 'error', event: 'step.error', msg: `${step} failed: boom` },
    ] as const;
    const md = renderFailDetails('iBigFun 台北自住房源監測', range, 'operation blocked', tail as any);
    assert.doesNotMatch(md, /^#{1,6}\s/m);
    assert.match(md, /^- 區間：2026-06-20 → 2026-06-25/);
    assert.match(md, new RegExp(`中斷步驟：${label}`));
    assert.match(md, /原因：operation blocked/);
    assert.match(md, new RegExp(`建議：${action}`));
    assert.doesNotMatch(md, /2026-06-27T00:00:00\.000Z|step\.error|failed: boom|journal/);
  }
});

test('renderFailDetails uses safe generic guidance when no step is known', () => {
  const range = { from: '2026-06-25', to: '2026-06-25', label: '2026-06-25' };
  const tail = [
    { ts: '2026-06-27T00:00:00.000Z', step: 'unexpected-step', level: 'error', event: 'step.error', msg: 'secret journal detail' },
  ] as const;
  const md = renderFailDetails('iBigFun 台北投資房源監測', range, 'operator stopped', tail as any);
  assert.match(md, /中斷步驟：未知/);
  assert.match(md, /建議：查看本機 pipeline 狀態，排除原因後重新執行本次任務/);
  assert.doesNotMatch(md, /unexpected-step|2026-06-27T00:00:00\.000Z|step\.error|secret journal detail|journal/);
});

test('defaultFailTitle includes status icon, range, and profile name', () => {
  const range = { from: '2026-06-25', to: '2026-06-25', label: '2026-06-25' };
  assert.equal(
    defaultFailTitle('iBigFun 台北投資房源監測', range),
    '❌ 2026-06-25 iBigFun 台北投資房源監測中斷',
  );
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
