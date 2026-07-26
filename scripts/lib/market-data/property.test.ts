import assert from 'node:assert/strict';
import { test } from 'node:test';
import { floorGroup, normalizeOfficialBuildingType } from './property.ts';

test('normalizes only approved official building labels', () => {
  assert.equal(normalizeOfficialBuildingType('公寓(5樓含以下無電梯)'), 'apartment');
  assert.equal(normalizeOfficialBuildingType('華廈(10層含以下有電梯)'), 'midrise');
  assert.equal(normalizeOfficialBuildingType('住宅大樓(11層含以上有電梯)'), 'highrise');
  assert.equal(normalizeOfficialBuildingType('透天厝'), null);
});

test('apartment top floor overrides middle', () => {
  assert.equal(floorGroup('apartment', 4, 4), 'top');
  assert.equal(floorGroup('apartment', 4, 5), 'middle');
  assert.equal(floorGroup('apartment', 5, 5), 'top');
});

test('elevator building groups use approved boundaries', () => {
  assert.equal(floorGroup('midrise', 1, 8), 'first');
  assert.equal(floorGroup('midrise', 4, 8), 'low');
  assert.equal(floorGroup('midrise', 5, 8), 'middle');
  assert.equal(floorGroup('highrise', 8, 12), 'high');
});

test('rejects invalid floor values instead of classifying them', () => {
  assert.equal(floorGroup('apartment', 0, 5), null);
  assert.equal(floorGroup('midrise', 9, 8), null);
});
