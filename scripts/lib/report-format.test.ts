import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateNotificationCounts, validateNotificationReport } from './report-format.ts';

test('accepts empty results and balanced investment and self-use counts', () => {
  validateNotificationCounts('本期無房源。\n本次取得 0｜推薦 0｜候選 0｜風險 0｜排除 0', 0);
  for (const label of ['推薦', '符合']) {
    validateNotificationCounts([
      '本次取得 8 筆，其中 1 筆待確認。',
      `**本次取得 8｜${label} 2｜候選 1｜風險 0｜排除 5**`,
      '### 排除摘要',
      '- 刊登超過上限：3 筆',
      '- 其他硬性排除：2 筆',
      '- 主要原因：刊登超過 365 天上限。',
    ].join('\n'), 8);
  }
});

test('rejects the overlapping exclusion totals observed in daily reports', () => {
  assert.throws(() => validateNotificationCounts([
    '本次取得 88｜推薦 2｜候選 4｜風險 0｜排除 82',
    '### 排除摘要',
    '- 目標捷運站外：64 筆',
    '- 站內走路過遠：12 筆',
    '- 刊登超過上限：43 筆',
    '- 其他硬性排除：48 筆',
  ].join('\n'), 88), /without overlap/);
});

test('rejects missing, legacy, duplicate, unsafe, and inconsistent summary counts', () => {
  for (const report of [
    '沒有符合物件。',
    '新案 1｜推薦 1｜候選 0｜風險 0｜排除 0',
    '本次取得 1｜推薦 1｜候選 0｜風險 0｜排除 0\n本次取得 1｜推薦 1｜候選 0｜風險 0｜排除 0',
    '本次取得 9007199254740992｜推薦 1｜候選 0｜風險 0｜排除 0',
    '本次取得 2｜推薦 1｜候選 0｜風險 0｜排除 0',
    '本次取得 1｜推薦 0｜候選 0｜風險 0｜排除 0',
  ]) {
    assert.throws(() => validateNotificationCounts(report, 1));
  }
});

test('rejects missing, duplicate, empty, and malformed exclusion sections', () => {
  const summary = '本次取得 2｜推薦 0｜候選 0｜風險 0｜排除 2\n';
  for (const section of [
    '',
    '### 排除摘要\n- 刊登超過上限：2 筆\n### 排除摘要',
    '### 排除摘要\n- 刊登超過上限：1 筆\n- 刊登超過上限：1 筆',
    '### 排除摘要\n- 刊登超過上限：2 筆。其他原因也適用。',
    '### 排除摘要\n- 刊登超過上限：0 筆',
    '### 排除摘要\n- 刊登超過上限：3 筆',
    '### 排除摘要\n- 刊登超過上限：1 筆',
  ]) {
    assert.throws(() => validateNotificationCounts(summary + section, 2));
  }
  assert.throws(() => validateNotificationCounts(
    '本次取得 0｜符合 0｜候選 0｜風險 0｜排除 0\n### 排除摘要', 0,
  ));
});

test('rejects a report body that starts with a duplicate Markdown title', () => {
  const report = [
    '## ⚠️ 2026-08-06 投資房源｜無直接推薦',
    '',
    '結論：今日無直接推薦。',
  ].join('\n');

  assert.throws(
    () => validateNotificationReport(report),
    /must start with the conclusion.*--title owns the notification title/i,
  );
});

test('rejects a coordinate-backed walking line without a clickable map link', () => {
  const report = [
    '結論：今日有 1 筆候選。',
    '',
    '- 🚶 步行約 5 分鐘｜北門站 3號出口',
  ].join('\n');

  assert.throws(
    () => validateNotificationReport(report),
    /walking line 3 must include a clickable Google Maps coordinate link/i,
  );
});

test('accepts mapped walking lines and a no-position fallback', () => {
  const report = [
    '結論：今日有 2 筆候選。',
    '',
    '- 🚶 步行約 5 分鐘｜北門站 3號出口｜[地圖](https://www.google.com/maps?q=25.0508876,121.5126656)',
    '- 🚶 步行時間待確認｜[地圖](https://www.google.com/maps?q=25.1,121.5)',
    '- 🚶 無位置資訊',
  ].join('\n');

  assert.doesNotThrow(() => validateNotificationReport(report));
});

test('rejects a non-coordinate Google Maps query in a walking line', () => {
  const report = [
    '結論：今日有 1 筆候選。',
    '',
    '- 🚶 步行約 5 分鐘｜北門站 3號出口｜[地圖](https://www.google.com/maps?q=北門站)',
  ].join('\n');

  assert.throws(
    () => validateNotificationReport(report),
    /walking line 3 must include a clickable Google Maps coordinate link/i,
  );
});

test('rejects a map-less walking line even when its Markdown bullet is missing', () => {
  const report = [
    '結論：今日有 1 筆候選。',
    '',
    '🚶 步行約 5 分鐘｜北門站 3號出口',
  ].join('\n');

  assert.throws(
    () => validateNotificationReport(report),
    /walking line 3 must include a clickable Google Maps coordinate link/i,
  );
});

test('rejects the old ORS-only coordinate-backed walking line', () => {
  const report = [
    '結論：今日有 1 筆候選。',
    '',
    '- 🚶 ORS 北門 3號出口・5分・[地圖](https://www.google.com/maps?q=25.0508876,121.5126656)',
  ].join('\n');

  assert.throws(
    () => validateNotificationReport(report),
    /walking line 3 must use plain-language walking time/i,
  );
});

test('rejects a coordinate-backed walking line missing Valhalla', () => {
  const report = [
    '結論：今日有 1 筆候選。',
    '',
    '- 🚶 ORS 北門 3號出口・5分（試行）・[地圖](https://www.google.com/maps?q=25.0508876,121.5126656)',
  ].join('\n');

  assert.throws(
    () => validateNotificationReport(report),
    /walking line 3 must use plain-language walking time/i,
  );
});

test('rejects provider names in a walking line', () => {
  const report = [
    '結論：今日有 1 筆候選。',
    '',
    '- 🚶 ORS 北門 3號出口・5分｜Valhalla 北門 2號出口・6分・[地圖](https://www.google.com/maps?q=25.0508876,121.5126656)',
  ].join('\n');

  assert.throws(
    () => validateNotificationReport(report),
    /walking line 3 must use plain-language walking time/i,
  );
});

test('rejects empty result sections instead of sending repeated no-result text', () => {
  for (const heading of ['推薦物件', '符合條件', '候選／資料待確認', '⚠️ 風險物件／待查']) {
    assert.throws(() => validateNotificationReport(`本期無符合物件。\n### ${heading}\n- 今日無物件。`), /empty result section/);
  }
});

test('rejects operational diagnostics and raw market evidence in the body', () => {
  for (const line of [
    '> ⚠️ 51 筆行情可靠、9 筆 review、1 筆 unavailable。',
    '> Valhalla 試行使用 https://valhalla1.openstreetmap.de，8 筆試行完成。',
    '- 官方行情中位數 71.6 萬/坪（P25–P75：68.2–75.9；high）',
    '- 官方行情 review，信心 low，中位數 86.1 萬/坪。',
  ]) assert.throws(() => validateNotificationReport(`本期有候選。\n${line}`), /technical diagnostics/);
  assert.doesNotThrow(() => validateNotificationReport('本期有候選。\n> 官方資料偏舊，受影響物件暫不推薦。'));
});

test('requires an early listing reason or action and rejects generic-only advice', () => {
  const header = '本期有物件。\n### 推薦物件\n#### 1. [物件](https://example.com/listing)\n';
  for (const body of [
    '- 1200 萬・20 坪\n- 推薦：二樓、距捷運 5 分鐘。',
    '- 推薦：區域、步行與官方行情條件通過。',
    '- 下一步：確認低信心行情與屋況。',
    '- 推薦：',
  ]) assert.throws(() => validateNotificationReport(header + body), /listing reason or action/);
  assert.doesNotThrow(() => validateNotificationReport(header + '- 推薦：二樓、距捷運 5 分鐘。\n- 1200 萬・20 坪'));
});

test('allows listing links and compact evidence without treating them as diagnostics', () => {
  validateNotificationReport('本期有候選。\n### 候選／資料待確認\n#### 1. [review 房源](https://example.com/review)\n- 下一步：車位价坪未拆分，向仲介索取獨立價格與坪數。\n- 官方成交中位約 70.0 萬/坪（4 筆可比；車位價坪待確認）');
});
