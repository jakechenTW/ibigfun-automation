import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureTaipeiMarketData, withMarketDataLock } from './update.ts';
import {
  backtestAcceptancePath,
  marketDataBacktestAccepted,
  publishStagedBuildWithAcceptance,
  sha256File,
} from './store.ts';
import { ESTIMATOR_POLICY_VERSION, MARKET_SCHEMA_VERSION } from './config.ts';
import type { BacktestGateResult } from './backtest.ts';
import type { MarketDataManifest } from './types.ts';

const PASSING_GATE: BacktestGateResult = { passed: true, complete: true, reasons: [] };

function productionPassingTransactionCsv(base: Buffer): Buffer {
  const rows = base.toString('utf8').trimEnd().split('\n');
  const transactionRows: string[] = [];
  for (let day = 0; day < 36; day += 1) {
    const date = new Date(Date.UTC(2025, 0, 1 + day));
    const rocDate = `${date.getUTCFullYear() - 1911}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
    transactionRows.push(
      `房地(土地+建物),台北市中正區測試路1段10號,${rocDate},五層,十層,華廈(10層含以下有電梯),1000101,100,30000000,300000,無車位,0,0,住家用,土地1建物1車位0,有,,G-H-${day}`,
    );
    const totalPrice = [27_000_000, 30_000_000, 33_000_000][day % 3]!;
    transactionRows.push(
      `房地(土地+建物),台北市中正區測試路1段10號,${rocDate},三層,五層,公寓(5樓含以下無電梯),0900101,100,${totalPrice},${totalPrice / 100},無車位,0,0,住家用,土地1建物1車位0,無,,G-M-${day}`,
    );
  }
  return Buffer.from([...rows, ...transactionRows].join('\n'));
}

async function seedValidBuild(root: string): Promise<void> {
  await mkdir(join(root, 'raw'), { recursive: true });
  await writeFile(join(root, 'raw', 'source.csv'), 'fixture\n');
  await writeFile(join(root, 'doorplates-index.json'), JSON.stringify({ schemaVersion: MARKET_SCHEMA_VERSION, datasetVersion: 'd', byCanonicalAddress: {}, byRoad: {}, cells: { cell: [{ canonicalAddress: '台北市中正區測試路1號', coordinate: { lat: 25, lng: 121.5 }, district: '中正區', roadKey: 'r', mainNumber: 1, subNumber: null }] } }));
  await writeFile(join(root, 'transactions-index.json'), JSON.stringify({ schemaVersion: MARKET_SCHEMA_VERSION, datasetVersion: 't', builtAt: '2026-07-01T00:00:00.000Z', cells: { cell: [{ id: 'tx-1', location: { coordinate: { lat: 25, lng: 121.5 } } }] } }));
  const artifacts: MarketDataManifest['artifacts'] = {};
  for (const file of ['raw/source.csv', 'doorplates-index.json', 'transactions-index.json']) {
    artifacts[file] = { sha256: await sha256File(join(root, file)), bytes: (await readFile(join(root, file))).byteLength };
  }
  const manifest: MarketDataManifest = {
    schemaVersion: MARKET_SCHEMA_VERSION,
    estimatorPolicyVersion: ESTIMATOR_POLICY_VERSION,
    buildId: 'known-good',
    builtAt: '2026-07-01T00:00:00.000Z',
    doorplates: { sourceUrl: 'https://example.test/d.csv', publishedAt: null, checkedAt: '2026-07-01T00:00:00.000Z', sha256: 'd', recordCount: 1 },
    transactions: {
      sourceUrls: [],
      publishedAt: null,
      checkedAt: '2026-07-01T00:00:00.000Z',
      sha256: 't',
      recordCount: 1,
      normalization: {
        rawRows: 1, reliableEligible: 1, reviewOnly: 0, excluded: 0, excludedByReason: {},
      },
    },
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

test('bootstrap skips an unpublished current season but publishes the completed seasons', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  const doorplateCsv = await readFile(fileURLToPath(new URL('./fixtures/doorplates.csv', import.meta.url)));
  const transactionCsv = await readFile(fileURLToPath(new URL('./fixtures/transactions.csv', import.meta.url)));
  const passingTransactionCsv = productionPassingTransactionCsv(transactionCsv);
  const nonDataOnlyCsv = Buffer.from(transactionCsv.toString('utf8').split('\n').slice(0, 2).join('\n'));
  const detail = '<a href="https://example.test/resource.download?rid=one&amp;fileName=doorplates.csv">doorplates.csv</a>';
  const events: string[] = [];
  let publishedAcceptanceChecksum: string | null = null;
  const bundle = await ensureTaipeiMarketData({
    asOf: '2026-07-25', rootPath, minDoorplates: 1, minTransactions: 1,
    fetch: async (input) => {
      const url = String(input);
      if (url.includes('dataset/detail')) return new Response(detail);
      if (url.includes('resource.download')) return new Response(doorplateCsv);
      return new Response('synthetic zip');
    },
    openZip: async (file) => {
      if (file.endsWith('/115S3.zip')) throw new Error('FILE_ENDED');
      return [{
        path: 'a_lvr_land_a.csv',
        stream: () => Readable.from(file.endsWith('/115S2.zip') ? passingTransactionCsv : nonDataOnlyCsv),
      }];
    },
    publisher: async (root, stage, acceptance, options) => {
      publishedAcceptanceChecksum = acceptance.transactionArtifactSha256;
      return publishStagedBuildWithAcceptance(root, stage, acceptance, options);
    },
    logger: { event: (_level, event) => events.push(event) },
  });

  assert.equal(bundle?.refresh?.status, 'updated');
  assert.equal(bundle?.backtestAcceptance?.transactionArtifactSha256, publishedAcceptanceChecksum);
  assert.equal(bundle?.manifest.transactionSources?.['115S3'], undefined);
  assert.equal(
    bundle?.manifest.transactions.sourceUrls.some((url) => url.includes('season=115S3')),
    false,
  );
  assert.deepEqual(events, [
    'market-data.check',
    'market-data.current-season-unavailable',
    'market-data.updated',
  ]);
});

test('candidate manifest records aggregate normalization diagnostics without row payloads', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  const doorplateCsv = await readFile(fileURLToPath(new URL('./fixtures/doorplates.csv', import.meta.url)));
  const transactionCsv = await readFile(fileURLToPath(new URL('./fixtures/transactions.csv', import.meta.url)));
  const passingTransactionCsv = productionPassingTransactionCsv(transactionCsv);
  const nonDataOnlyCsv = Buffer.from(transactionCsv.toString('utf8').split('\n').slice(0, 2).join('\n'));
  const detail = '<a href="https://example.test/resource.download?rid=one&amp;fileName=doorplates.csv">doorplates.csv</a>';
  const bundle = await ensureTaipeiMarketData({
    asOf: '2026-07-25', rootPath, minDoorplates: 1, minTransactions: 1,
    fetch: async (input) => String(input).includes('dataset/detail')
      ? new Response(detail)
      : String(input).includes('resource.download')
        ? new Response(doorplateCsv)
        : new Response('synthetic zip'),
    openZip: async (file) => [{
      path: 'a_lvr_land_a.csv',
      stream: () => Readable.from(file.endsWith('/115S2.zip') ? passingTransactionCsv : nonDataOnlyCsv),
    }],
  });

  assert.deepEqual(bundle?.manifest.transactions.normalization, {
    rawRows: 75,
    reliableEligible: 73,
    reviewOnly: 1,
    excluded: 1,
    excludedByReason: { 'non-residential-primary-use': 1 },
  });
});

test('candidate doorplate count does not materialize a flattened full-index copy', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-count-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  const doorplateCsv = await readFile(fileURLToPath(new URL('./fixtures/doorplates.csv', import.meta.url)));
  const transactionCsv = await readFile(fileURLToPath(new URL('./fixtures/transactions.csv', import.meta.url)));
  const passingTransactionCsv = productionPassingTransactionCsv(transactionCsv);
  const nonDataOnlyCsv = Buffer.from(transactionCsv.toString('utf8').split('\n').slice(0, 2).join('\n'));
  const detail = '<a href="https://example.test/resource.download?rid=one&amp;fileName=doorplates.csv">doorplates.csv</a>';
  const flatDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'flat');
  assert.ok(flatDescriptor);
  Object.defineProperty(Array.prototype, 'flat', {
    ...flatDescriptor,
    value: () => { throw new Error('full-index flat materialization is forbidden'); },
  });
  try {
    const bundle = await ensureTaipeiMarketData({
      asOf: '2026-07-25', rootPath, minDoorplates: 1, minTransactions: 1,
      fetch: async (input) => String(input).includes('dataset/detail')
        ? new Response(detail)
        : String(input).includes('resource.download')
          ? new Response(doorplateCsv)
          : new Response('synthetic zip'),
      openZip: async (file) => [{
        path: 'a_lvr_land_a.csv',
        stream: () => Readable.from(file.endsWith('/115S2.zip') ? passingTransactionCsv : nonDataOnlyCsv),
      }],
    });
    assert.equal(bundle?.refresh?.status, 'updated');
  } finally {
    Object.defineProperty(Array.prototype, 'flat', flatDescriptor);
  }
});

test('candidate gate failure retains the seeded active manifest and returns last-known-good', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  await seedValidBuild(rootPath);
  const activeManifest = await readFile(join(rootPath, 'manifest.json'), 'utf8');
  const doorplateCsv = await readFile(fileURLToPath(new URL('./fixtures/doorplates.csv', import.meta.url)));
  const transactionCsv = await readFile(fileURLToPath(new URL('./fixtures/transactions.csv', import.meta.url)));
  const detail = '<a href="https://example.test/resource.download?rid=one&amp;fileName=doorplates.csv">doorplates.csv</a>';
  const bundle = await ensureTaipeiMarketData({
    asOf: '2026-07-25', rootPath, minDoorplates: 1, minTransactions: 1,
    fetch: async (input) => String(input).includes('dataset/detail')
      ? new Response(detail)
      : String(input).includes('resource.download')
        ? new Response(doorplateCsv)
        : new Response('synthetic zip'),
    openZip: async () => [{ path: 'a_lvr_land_a.csv', stream: () => Readable.from(transactionCsv) }],
    gateEvaluator: () => { throw new Error('candidate backtest failed'); },
  });

  assert.equal(bundle?.refresh?.status, 'last-known-good');
  assert.match(bundle?.refresh?.failure ?? '', /candidate backtest failed/);
  assert.equal(await readFile(join(rootPath, 'manifest.json'), 'utf8'), activeManifest);
});

test('candidate gate failure without an active build returns null', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  const doorplateCsv = await readFile(fileURLToPath(new URL('./fixtures/doorplates.csv', import.meta.url)));
  const transactionCsv = await readFile(fileURLToPath(new URL('./fixtures/transactions.csv', import.meta.url)));
  const detail = '<a href="https://example.test/resource.download?rid=one&amp;fileName=doorplates.csv">doorplates.csv</a>';
  const bundle = await ensureTaipeiMarketData({
    asOf: '2026-07-25', rootPath, minDoorplates: 1, minTransactions: 1,
    fetch: async (input) => String(input).includes('dataset/detail')
      ? new Response(detail)
      : String(input).includes('resource.download')
        ? new Response(doorplateCsv)
        : new Response('synthetic zip'),
    openZip: async () => [{ path: 'a_lvr_land_a.csv', stream: () => Readable.from(transactionCsv) }],
    gateEvaluator: () => { throw new Error('candidate backtest failed'); },
  });

  assert.equal(bundle, null);
});

test('injected passing gate cannot publish a production-gate failure over an active build', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  await seedValidBuild(rootPath);
  const activeManifest = await readFile(join(rootPath, 'manifest.json'), 'utf8');
  const doorplateCsv = await readFile(fileURLToPath(new URL('./fixtures/doorplates.csv', import.meta.url)));
  const transactionCsv = await readFile(fileURLToPath(new URL('./fixtures/transactions.csv', import.meta.url)));
  const detail = '<a href="https://example.test/resource.download?rid=one&amp;fileName=doorplates.csv">doorplates.csv</a>';
  let publisherCalls = 0;
  const bundle = await ensureTaipeiMarketData({
    asOf: '2026-07-25', rootPath, minDoorplates: 1, minTransactions: 1,
    fetch: async (input) => String(input).includes('dataset/detail')
      ? new Response(detail)
      : String(input).includes('resource.download')
        ? new Response(doorplateCsv)
        : new Response('synthetic zip'),
    openZip: async () => [{ path: 'a_lvr_land_a.csv', stream: () => Readable.from(transactionCsv) }],
    gateEvaluator: () => PASSING_GATE,
    publisher: async () => {
      publisherCalls += 1;
      throw new Error('publisher must not run without acceptance');
    },
  });

  assert.equal(bundle?.refresh?.status, 'last-known-good');
  assert.match(bundle?.refresh?.failure ?? '', /candidate backtest failed|acceptance/i);
  assert.equal(publisherCalls, 0);
  assert.equal(await readFile(join(rootPath, 'manifest.json'), 'utf8'), activeManifest);
});

test('injected passing gate cannot bootstrap a production-gate failure without acceptance', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  const doorplateCsv = await readFile(fileURLToPath(new URL('./fixtures/doorplates.csv', import.meta.url)));
  const transactionCsv = await readFile(fileURLToPath(new URL('./fixtures/transactions.csv', import.meta.url)));
  const detail = '<a href="https://example.test/resource.download?rid=one&amp;fileName=doorplates.csv">doorplates.csv</a>';
  let publisherCalls = 0;
  const bundle = await ensureTaipeiMarketData({
    asOf: '2026-07-25', rootPath, minDoorplates: 1, minTransactions: 1,
    fetch: async (input) => String(input).includes('dataset/detail')
      ? new Response(detail)
      : String(input).includes('resource.download')
        ? new Response(doorplateCsv)
        : new Response('synthetic zip'),
    openZip: async () => [{ path: 'a_lvr_land_a.csv', stream: () => Readable.from(transactionCsv) }],
    gateEvaluator: () => PASSING_GATE,
    publisher: async () => {
      publisherCalls += 1;
      throw new Error('publisher must not run without acceptance');
    },
  });

  assert.equal(bundle, null);
  assert.equal(publisherCalls, 0);
});

test('unchanged schema-2 or old-provenance sources force current-semantic schema-3 publication', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-provenance-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  const doorplateCsv = await readFile(
    fileURLToPath(new URL('./fixtures/doorplates.csv', import.meta.url)),
  );
  const transactionCsv = await readFile(
    fileURLToPath(new URL('./fixtures/transactions.csv', import.meta.url)),
  );
  const passingTransactionCsv = productionPassingTransactionCsv(transactionCsv);
  const nonDataOnlyCsv = Buffer.from(
    transactionCsv.toString('utf8').split('\n').slice(0, 2).join('\n'),
  );
  const detail =
    '<a href="https://example.test/resource.download?rid=one&amp;fileName=doorplates.csv">doorplates.csv</a>';
  const fetchSameSources = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes('dataset/detail')) return new Response(detail);
    if (url.includes('resource.download')) {
      return new Response(doorplateCsv, { headers: { etag: '"doorplates"' } });
    }
    const season = new URL(url).searchParams.get('season');
    return new Response('synthetic zip', { headers: { etag: `"${season}"` } });
  };
  const openSameSources = async (file: string) => [{
    path: 'a_lvr_land_a.csv',
    stream: () => Readable.from(
      file.endsWith('/115S2.zip') ? passingTransactionCsv : nonDataOnlyCsv,
    ),
  }];

  const first = await ensureTaipeiMarketData({
    asOf: '2026-07-25',
    rootPath,
    minDoorplates: 1,
    minTransactions: 1,
    fetch: fetchSameSources,
    openZip: openSameSources,
    clock: () => new Date('2026-07-25T01:00:00.000Z'),
  });
  assert.equal(first?.refresh?.status, 'updated');
  const sourceChecksums = {
    doorplates: first!.manifest.doorplates.sha256,
    transactions: Object.fromEntries(
      Object.entries(first!.manifest.transactionSources ?? {})
        .map(([season, source]) => [season, source.sha256]),
    ),
  };

  for (const indexFile of ['doorplates-index.json', 'transactions-index.json']) {
    const index = JSON.parse(await readFile(join(rootPath, indexFile), 'utf8')) as {
      schemaVersion: number;
    };
    index.schemaVersion = 2;
    await writeFile(join(rootPath, indexFile), `${JSON.stringify(index)}\n`);
  }
  const legacyManifest = JSON.parse(
    await readFile(join(rootPath, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown> & {
    artifacts: MarketDataManifest['artifacts'];
  };
  legacyManifest.schemaVersion = 2;
  delete legacyManifest.estimatorPolicyVersion;
  for (const indexFile of ['doorplates-index.json', 'transactions-index.json']) {
    legacyManifest.artifacts[indexFile] = {
      sha256: await sha256File(join(rootPath, indexFile)),
      bytes: (await readFile(join(rootPath, indexFile))).byteLength,
    };
  }
  await writeFile(join(rootPath, 'manifest.json'), `${JSON.stringify(legacyManifest)}\n`);
  const legacyTransactionChecksum =
    legacyManifest.artifacts['transactions-index.json']!.sha256;
  const legacyAcceptance = JSON.parse(
    await readFile(backtestAcceptancePath(rootPath), 'utf8'),
  ) as { transactionArtifactSha256: string };
  legacyAcceptance.transactionArtifactSha256 = legacyTransactionChecksum;
  await writeFile(
    backtestAcceptancePath(rootPath),
    `${JSON.stringify(legacyAcceptance)}\n`,
  );

  let publisherCalls = 0;
  const migrated = await ensureTaipeiMarketData({
    asOf: '2026-07-25',
    rootPath,
    minDoorplates: 1,
    minTransactions: 1,
    fetch: fetchSameSources,
    openZip: openSameSources,
    clock: () => new Date('2026-07-26T01:00:00.000Z'),
    publisher: async (root, stage, acceptance, options) => {
      publisherCalls += 1;
      return publishStagedBuildWithAcceptance(root, stage, acceptance, options);
    },
  });

  assert.equal(migrated?.refresh?.status, 'updated');
  assert.equal(publisherCalls, 1);
  assert.equal(migrated?.manifest.schemaVersion, 3);
  assert.equal(
    (migrated?.manifest as unknown as { estimatorPolicyVersion?: number })
      .estimatorPolicyVersion,
    ESTIMATOR_POLICY_VERSION,
  );
  assert.notEqual(migrated?.manifest.buildId, first?.manifest.buildId);
  assert.notEqual(
    migrated?.manifest.artifacts['transactions-index.json']?.sha256,
    legacyTransactionChecksum,
  );
  assert.deepEqual({
    doorplates: migrated?.manifest.doorplates.sha256,
    transactions: Object.fromEntries(
      Object.entries(migrated?.manifest.transactionSources ?? {})
        .map(([season, source]) => [season, source.sha256]),
    ),
  }, sourceChecksums);
  assert.equal(
    migrated?.backtestAcceptance?.transactionArtifactSha256,
    migrated?.manifest.artifacts['transactions-index.json']?.sha256,
  );
  assert.equal(migrated?.backtestAcceptance?.schemaVersion, 2);
  assert.equal(migrated?.backtestAcceptance?.estimatorPolicyVersion, ESTIMATOR_POLICY_VERSION);
  assert.equal(marketDataBacktestAccepted(migrated!), true);

  const oldProvenanceManifest = JSON.parse(
    await readFile(join(rootPath, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  oldProvenanceManifest.estimatorPolicyVersion = ESTIMATOR_POLICY_VERSION - 1;
  await writeFile(
    join(rootPath, 'manifest.json'),
    `${JSON.stringify(oldProvenanceManifest)}\n`,
  );
  const rebuiltFromOldProvenance = await ensureTaipeiMarketData({
    asOf: '2026-07-25',
    rootPath,
    minDoorplates: 1,
    minTransactions: 1,
    fetch: fetchSameSources,
    openZip: openSameSources,
    clock: () => new Date('2026-07-27T01:00:00.000Z'),
    publisher: async (root, stage, acceptance, options) => {
      publisherCalls += 1;
      return publishStagedBuildWithAcceptance(root, stage, acceptance, options);
    },
  });

  assert.equal(rebuiltFromOldProvenance?.refresh?.status, 'updated');
  assert.equal(publisherCalls, 2);
  assert.notEqual(rebuiltFromOldProvenance?.manifest.buildId, migrated?.manifest.buildId);
  assert.equal(
    rebuiltFromOldProvenance?.manifest.estimatorPolicyVersion,
    ESTIMATOR_POLICY_VERSION,
  );
  assert.equal(rebuiltFromOldProvenance?.manifest.schemaVersion, 3);
  assert.equal(marketDataBacktestAccepted(rebuiltFromOldProvenance!), true);
});

test('unchanged conditional refresh skips an accepted build but rebuilds an invalid-policy build', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  const doorplateCsv = await readFile(fileURLToPath(new URL('./fixtures/doorplates.csv', import.meta.url)));
  const transactionCsv = await readFile(fileURLToPath(new URL('./fixtures/transactions.csv', import.meta.url)));
  const passingTransactionCsv = productionPassingTransactionCsv(transactionCsv);
  const nonDataOnlyCsv = Buffer.from(transactionCsv.toString('utf8').split('\n').slice(0, 2).join('\n'));
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
    openZip: async (file) => [{
      path: 'a_lvr_land_a.csv',
      stream: () => Readable.from(file.endsWith('/115S2.zip') ? passingTransactionCsv : nonDataOnlyCsv),
    }],
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

  const acceptancePath = backtestAcceptancePath(rootPath);
  const staleAcceptance = JSON.parse(await readFile(acceptancePath, 'utf8')) as {
    estimatorPolicyVersion: number;
  };
  staleAcceptance.estimatorPolicyVersion = 3;
  await writeFile(acceptancePath, `${JSON.stringify(staleAcceptance)}\n`);
  const rebuilt = await ensureTaipeiMarketData({
    asOf: '2026-07-25', rootPath, minDoorplates: 1, minTransactions: 1,
    fetch: fakeFetch, clock: () => new Date('2026-07-26T02:00:00.000Z'),
    openZip: async () => { throw new Error('conditionally unchanged ZIP must not be opened'); },
    logger: { event: (_level, event) => events.push(event) },
  });
  assert.equal(rebuilt?.refresh?.status, 'updated');
  assert.notEqual(rebuilt?.manifest.buildId, buildId);
  assert.notEqual(
    rebuilt?.manifest.artifacts['transactions-index.json']?.sha256,
    indexChecksums.transactions,
  );
  assert.equal(rebuilt?.backtestAcceptance?.estimatorPolicyVersion, ESTIMATOR_POLICY_VERSION);
  assert.equal(marketDataBacktestAccepted(rebuilt!), true);

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
