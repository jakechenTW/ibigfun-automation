/**
 * On-disk cache of ORS walking distances, shared by enrich.ts and route.ts so
 * repeated routing of the same coordinate→exits is free and reproducible.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LatLng } from './geo.ts';
import type { NearestExit } from './mrt.ts';

export const CACHE_PATH = path.join('state', 'route-cache.json');

export type RouteCache = Record<string, (number | null)[]>;

export function loadCache(): RouteCache {
  return fs.existsSync(CACHE_PATH)
    ? (JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) as RouteCache)
    : {};
}

export function saveCache(cache: RouteCache): void {
  fs.mkdirSync('state', { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/** Cache key from a rounded coordinate plus the candidate exit ids. */
export function cacheKey(coord: LatLng, candidates: NearestExit[]): string {
  const exits = candidates
    .map((x) => `${x.exit.stationId}:${x.exit.exitId}`)
    .join(',');
  return `${coord.lat.toFixed(5)},${coord.lng.toFixed(5)}|${exits}`;
}
