import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MARKET_SCHEMA_VERSION } from './config.ts';
import {
  loadMarketData,
  marketDataFreshness,
  publishStagedBuild,
  readManifest,
  sha256File,
  stableJson,
  transactionArtifactChecksum,
  writeBacktestAcceptance,
} from './store.ts';
import type { BacktestAcceptance, DoorplateIndex, MarketDataManifest, TransactionIndex } from './types.ts';

function manifest(buildId: string, recordCount = 1): MarketDataManifest {
  return {
    schemaVersion: MARKET_SCHEMA_VERSION,
    buildId,
    builtAt: '2026-07-25T00:00:00.000Z',
    doorplates: { sourceUrl: 'https://example.test/doorplates.csv', publishedAt: '2026-07-02T09:47:33+08:00', checkedAt: '2026-07-25T00:00:00.000Z', sha256: 'doorplates', recordCount },
    transactions: { sourceUrls: ['https://example.test/115S3.zip'], publishedAt: null, checkedAt: '2026-07-25T00:00:00.000Z', sha256: 'transactions', recordCount },
    lastFailure: null,
    artifacts: {},
  };
}

const doorplates: DoorplateIndex = {
  schemaVersion: MARKET_SCHEMA_VERSION,
  datasetVersion: 'doorplates',
  byCanonicalAddress: {}, byRoad: {},
  cells: { '5000:24300': [{ canonicalAddress: '台北市中正區測試路1號', coordinate: { lat: 25, lng: 121.5 }, district: '中正區', roadKey: '台北市中正區測試路', mainNumber: 1, subNumber: null }] },
};
const transactions: TransactionIndex = { schemaVersion: MARKET_SCHEMA_VERSION, datasetVersion: 'transactions', builtAt: '2026-07-25T00:00:00.000Z', cells: {} };

async function writeBuild(dir: string, buildId: string, count = 1): Promise<void> {
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'raw', 'doorplates.csv'), 'a,b\n1,2\n');
  await writeFile(join(dir, 'doorplates-index.json'), JSON.stringify(doorplates));
  await writeFile(join(dir, 'transactions-index.json'), JSON.stringify(transactions));
  const value = manifest(buildId, count);
  value.transactions.recordCount = 0;
  for (const file of ['raw/doorplates.csv', 'doorplates-index.json', 'transactions-index.json']) {
    value.artifacts[file] = { sha256: await sha256File(join(dir, file)), bytes: (await readFile(join(dir, file))).byteLength };
  }
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(value, null, 2)}\n`);
}

test('failed validation preserves last-known-good manifest and indexes', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const active = join(parent, 'taipei');
  const brokenStage = join(parent, '.taipei-staging-broken');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'good-build');
  await writeBuild(brokenStage, 'broken-build');
  await writeFile(join(brokenStage, 'doorplates-index.json'), '{"schemaVersion":999}');

  await assert.rejects(() => publishStagedBuild(active, brokenStage, { minDoorplates: 1, minTransactions: 0 }));
  assert.equal(readManifest(active)?.buildId, 'good-build');
  assert.equal((await loadMarketData(active, { minDoorplates: 1, minTransactions: 0 }))?.manifest.buildId, 'good-build');
});

test('publication verifies checksums and replaces a complete validated build atomically', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const active = join(parent, 'taipei');
  const stage = join(parent, '.taipei-staging-next');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'good-build');
  await writeBuild(stage, 'next-build');

  await publishStagedBuild(active, stage, { minDoorplates: 1, minTransactions: 0 });
  assert.equal(readManifest(active)?.buildId, 'next-build');
  await assert.rejects(() => readFile(stage));
});

test('load rejects unsorted cells, out-of-bounds points, and checksum drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'market-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeBuild(root, 'bad-build');
  const index = JSON.parse(await readFile(join(root, 'doorplates-index.json'), 'utf8')) as DoorplateIndex;
  index.cells = { z: index.cells['5000:24300'], a: [] };
  await writeFile(join(root, 'doorplates-index.json'), JSON.stringify(index));
  assert.equal(await loadMarketData(root), null);
});

test('load rejects a manifest count that does not equal its checked index', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'market-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeBuild(root, 'miscounted-build');
  const value = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as MarketDataManifest;
  value.doorplates.recordCount = 2;
  await writeFile(join(root, 'manifest.json'), JSON.stringify(value));
  assert.equal(await loadMarketData(root, { minDoorplates: 0, minTransactions: 0 }), null);
});

test('freshness marks independently stale source checks without changing the active build', () => {
  const value = manifest('good-build');
  value.doorplates.checkedAt = '2026-05-25T00:00:00.000Z';
  value.transactions.checkedAt = '2026-07-10T00:00:00.000Z';
  assert.deepEqual(marketDataFreshness(value, '2026-07-25T00:00:00.000Z'), {
    doorplateCheckedAt: '2026-05-25T00:00:00.000Z',
    transactionCheckedAt: '2026-07-10T00:00:00.000Z',
    doorplateStale: true,
    transactionStale: false,
  });
});

test('stable JSON uses code-unit key order for Han keys on every runtime locale', () => {
  assert.equal(stableJson({ 中: 2, 一: 1 }), '{"一":1,"中":2}');
});

test('backtest acceptance loads only for the active transaction artifact checksum', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const root = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'accepted-build');
  const checksum = transactionArtifactChecksum(readManifest(root)!);
  assert.ok(checksum);

  const acceptance: BacktestAcceptance = {
    schemaVersion: 1,
    transactionArtifactSha256: checksum,
    approvedAt: '2026-07-26T01:00:00.000Z',
    asOf: '2026-07-25',
    thresholds: {
      medianApeMax: 0.12,
      p75ApeMax: 0.20,
      minimumConfidenceSliceCases: 20,
      minimumHighConfidenceImprovement: 0.01,
    },
    metrics: {
      estimateCoverage: 0.8,
      medianApe: 0.08,
      p75Ape: 0.16,
      highConfidenceEstimatedCount: 20,
      highConfidenceMedianApe: 0.07,
      mediumConfidenceEstimatedCount: 20,
      mediumConfidenceMedianApe: 0.09,
    },
  };
  await writeBacktestAcceptance(root, acceptance);
  assert.equal(
    (await loadMarketData(root, { minDoorplates: 1, minTransactions: 0 }))?.backtestAcceptance?.transactionArtifactSha256,
    checksum,
  );

  await assert.rejects(
    () => writeBacktestAcceptance(root, {
      ...acceptance,
      thresholds: { ...acceptance.thresholds, medianApeMax: 0.50 },
    }),
    /approved quality thresholds/,
  );
  await writeBacktestAcceptance(root, { ...acceptance, transactionArtifactSha256: 'different-dataset' });
  assert.equal(
    (await loadMarketData(root, { minDoorplates: 1, minTransactions: 0 }))?.backtestAcceptance,
    undefined,
  );
});
