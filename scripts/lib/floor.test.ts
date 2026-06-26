import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFloorField } from './floor.ts';

test('splits "floor/total" and strips the 樓 unit', () => {
  assert.deepEqual(parseFloorField('4/4樓'), { floor: '4', totalFloors: '4' });
  assert.deepEqual(parseFloorField('12/15樓'), { floor: '12', totalFloors: '15' });
});

test('handles basement and F-suffixed floors', () => {
  assert.deepEqual(parseFloorField('B1/5樓'), { floor: 'B1', totalFloors: '5' });
  assert.deepEqual(parseFloorField('3F/8F'), { floor: '3', totalFloors: '8' });
});

test('no separator keeps the raw value as floor', () => {
  assert.deepEqual(parseFloorField('整棟'), { floor: '整棟', totalFloors: null });
});

test('null/empty input yields nulls', () => {
  assert.deepEqual(parseFloorField(null), { floor: null, totalFloors: null });
  assert.deepEqual(parseFloorField(''), { floor: null, totalFloors: null });
});
