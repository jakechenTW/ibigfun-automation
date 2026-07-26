import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridKey, neighborGridKeys } from './grid.ts';

test('generates stable grid keys by flooring each coordinate', () => {
  assert.equal(gridKey({ lat: 25.033964, lng: 121.564468 }), '5006:24312');
});

test('enumerates all intersecting grid cells in lexicographic order', () => {
  const keys = neighborGridKeys({ lat: 25.033964, lng: 121.564468 }, 300);
  assert.deepEqual(keys, [...keys].sort());
  assert.ok(keys.includes('5006:24312'));
  assert.ok(keys.length > 1);
});

test('rejects an invalid spatial radius', () => {
  assert.throws(() => neighborGridKeys({ lat: 25.033964, lng: 121.564468 }, -1), RangeError);
});
