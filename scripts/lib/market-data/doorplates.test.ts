import assert from 'node:assert/strict';
import { createReadStream, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildDoorplateIndex,
  locateAddress,
  nearestDoorplate,
  validateDoorplateHeaders,
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

test('exact lookup uses a base doorplate key while retaining the normalized listing address', async () => {
  const csv = [
    '完整地址,坐標X,坐標Y',
    '台北市文山區萬盛街89號之6,306940,2769625',
  ].join('\n');
  const index = await buildDoorplateIndex(Readable.from(`${csv}\n`), 'base-doorplate-key');

  for (const input of [
    '臺北市文山區萬盛街８９號之６七樓',
    '臺北市文山區萬盛街８９之６號七樓',
    '台北市文山區萬盛街89號之6',
  ]) {
    const result = locateAddress(index, input);
    assert.equal(result.method, 'exact-doorplate', input);
    assert.equal(result.matchedAddress, '台北市文山區萬盛街89號之6', input);
    assert.equal(result.normalizedAddress, input.normalize('NFKC').replaceAll('臺', '台'), input);
  }

  for (const input of [
    '台北市萬盛街89號之6',
    '台北市文山區萬盛街89號',
    '台北市文山區萬盛街1巷89號之6',
    '台北市文山區萬盛街89號之6附近',
    '台北市文山區萬盛街89號之6隔壁巷',
    '台北市文山區萬盛街89號之6七樓之12附近',
  ]) {
    assert.equal(locateAddress(index, input).method, 'unresolved', input);
  }
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

test('maps the current official code-based doorplate schema to Taipei district names', async () => {
  const districts = [
    ['63000010', '松山區'],
    ['63000020', '信義區'],
    ['63000030', '大安區'],
    ['63000040', '中山區'],
    ['63000050', '中正區'],
    ['63000060', '大同區'],
    ['63000070', '萬華區'],
    ['63000080', '文山區'],
    ['63000090', '南港區'],
    ['63000100', '內湖區'],
    ['63000110', '士林區'],
    ['63000120', '北投區'],
  ];
  const csv = [
    '省市縣市代碼,鄉鎮市區代碼,村里,鄰,街路段,地區,巷,弄,號,橫座標,縱座標',
    ...districts.map(([code], index) =>
      `63000,${code},測試里,001,測試路,,,,${index + 1}號,306940,2769625`),
  ].join('\n');

  const index = await buildDoorplateIndex(Readable.from(`${csv}\n`), 'official-code-schema');

  assert.deepEqual(
    Object.values(index.byRoad).flat().map((point) => point.district).sort(),
    districts.map(([, district]) => district).sort(),
  );
  assert.equal(
    index.byCanonicalAddress['台北市松山區測試路1號']?.[0]?.district,
    '松山區',
  );
});

test('collapses floor-specific official rows into one base doorplate point', async () => {
  const csv = [
    '省市縣市代碼,鄉鎮市區代碼,村里,鄰,街路段,地區,巷,弄,號,橫座標,縱座標',
    '63000,63000010,三民里,002,三民路,,,,９１號,306847.966,2772208.374',
    '63000,63000010,三民里,002,三民路,,,,９１號二樓,306847.966,2772208.374',
    '63000,63000010,三民里,002,三民路,,,,９１號三樓,306847.966,2772208.374',
    '63000,63000010,三民里,002,三民路,,,,９１號四樓,306847.966,2772208.374',
  ].join('\n');

  const index = await buildDoorplateIndex(Readable.from(`${csv}\n`), 'floor-duplicates');

  assert.deepEqual(Object.keys(index.byCanonicalAddress), ['台北市松山區三民路91號']);
  assert.equal(index.byCanonicalAddress['台北市松山區三民路91號']?.length, 1);
  assert.equal(index.byRoad['台北市松山區三民路']?.length, 1);
  assert.equal(Object.values(index.cells).flat().length, 1);
});

test('exact lookup fails closed for coordinate-conflicting base keys regardless of row order', async () => {
  const header = '完整地址,坐標X,坐標Y';
  const records = [
    '台北市文山區萬盛街89號之6,306940,2769625',
    '台北市文山區萬盛街89號之6七樓,306960,2769625',
  ];
  const indexes = await Promise.all([
    buildDoorplateIndex(Readable.from(`${header}\n${records.join('\n')}\n`), 'conflicting-points'),
    buildDoorplateIndex(Readable.from(`${header}\n${[...records].reverse().join('\n')}\n`), 'conflicting-points'),
  ]);

  assert.equal(JSON.stringify(indexes[0]), JSON.stringify(indexes[1]));
  for (const index of indexes) {
    assert.equal(index.byCanonicalAddress['台北市文山區萬盛街89號之6']?.length, 2);
    const result = locateAddress(index, '台北市文山區萬盛街89號之6');
    assert.equal(result.method, 'unresolved');
    assert.equal(result.coordinate, null);
    assert.equal(result.confidence, 'low');
  }
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

test('rejects a doorplate source with missing required structural headers', () => {
  assert.throws(
    () => validateDoorplateHeaders(['完整地址', '坐標X']),
    /required doorplate headers/i,
  );
});
