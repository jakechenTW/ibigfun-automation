import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const VALHALLA_TRIAL_CACHE_PATH = 'state/valhalla-trial-cache.json';

export interface ValhallaTrialCacheEntry {
  distances: (number | null)[];
  cachedAt: string;
}

export interface ValhallaTrialCache {
  schemaVersion: 1;
  endpoints: Record<string, { routes: Record<string, ValhallaTrialCacheEntry> }>;
}

export interface TrialCacheFileOps {
  writeExclusive(file: string, contents: string): void;
  rename(source: string, destination: string): void;
  remove(file: string): void;
}

const INVALID_CACHE_MESSAGE = 'Invalid Valhalla trial cache';
const ENDPOINT_KEY_PATTERN = /^[a-f0-9]{64}$/;
const PERSISTENCE_ERROR_MESSAGE = 'Valhalla trial cache persistence failed';

const defaultFileOps: TrialCacheFileOps = {
  writeExclusive: (file, contents) => {
    fs.writeFileSync(file, contents, { flag: 'wx', mode: 0o600 });
  },
  rename: (source, destination) => fs.renameSync(source, destination),
  remove: (file) => fs.rmSync(file, { force: true }),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function isValidDistance(value: unknown): value is number | null {
  return value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isCacheEntry(value: unknown): value is ValhallaTrialCacheEntry {
  return isRecord(value)
    && hasExactKeys(value, ['distances', 'cachedAt'])
    && Array.isArray(value.distances)
    && value.distances.every(isValidDistance)
    && isCanonicalTimestamp(value.cachedAt);
}

function isRoutes(value: unknown): value is Record<string, ValhallaTrialCacheEntry> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([routeKey, entry]) =>
    routeKey.length > 0 && isCacheEntry(entry));
}

function isEndpoint(value: unknown): value is { routes: Record<string, ValhallaTrialCacheEntry> } {
  return isRecord(value)
    && hasExactKeys(value, ['routes'])
    && isRoutes(value.routes);
}

function isValhallaTrialCache(value: unknown): value is ValhallaTrialCache {
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'endpoints'])
    || value.schemaVersion !== 1
    || !isRecord(value.endpoints)) return false;
  return Object.entries(value.endpoints).every(([endpointKey, endpoint]) =>
    ENDPOINT_KEY_PATTERN.test(endpointKey) && isEndpoint(endpoint));
}

function invalidCache(): Error {
  return new Error(INVALID_CACHE_MESSAGE);
}

export function trialEndpointKey(normalizedBaseUrl: string): string {
  return createHash('sha256').update(normalizedBaseUrl).digest('hex');
}

export function loadValhallaTrialCache(rootDir: string): ValhallaTrialCache {
  const cachePath = path.join(rootDir, VALHALLA_TRIAL_CACHE_PATH);
  if (!fs.existsSync(cachePath)) return { schemaVersion: 1, endpoints: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    throw invalidCache();
  }
  if (!isValhallaTrialCache(parsed)) throw invalidCache();
  return parsed;
}

export function getValhallaTrialCacheEntry(
  cache: ValhallaTrialCache,
  endpointKey: string,
  routeKey: string,
  expectedLength: number,
): (number | null)[] | null {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) return null;
  const entry = cache.endpoints[endpointKey]?.routes[routeKey];
  if (entry === undefined || entry.distances.length !== expectedLength) return null;
  return [...entry.distances];
}

export function putValhallaTrialCacheEntry(
  cache: ValhallaTrialCache,
  endpointKey: string,
  routeKey: string,
  distances: (number | null)[],
  cachedAt: string,
): void {
  const entry = { distances, cachedAt };
  if (!isValhallaTrialCache(cache)
    || !ENDPOINT_KEY_PATTERN.test(endpointKey)
    || routeKey.length === 0
    || !isCacheEntry(entry)) throw invalidCache();

  cache.endpoints[endpointKey] ??= { routes: {} };
  cache.endpoints[endpointKey].routes[routeKey] = {
    distances: [...distances],
    cachedAt,
  };
}

export function saveValhallaTrialCacheAtomic(
  rootDir: string,
  cache: ValhallaTrialCache,
  operations: TrialCacheFileOps = defaultFileOps,
): void {
  if (!isValhallaTrialCache(cache)) throw new Error(PERSISTENCE_ERROR_MESSAGE);

  const finalPath = path.join(rootDir, VALHALLA_TRIAL_CACHE_PATH);
  const temporaryPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
  let failed = false;
  let published = false;
  try {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    operations.writeExclusive(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`);
    operations.rename(temporaryPath, finalPath);
    published = true;
  } catch {
    failed = true;
  } finally {
    try {
      operations.remove(temporaryPath);
    } catch {
      if (!published) failed = true;
    }
  }
  if (failed) throw new Error(PERSISTENCE_ERROR_MESSAGE);
}
