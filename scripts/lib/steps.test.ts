import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Logger } from './journal.ts';
import { enrichStep, isRetryableOrsLimitError, withOrsLimitRetry } from './steps.ts';
import { enrichedPath, listingsPath, runDir } from './runpaths.ts';

test('ORS limit detection retries rate limits and quota exhaustion', () => {
  assert.equal(isRetryableOrsLimitError(new Error('ORS matrix HTTP 429: slow down')), true);
  assert.equal(isRetryableOrsLimitError(new Error('ORS matrix HTTP 403: {"error":"Quota exceeded"}')), true);
  assert.equal(isRetryableOrsLimitError(new Error('ORS matrix HTTP 403: forbidden')), false);
  assert.equal(isRetryableOrsLimitError(new Error('ORS matrix HTTP 500: unavailable')), false);
});

test('ORS limit retry waits once and returns the second result', async () => {
  let calls = 0;
  const waits: number[] = [];
  const value = await withOrsLimitRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('ORS matrix HTTP 403: Quota exceeded');
      return ['ok'];
    },
    async (ms) => { waits.push(ms); },
  );
  assert.deepEqual(value, ['ok']);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [60_000]);
});

test('ORS limit retry gives up after the second limited response', async () => {
  let calls = 0;
  await assert.rejects(
    withOrsLimitRetry(
      async () => {
        calls += 1;
        throw new Error('ORS matrix HTTP 429: slow down');
      },
      async () => {},
    ),
    /HTTP 429/,
  );
  assert.equal(calls, 2);
});

test('enrich performs no market refresh or ORS work for an empty listing run', async (t) => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const isolatedCwd = fs.mkdtempSync(path.join(tmpdir(), 'enrich-read-only-'));
  fs.mkdirSync(path.join(isolatedCwd, 'data'), { recursive: true });
  fs.copyFileSync(
    path.join(originalCwd, 'data/taipei_mrt_exits.csv'),
    path.join(isolatedCwd, 'data/taipei_mrt_exits.csv'),
  );
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('market refresh must not fetch');
  }) as typeof fetch;
  process.chdir(isolatedCwd);
  t.after(() => {
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    fs.rmSync(isolatedCwd, { recursive: true, force: true });
  });

  const profile = { id: 'test-read-only-enrich', displayName: 'test', fetch: {}, evaluation: { maxDaysOnMarket: 365 } };
  const range = { from: '0003-03-05', to: '0003-03-05', label: '0003-03-05' };
  const dir = runDir(profile.id, range.label);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(listingsPath(profile.id, range.label), JSON.stringify({
    from: range.from,
    to: range.to,
    fetchedAt: '0003-03-06T00:00:00.000Z',
    count: 0,
    listings: [],
  }));
  const events: string[] = [];
  const logger: Logger = { event: (_level, event) => events.push(event) };

  const output = await enrichStep({ profile, range }, logger);

  assert.equal(fetchCalls, 0);
  assert.ok(events.includes('market-data.unavailable'));
  assert.deepEqual(output.summary, {
    withinWalk: 0,
    manualReview: 0,
    hardExcluded: 0,
    tenureEligible: 0,
    tenureExpired: 0,
    tenureReview: 0,
    marketReliable: 0,
    marketReview: 0,
    marketUnavailable: 0,
    marketDataStale: 0,
    orsCalls: 0,
    cacheHits: 0,
    routeErrors: 0,
  });
  const result = JSON.parse(fs.readFileSync(enrichedPath(profile.id, range.label), 'utf8'));
  assert.equal(result.count, 0);
  assert.deepEqual(result.listings, []);
});


test('enrich resolves walking with Valhalla after the ORS quota retry fails', async (t) => {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'enrich-dual-'));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ORS_API_KEY;
  const originalUrl = process.env.VALHALLA_URL;
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data/taipei_mrt_exits.csv'),
    'station_id,line,name_zh,exit_id,latitude,longitude\nO06,L,東門,4,25.0335,121.5285\n');
  process.chdir(dir);
  process.env.ORS_API_KEY = 'test-key';
  process.env.VALHALLA_URL = 'https://routing.example';
  t.after(() => {
    process.chdir(cwd);
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ORS_API_KEY;
    else process.env.ORS_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.VALHALLA_URL;
    else process.env.VALHALLA_URL = originalUrl;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let orsCalls = 0, valhallaCalls = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).includes('openrouteservice')) {
      orsCalls++;
      return new Response('{"error":"Quota exceeded"}', { status: 403 });
    }
    assert.equal(String(url), 'https://routing.example/sources_to_targets');
    valhallaCalls++;
    return Response.json({ sources_to_targets: { distances: [[0.7]] } });
  }) as typeof fetch;
  const profile = { id: 'dual-test', displayName: 'test', fetch: {}, evaluation: { maxDaysOnMarket: 365 } };
  const range = { from: '2026-10-29', to: '2026-10-29', label: '2026-10-29' };
  fs.mkdirSync(runDir(profile.id, range.label), { recursive: true });
  const listing = {
    title: 'test', addressOrArea: '台北市中正區金山南路',
    coordinate: { lat: 25.033, lng: 121.522 }, listingHistory: [],
    totalPrice: null, totalPing: null, unitPrice: null, age: null, parking: null,
  };
  fs.writeFileSync(listingsPath(profile.id, range.label), JSON.stringify({
    ...range, count: 2, listings: [listing, { ...listing, coordinate: { lat: 25.034, lng: 121.522 } }],
  }));
  // Keep the public operation fast while exercising the actual retry and provider clients.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = enrichStep({ profile, range }, { event: () => {} });
  let finished = false;
  void pending.finally(() => { finished = true; });
  while (!finished) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(60_000);
  }
  await pending;
  const result = JSON.parse(fs.readFileSync(enrichedPath(profile.id, range.label), 'utf8'));
  assert.equal(result.manualReviewCount, 0);
  assert.equal(result.withinWalkCount, 2);
  assert.equal(result.listings[0].regionGate, 'in');
  assert.equal(result.listings[0].routing.selectedProvider, 'valhalla');
  assert.equal(orsCalls, 2);
  assert.equal(valhallaCalls, 2);
});
