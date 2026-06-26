import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDistrict, districtConsistent } from './districts.ts';

test('extractDistrict pulls the district from an address', () => {
  assert.equal(extractDistrict('台北市中正區紹安街26巷'), '中正區');
  assert.equal(extractDistrict('台北市文山區興隆路二段220巷'), '文山區');
  assert.equal(extractDistrict('新北市板橋區'), null);
  assert.equal(extractDistrict(null), null);
});

test('a coordinate within its stated district is consistent', () => {
  // 文山區 point near its centroid.
  assert.equal(districtConsistent({ lat: 24.99, lng: 121.57 }, '文山區'), true);
});

test('the real bug case is flagged inconsistent (中正區 address, 信義安和 pin)', () => {
  // Coordinate near 信義安和站 (~大安區), but address says 中正區.
  assert.equal(districtConsistent({ lat: 25.0327, lng: 121.5536 }, '中正區'), false);
});

test('unknown district or missing coordinate yields null (can not tell)', () => {
  assert.equal(districtConsistent({ lat: 25.03, lng: 121.52 }, null), null);
  assert.equal(districtConsistent(null, '中正區'), null);
  assert.equal(districtConsistent({ lat: 25.03, lng: 121.52 }, '板橋區'), null);
});
