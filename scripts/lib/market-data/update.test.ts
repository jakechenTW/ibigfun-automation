import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureTaipeiMarketData } from './update.ts';
import { sha256File } from './store.ts';
import type { MarketDataManifest } from './types.ts';

async function seedValidBuild(root: string): Promise<void> {
  await mkdir(join(root, 'raw'), { recursive: true });
  await writeFile(join(root, 'raw', 'source.csv'), 'fixture\n');
  await writeFile(join(root, 'doorplates-index.json'), JSON.stringify({ schemaVersion: 1, datasetVersion: 'd', byCanonicalAddress: {}, byRoad: {}, cells: { cell: [{ canonicalAddress: '台北市中正區測試路1號', coordinate: { lat: 25, lng: 121.5 }, district: '中正區', roadKey: 'r', mainNumber: 1, subNumber: null }] } }));
  await writeFile(join(root, 'transactions-index.json'), JSON.stringify({ schemaVersion: 1, datasetVersion: 't', builtAt: '2026-07-01T00:00:00.000Z', cells: { cell: [{ id: 'tx-1', location: { coordinate: { lat: 25, lng: 121.5 } } }] } }));
  const artifacts: MarketDataManifest['artifacts'] = {};
  for (const file of ['raw/source.csv', 'doorplates-index.json', 'transactions-index.json']) {
    artifacts[file] = { sha256: await sha256File(join(root, file)), bytes: (await readFile(join(root, file))).byteLength };
  }
  const manifest: MarketDataManifest = {
    schemaVersion: 1, buildId: 'known-good', builtAt: '2026-07-01T00:00:00.000Z',
    doorplates: { sourceUrl: 'https://example.test/d.csv', publishedAt: null, checkedAt: '2026-07-01T00:00:00.000Z', sha256: 'd', recordCount: 1 },
    transactions: { sourceUrls: [], publishedAt: null, checkedAt: '2026-07-01T00:00:00.000Z', sha256: 't', recordCount: 1 },
    artifacts, lastFailure: null,
  };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
}

test('updater returns null and journals unavailable when no valid local build can be refreshed', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  const events: string[] = [];
  const bundle = await ensureTaipeiMarketData({
    asOf: '2026-07-25', rootPath,
    fetch: async () => { throw new Error('offline'); },
    logger: { event: (_level, event) => events.push(event) },
  });
  assert.equal(bundle, null);
  assert.deepEqual(events, ['market-data.check', 'market-data.unavailable']);
});

test('updater retains a valid active build when an offline refresh fails', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  await seedValidBuild(rootPath);
  const events: string[] = [];
  const bundle = await ensureTaipeiMarketData({
    asOf: '2026-07-25', rootPath, minDoorplates: 1, minTransactions: 1,
    fetch: async () => { throw new Error('offline'); },
    logger: { event: (_level, event) => events.push(event) },
  });
  assert.equal(bundle?.manifest.buildId, 'known-good');
  assert.deepEqual(events, ['market-data.check', 'market-data.last-known-good']);
});
