import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildDoorplateIndex,
  locateAddress,
  nearestDoorplate,
} from './doorplates.ts';

const fixturePath = fileURLToPath(new URL('./fixtures/doorplates.csv', import.meta.url));

async function fixtureIndex() {
  return buildDoorplateIndex(createReadStream(fixturePath), 'fixture-2026-07');
}

test('exact address resolves to one doorplate', async () => {
  const index = await fixtureIndex();
  const result = locateAddress(index, '台北市中正區測試路1段10號');

  assert.equal(result.method, 'exact-doorplate');
  assert.equal(result.uncertaintyMeters, 0);
  assert.equal(result.matchedAddress, '台北市中正區測試路1段10號');
  assert.equal(result.confidence, 'high');
});

test('masked range returns centroid and covering uncertainty', async () => {
  const index = await fixtureIndex();
  const result = locateAddress(index, '台北市中正區測試路1段1~30號');

  assert.equal(result.method, 'address-range');
  assert.ok((result.uncertaintyMeters ?? 0) > 0);
  assert.equal(result.confidence, 'medium');
});

test('reverse lookup returns the nearest local doorplate and distance', async () => {
  const index = await fixtureIndex();
  const result = nearestDoorplate(index, { lat: 25.03396, lng: 121.56447 });

  assert.equal(result.method, 'nearest-doorplate');
  assert.ok((result.uncertaintyMeters ?? Infinity) < 50);
  assert.equal(result.matchedAddress, '台北市中正區測試路1段10號');
});

test('row mapping retains only structurally complete TWD97 doorplates', async () => {
  const index = await fixtureIndex();

  assert.deepEqual(
    index.byRoad['台北市中正區測試路1段'].map((point) => point.canonicalAddress),
    [
      '台北市中正區測試路1段10號',
      '台北市中正區測試路1段10號之2',
      '台北市中正區測試路1段1號',
      '台北市中正區測試路1段21號',
      '台北市中正區測試路1段2號',
      '台北市中正區測試路1段30號',
      '台北市中正區測試路1段9號',
    ],
  );
});
