import assert from 'node:assert/strict';
import { createReadStream, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildDoorplateIndex,
  locateAddress,
  nearestDoorplate,
} from './doorplates.ts';
import { gridKey } from './grid.ts';
import type { DoorplateIndex, DoorplatePoint } from './types.ts';

const fixturePath = fileURLToPath(new URL('./fixtures/doorplates.csv', import.meta.url));

async function fixtureIndex() {
  return buildDoorplateIndex(createReadStream(fixturePath), 'fixture-2026-07');
}

function point(canonicalAddress: string, lat: number): DoorplatePoint {
  return {
    canonicalAddress,
    coordinate: { lat, lng: 121.564468 },
    district: '中正區',
    roadKey: '台北市中正區測試路1段',
    mainNumber: Number(/(\d+)號/.exec(canonicalAddress)?.[1]),
    subNumber: null,
  };
}

function spatialIndex(points: DoorplatePoint[]): DoorplateIndex {
  const cells: Record<string, DoorplatePoint[]> = {};
  for (const doorplate of points) {
    (cells[gridKey(doorplate.coordinate)] ??= []).push(doorplate);
  }
  return {
    schemaVersion: 1,
    datasetVersion: 'test',
    byCanonicalAddress: {},
    byRoad: {},
    cells,
  };
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

test('serializes the same index when the source rows arrive in a different order', async () => {
  const [header, ...records] = readFileSync(fixturePath, 'utf8').trim().split('\n');
  const forward = await buildDoorplateIndex(Readable.from(`${header}\n${records.join('\n')}\n`), 'fixture-2026-07');
  const reversed = await buildDoorplateIndex(Readable.from(`${header}\n${records.reverse().join('\n')}\n`), 'fixture-2026-07');

  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});

test('reverse lookup expands past 100 metres before selecting a local doorplate', async () => {
  const index = await fixtureIndex();
  const result = nearestDoorplate(index, { lat: 25.0321, lng: 121.56447 });

  assert.equal(result.method, 'nearest-doorplate');
  assert.ok((result.uncertaintyMeters ?? 0) > 100);
  assert.ok((result.uncertaintyMeters ?? Infinity) <= 300);
});

test('reverse lookup is unresolved when all doorplates are beyond 300 metres', async () => {
  const index = await fixtureIndex();
  const result = nearestDoorplate(index, { lat: 25.025, lng: 121.56447 });

  assert.equal(result.method, 'unresolved');
  assert.equal(result.coordinate, null);
});

test('reverse lookup uses canonical address as a stable equal-distance tie-break', () => {
  const index = spatialIndex([
    point('台北市中正區測試路1段2號', 24.999),
    point('台北市中正區測試路1段1號', 25.001),
  ]);
  const result = nearestDoorplate(index, { lat: 25, lng: 121.564468 });

  assert.equal(result.method, 'nearest-doorplate');
  assert.equal(result.matchedAddress, '台北市中正區測試路1段1號');
});

test('masked ranges never cross city, district, section, lane, or alley boundaries', async () => {
  const index = await fixtureIndex();
  for (const input of [
    '新北市中正區測試路1段1~30號',
    '台北市大安區測試路1段1~30號',
    '台北市中正區測試路2段1~30號',
    '台北市中正區測試路1段1巷1~30號',
    '台北市中正區測試路1段1弄1~30號',
  ]) {
    assert.equal(locateAddress(index, input).method, 'unresolved', input);
  }
});
