import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  getValhallaTrialCacheEntry,
  loadValhallaTrialCache,
  putValhallaTrialCacheEntry,
  saveValhallaTrialCacheAtomic,
  trialEndpointKey,
  type ValhallaTrialCache,
} from './valhalla-trial-cache.ts';

const endpointKey = 'a'.repeat(64);
const routeKey = '25.03300,121.56500|G15:4,G15:3';
const cachedAt = '2026-08-12T01:02:03.000Z';

function disposableRoot(t: test.TestContext): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valhalla-trial-cache-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function validCache(): ValhallaTrialCache {
  return {
    schemaVersion: 1,
    endpoints: {
      [endpointKey]: {
        routes: {
          [routeKey]: { distances: [0, null, 812.5], cachedAt },
        },
      },
    },
  };
}

function writeCache(rootDir: string, value: unknown): void {
  const stateDir = path.join(rootDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'valhalla-trial-cache.json'), JSON.stringify(value));
}

test('missing trial cache starts empty without reading or mutating the production ORS cache', (t) => {
  // Would fail if the loader reused state/route-cache.json or created trial state while reading.
  const rootDir = disposableRoot(t);
  const stateDir = path.join(rootDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const orsPath = path.join(stateDir, 'route-cache.json');
  const orsBytes = Buffer.from('{"production-secret":[123]}\n');
  fs.writeFileSync(orsPath, orsBytes);

  assert.deepEqual(loadValhallaTrialCache(rootDir), { schemaVersion: 1, endpoints: {} });
  assert.deepEqual(fs.readFileSync(orsPath), orsBytes);
  assert.deepEqual(fs.readdirSync(stateDir), ['route-cache.json']);
});

test('endpoint keys are path-sensitive SHA-256 values that do not persist the URL', () => {
  // Would fail if endpoint paths were dropped from identity or written into cache state.
  assert.match(trialEndpointKey('https://example.test/path'), /^[a-f0-9]{64}$/);
  assert.notEqual(
    trialEndpointKey('https://example.test/path-a'),
    trialEndpointKey('https://example.test/path-b'),
  );
  const cache: ValhallaTrialCache = {
    schemaVersion: 1,
    endpoints: {
      [trialEndpointKey('https://example.test/path-a')]: { routes: {} },
    },
  };
  assert.equal(JSON.stringify(cache).includes('/path-a'), false);
});

test('loader rejects every malformed cache level before returning typed state', (t) => {
  // Would fail if schema drift, unkeyed endpoints, malformed routes, dates, or distances were trusted.
  const rootDir = disposableRoot(t);
  const valid = validCache();
  const invalidValues: unknown[] = [
    { ...valid, schemaVersion: 2 },
    { ...valid, unexpected: true },
    { schemaVersion: 1, endpoints: { notHex: { routes: {} } } },
    { schemaVersion: 1, endpoints: { [endpointKey]: null } },
    { schemaVersion: 1, endpoints: { [endpointKey]: { routes: {}, unexpected: true } } },
    { schemaVersion: 1, endpoints: { [endpointKey]: { routes: [] } } },
    { schemaVersion: 1, endpoints: { [endpointKey]: { routes: { '': { distances: [], cachedAt } } } } },
    { schemaVersion: 1, endpoints: { [endpointKey]: { routes: { [routeKey]: null } } } },
    { schemaVersion: 1, endpoints: { [endpointKey]: { routes: { [routeKey]: { distances: [], cachedAt, unexpected: true } } } } },
    { schemaVersion: 1, endpoints: { [endpointKey]: { routes: { [routeKey]: { distances: 'none', cachedAt } } } } },
    { schemaVersion: 1, endpoints: { [endpointKey]: { routes: { [routeKey]: { distances: [1], cachedAt: 'not-a-date' } } } } },
    { schemaVersion: 1, endpoints: { [endpointKey]: { routes: { [routeKey]: { distances: [1], cachedAt: '2026-02-30T00:00:00.000Z' } } } } },
    { schemaVersion: 1, endpoints: { [endpointKey]: { routes: { [routeKey]: { distances: [-1], cachedAt } } } } },
    { schemaVersion: 1, endpoints: { [endpointKey]: { routes: { [routeKey]: { distances: ['1'], cachedAt } } } } },
  ];

  for (const value of invalidValues) {
    writeCache(rootDir, value);
    assert.throws(() => loadValhallaTrialCache(rootDir), /Invalid Valhalla trial cache/);
  }

  fs.writeFileSync(
    path.join(rootDir, 'state', 'valhalla-trial-cache.json'),
    `{"schemaVersion":1,"endpoints":{"${endpointKey}":{"routes":{"${routeKey}":{"distances":[1e400],"cachedAt":"${cachedAt}"}}}}}`,
  );
  assert.throws(() => loadValhallaTrialCache(rootDir), /Invalid Valhalla trial cache/);
});

test('loader accepts valid nested cache data', (t) => {
  // Would fail if strict validation rejected zero, null, fractional distance, or a canonical timestamp.
  const rootDir = disposableRoot(t);
  const cache = validCache();
  writeCache(rootDir, cache);

  assert.deepEqual(loadValhallaTrialCache(rootDir), cache);
});

test('cache access enforces aligned lengths and prevents distance-array aliasing', () => {
  // Would fail if a route reused distances for a different exit count or exposed stored arrays by reference.
  const cache: ValhallaTrialCache = { schemaVersion: 1, endpoints: {} };
  const inserted = [420, null, 810];
  putValhallaTrialCacheEntry(cache, endpointKey, routeKey, inserted, cachedAt);
  inserted[0] = 9999;

  assert.equal(getValhallaTrialCacheEntry(cache, endpointKey, routeKey, 2), null);
  const first = getValhallaTrialCacheEntry(cache, endpointKey, routeKey, 3);
  assert.deepEqual(first, [420, null, 810]);
  assert.notEqual(first, cache.endpoints[endpointKey].routes[routeKey].distances);
  first![0] = 1;
  assert.deepEqual(getValhallaTrialCacheEntry(cache, endpointKey, routeKey, 3), [420, null, 810]);
});

test('atomic save creates a private final file and replaces prior cache without temporary siblings', (t) => {
  // Would fail if persistence were non-atomic, used a different path, retained old data, or leaked a temp file.
  const rootDir = disposableRoot(t);
  const first = validCache();
  saveValhallaTrialCacheAtomic(rootDir, first);

  const stateDir = path.join(rootDir, 'state');
  const finalPath = path.join(stateDir, 'valhalla-trial-cache.json');
  assert.deepEqual(fs.readdirSync(stateDir), ['valhalla-trial-cache.json']);
  assert.equal(fs.statSync(finalPath).mode & 0o777, 0o600);
  assert.deepEqual(loadValhallaTrialCache(rootDir), first);

  const replacement: ValhallaTrialCache = { schemaVersion: 1, endpoints: {} };
  saveValhallaTrialCacheAtomic(rootDir, replacement);
  assert.deepEqual(loadValhallaTrialCache(rootDir), replacement);
  assert.deepEqual(fs.readdirSync(stateDir), ['valhalla-trial-cache.json']);
});

test('atomic save preserves prior final bytes and cleans its temp when rename fails', (t) => {
  // Would fail if the implementation truncated the final path first, leaked details, or skipped failure cleanup.
  const rootDir = disposableRoot(t);
  writeCache(rootDir, validCache());
  const stateDir = path.join(rootDir, 'state');
  const finalPath = path.join(stateDir, 'valhalla-trial-cache.json');
  const priorBytes = fs.readFileSync(finalPath);
  const removed: string[] = [];

  assert.throws(
    () => saveValhallaTrialCacheAtomic(
      rootDir,
      { schemaVersion: 1, endpoints: {} },
      {
        writeExclusive: (file, contents) => {
          fs.writeFileSync(file, contents, { flag: 'wx', mode: 0o600 });
        },
        rename: () => {
          throw new Error(`synthetic rename failure for ${rootDir}`);
        },
        remove: (file) => {
          removed.push(file);
          fs.rmSync(file, { force: true });
        },
      },
    ),
    (error: Error) => error.message === 'Valhalla trial cache persistence failed',
  );

  assert.deepEqual(fs.readFileSync(finalPath), priorBytes);
  assert.equal(removed.length, 1);
  assert.match(path.basename(removed[0]), /^valhalla-trial-cache\.json\.tmp-/);
  assert.deepEqual(fs.readdirSync(stateDir), ['valhalla-trial-cache.json']);
});
