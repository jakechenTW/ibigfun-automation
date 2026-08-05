import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Logger } from './journal.ts';
import { enrichStep } from './steps.ts';
import { enrichedPath, listingsPath, runDir } from './runpaths.ts';

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
