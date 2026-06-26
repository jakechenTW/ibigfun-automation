/**
 * Taipei MRT exit dataset: parse the CSV and find the nearest exit to a point.
 * `parseExitsCsv` and `nearestExit` are pure (unit-tested); `loadExits` reads
 * the file. Dataset: data/taipei_mrt_exits.csv (see data/README.md).
 */
import * as fs from 'node:fs';
import { haversineMeters, type LatLng } from './geo.ts';

export interface MrtExit {
  stationId: string;
  line: string;
  nameZh: string;
  exitId: string;
  lat: number;
  lng: number;
}

export interface NearestExit {
  exit: MrtExit;
  distanceM: number;
}

/** Parse the exits CSV text (tolerates a UTF-8 BOM on the header). */
export function parseExitsCsv(content: string): MrtExit[] {
  const rows = content.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  rows.shift(); // header: station_id,line,name_zh,exit_id,latitude,longitude
  const exits: MrtExit[] = [];
  for (const row of rows) {
    const [stationId, line, nameZh, exitId, lat, lng] = row.split(',');
    const latN = Number(lat);
    const lngN = Number(lng);
    if (!Number.isFinite(latN) || !Number.isFinite(lngN)) continue;
    exits.push({ stationId, line, nameZh, exitId, lat: latN, lng: lngN });
  }
  return exits;
}

export function loadExits(path: string): MrtExit[] {
  return parseExitsCsv(fs.readFileSync(path, 'utf8'));
}

/** Nearest exit (by straight-line distance) to `coord`, or null if no exits. */
export function nearestExit(coord: LatLng, exits: MrtExit[]): NearestExit | null {
  let best: NearestExit | null = null;
  for (const exit of exits) {
    const distanceM = haversineMeters(coord, { lat: exit.lat, lng: exit.lng });
    if (!best || distanceM < best.distanceM) best = { exit, distanceM };
  }
  return best;
}
