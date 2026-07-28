import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseDoorplateKey, normalizeTaiwanAddress, parseDoorNumberRange } from './address.ts';

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
      suffix: '',
      suffixValid: true,
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
  assert.equal(address.suffix, '');
  assert.equal(address.suffixValid, true);
});

test('preserves and validates an explicit floor or unit suffix grammar', () => {
  const accepted = [
    ['臺北市文山區萬盛街８９號之６七樓之十二', '台北市文山區萬盛街89號之6七樓之12', '7樓之12'],
    ['臺北市文山區萬盛街８９之６號７樓１２室', '台北市文山區萬盛街89之6號7樓12室', '7樓12室'],
    ['台北市文山區萬盛街八十九號之六', '台北市文山區萬盛街89號之6', ''],
    ['台北市文山區萬盛街八十九之六號十二室', '台北市文山區萬盛街89之6號十二室', '12室'],
    ['台北市文山區萬盛街89號之6地下二樓之三室', '台北市文山區萬盛街89號之6地下二樓之三室', '地下2樓之3室'],
  ] as const;

  for (const [input, canonical, suffix] of accepted) {
    const address = normalizeTaiwanAddress(input);
    assert.equal(address.canonical, canonical, input);
    assert.equal(address.suffix, suffix, input);
    assert.equal(address.suffixValid, true, input);
    assert.equal(baseDoorplateKey(address), '台北市文山區萬盛街89號之6', input);
  }

  for (const input of [
    '台北市文山區萬盛街89號之6附近',
    '台北市文山區萬盛街89號之6隔壁巷',
    '台北市文山區萬盛街89號之6七樓附近',
    '台北市文山區萬盛街89號之6七樓之12附近',
    '台北市文山區萬盛街89號之6七樓之',
  ]) {
    const address = normalizeTaiwanAddress(input);
    assert.notEqual(address.suffix, '', input);
    assert.equal(address.suffixValid, false, input);
    assert.equal(baseDoorplateKey(address), null, input);
  }
});
