import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExitsCsv, nearestExit } from './mrt.ts';

const CSV =
  '﻿station_id,line,name_zh,exit_id,latitude,longitude\n' +
  'BL01,板南線,頂埔,1,24.959327,121.418336\n' +
  'R10,淡水信義線,台北車站,2,25.047,121.517\n';

test('parseExitsCsv strips the BOM and parses rows', () => {
  const exits = parseExitsCsv(CSV);
  assert.equal(exits.length, 2);
  assert.equal(exits[0].stationId, 'BL01'); // BOM stripped, not "﻿BL01"
  assert.equal(exits[0].nameZh, '頂埔');
  assert.equal(exits[1].lat, 25.047);
});

test('parseExitsCsv skips rows without valid coordinates', () => {
  const exits = parseExitsCsv('﻿station_id,line,name_zh,exit_id,latitude,longitude\nX,L,N,1,foo,bar\n');
  assert.equal(exits.length, 0);
});

test('nearestExit picks the closest exit by straight-line distance', () => {
  const exits = parseExitsCsv(CSV);
  const near = nearestExit({ lat: 25.0471, lng: 121.5171 }, exits);
  assert.ok(near);
  assert.equal(near!.exit.nameZh, '台北車站');
  assert.ok(near!.distanceM < 50, `got ${near!.distanceM}`);
});

test('nearestExit returns null for an empty dataset', () => {
  assert.equal(nearestExit({ lat: 25, lng: 121 }, []), null);
});
