import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTaiwanAddress, parseDoorNumberRange } from './address.ts';

test('normalizes Taiwan address variants and Chinese numerals', () => {
  assert.equal(
    normalizeTaiwanAddress('臺北市 中正區 忠孝東路 一段 １０號之２').canonical,
    '台北市中正區忠孝東路1段10號之2',
  );
});

test('parses address components without treating city or district text as road text', () => {
  assert.deepEqual(
    normalizeTaiwanAddress('台北市大安區復興南路二段135巷17弄8號'),
    {
      canonical: '台北市大安區復興南路2段135巷17弄8號',
      city: '台北市',
      district: '大安區',
      road: '復興南路',
      section: 2,
      lane: 135,
      alley: 17,
      number: 8,
      subNumber: null,
      numberRange: null,
    },
  );
});

test('parses masked door-number ranges', () => {
  assert.deepEqual(parseDoorNumberRange('1~30號'), { min: 1, max: 30 });
  assert.deepEqual(parseDoorNumberRange('31至60號'), { min: 31, max: 60 });
});

test('preserves a parsed masked range in normalized address data', () => {
  const address = normalizeTaiwanAddress('台北市信義區松仁路1~30號');
  assert.equal(address.canonical, '台北市信義區松仁路1~30號');
  assert.equal(address.number, null);
  assert.deepEqual(address.numberRange, { min: 1, max: 30 });
});
