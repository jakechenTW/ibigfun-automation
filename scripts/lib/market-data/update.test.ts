import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureTaipeiMarketData, withMarketDataLock } from './update.ts';
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
  assert.equal(bundle?.refresh?.status, 'last-known-good');
  assert.match(bundle?.refresh?.failure ?? '', /offline/);
  assert.deepEqual(events, ['market-data.check', 'market-data.last-known-good']);
});

test('unchanged conditional refresh keeps build and index checksums while advancing checkedAt', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  const doorplateCsv = await readFile(fileURLToPath(new URL('./fixtures/doorplates.csv', import.meta.url)));
  const transactionCsv = await readFile(fileURLToPath(new URL('./fixtures/transactions.csv', import.meta.url)));
  const detail = '<a href="https://example.test/resource.download?rid=one&amp;fileName=doorplates.csv">doorplates.csv</a><time datetime="2026-07-02T09:47:33+08:00"></time>';
  let repeat = false;
  let concurrentChange = false;
  let changedOnce = false;
  const conditionalSeasons: string[] = [];
  const fakeFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('dataset/detail')) return new Response(detail);
    if (url.includes('resource.download')) {
      if (repeat) {
        const expected = changedOnce ? '"doorplates-v2"' : '"doorplates-v1"';
        assert.equal(new Headers(init?.headers).get('if-none-match'), expected);
        if (concurrentChange && !changedOnce) {
          changedOnce = true;
          return new Response(Buffer.concat([doorplateCsv, Buffer.from('\n')]), { headers: { etag: '"doorplates-v2"' } });
        }
        return new Response(null, { status: 304 });
      }
      return new Response(doorplateCsv, { headers: { etag: '"doorplates-v1"' } });
    }
    const season = new URL(url).searchParams.get('season')!;
    if (repeat) {
      conditionalSeasons.push(season);
      assert.equal(new Headers(init?.headers).get('if-none-match'), `"${season}"`);
      return new Response(null, { status: 304 });
    }
    return new Response('synthetic zip', { headers: { etag: `"${season}"` } });
  };
  const events: string[] = [];
  const first = await ensureTaipeiMarketData({
    asOf: '2026-07-25', rootPath, minDoorplates: 1, minTransactions: 1,
    fetch: fakeFetch, clock: () => new Date('2026-07-25T01:00:00.000Z'),
    openZip: async () => [{ path: 'a_lvr_land_a.csv', stream: () => Readable.from(transactionCsv) }],
    logger: { event: (_level, event) => events.push(event) },
  });
  assert.equal(first?.refresh?.status, 'updated');
  const buildId = first!.manifest.buildId;
  const indexChecksums = {
    doorplates: first!.manifest.artifacts['doorplates-index.json']!.sha256,
    transactions: first!.manifest.artifacts['transactions-index.json']!.sha256,
  };

  repeat = true;
  const second = await ensureTaipeiMarketData({
    asOf: '2026-07-25', rootPath, minDoorplates: 1, minTransactions: 1,
    fetch: fakeFetch, clock: () => new Date('2026-07-26T01:00:00.000Z'),
    openZip: async () => { throw new Error('unchanged ZIP must not be opened'); },
    logger: { event: (_level, event) => events.push(event) },
  });
  assert.equal(second?.refresh?.status, 'not-modified');
  assert.equal(second?.manifest.buildId, buildId);
  assert.equal(second?.manifest.builtAt, first?.manifest.builtAt);
  assert.deepEqual({
    doorplates: second!.manifest.artifacts['doorplates-index.json']!.sha256,
    transactions: second!.manifest.artifacts['transactions-index.json']!.sha256,
  }, indexChecksums);
  assert.equal(second?.manifest.doorplates.checkedAt, '2026-07-26T01:00:00.000Z');
  assert.equal(second?.manifest.transactions.checkedAt, '2026-07-26T01:00:00.000Z');
  assert.deepEqual(conditionalSeasons.sort(), ['115S2', '115S3']);
  assert.equal(events.at(-1), 'market-data.not-modified');

  concurrentChange = true;
  const concurrentOptions = {
    asOf: '2026-07-25', rootPath, minDoorplates: 1, minTransactions: 1,
    fetch: fakeFetch, clock: () => new Date('2026-07-27T01:00:00.000Z'),
    openZip: async () => { throw new Error('conditionally unchanged ZIP must not be opened'); },
  };
  const concurrent = await Promise.all([
    ensureTaipeiMarketData(concurrentOptions),
    ensureTaipeiMarketData(concurrentOptions),
  ]);
  const publisher = concurrent.find((bundle) => bundle?.refresh?.status === 'updated');
  const follower = concurrent.find((bundle) => bundle?.refresh?.status === 'not-modified');
  assert.equal(publisher?.refresh?.status, 'updated');
  assert.equal(follower?.refresh?.status, 'not-modified');
  assert.equal(follower?.manifest.buildId, publisher?.manifest.buildId);
  assert.equal((await readFile(join(rootPath, 'manifest.json'), 'utf8')).includes(publisher!.manifest.buildId), true);
});

test('filesystem refresh lock serializes overlapping jobs and cleans up after errors', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-lock-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  let active = 0;
  let maxActive = 0;
  const operation = async () => withMarketDataLock(rootPath, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
  }, { timeoutMs: 500, staleMs: 5_000, pollMs: 5 });
  await Promise.all([operation(), operation()]);
  assert.equal(maxActive, 1);

  await assert.rejects(
    () => withMarketDataLock(rootPath, async () => { throw new Error('inside lock'); }),
    /inside lock/,
  );
  await withMarketDataLock(rootPath, async () => undefined, { timeoutMs: 100, pollMs: 5 });
});

test('lock removes only its newly-created directory when owner metadata write fails', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-lock-'));
  const rootPath = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await assert.rejects(
    () => withMarketDataLock(rootPath, async () => undefined, {
      writeOwner: async () => { throw new Error('owner write failed'); },
    }),
    /owner write failed/,
  );
  await withMarketDataLock(rootPath, async () => undefined, { timeoutMs: 100, pollMs: 5 });
});

test('lock rejects unsafe timing values and heartbeat prevents reclaiming a live lease', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-lock-'));
  const rootPath = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const timings of [
    { timeoutMs: 0 }, { timeoutMs: Number.NaN }, { pollMs: 0 },
    { staleMs: 20 }, { timeoutMs: 10, pollMs: 20 },
  ]) {
    await assert.rejects(() => withMarketDataLock(rootPath, async () => undefined, timings), /lock timing/i);
  }

  let firstExited = false;
  const first = withMarketDataLock(rootPath, async () => {
    await new Promise((resolve) => setTimeout(resolve, 140));
    firstExited = true;
  }, { timeoutMs: 500, staleMs: 60, pollMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 70));
  await withMarketDataLock(rootPath, async () => {
    assert.equal(firstExited, true);
  }, { timeoutMs: 500, staleMs: 60, pollMs: 5 });
  await first;
});

test('lock takes over a genuinely stale abandoned lease', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-lock-'));
  const rootPath = join(parent, 'taipei');
  const lockPath = join(parent, '.taipei-refresh.lock');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(lockPath);
  await writeFile(join(lockPath, 'owner'), 'abandoned');
  const old = new Date(Date.now() - 10_000);
  await utimes(lockPath, old, old);
  let entered = false;
  await withMarketDataLock(rootPath, async () => { entered = true; }, {
    timeoutMs: 200, staleMs: 60, pollMs: 5,
  });
  assert.equal(entered, true);
});
