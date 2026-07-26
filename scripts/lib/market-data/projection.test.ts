import assert from 'node:assert/strict';
import { test } from 'node:test';
import { twd97ToWgs84 } from './projection.ts';

test('converts TWD97 Taipei coordinate to WGS84', () => {
  const p = twd97ToWgs84(306962.31994202593, 2769658.2226569955);
  assert.ok(Math.abs(p.lat - 25.033964) < 0.00002);
  assert.ok(Math.abs(p.lng - 121.564468) < 0.00002);
});

test('rejects non-finite or non-Taipei projected coordinates', () => {
  assert.throws(() => twd97ToWgs84(Number.NaN, 2770291.297), RangeError);
  assert.throws(() => twd97ToWgs84(200000, 2600000), RangeError);
});
