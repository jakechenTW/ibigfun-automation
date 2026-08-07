import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateNotificationReport } from './report-format.ts';

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
    '- 🚶 北門 3 號出口・5 分鐘（389m）',
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
    '- 🚶 北門 3 號出口・5 分鐘（[地圖](https://www.google.com/maps?q=25.0508876,121.5126656)）',
    '- 🚶 步行待人工確認（[地圖](https://www.google.com/maps?q=25.1,121.5)）',
    '- 🚶 無位置資訊',
  ].join('\n');

  assert.doesNotThrow(() => validateNotificationReport(report));
});

test('rejects a non-coordinate Google Maps query in a walking line', () => {
  const report = [
    '結論：今日有 1 筆候選。',
    '',
    '- 🚶 北門 3 號出口・5 分鐘（[地圖](https://www.google.com/maps?q=北門站)）',
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
    '🚶 北門 3 號出口・5 分鐘（389m）',
  ].join('\n');

  assert.throws(
    () => validateNotificationReport(report),
    /walking line 3 must include a clickable Google Maps coordinate link/i,
  );
});
