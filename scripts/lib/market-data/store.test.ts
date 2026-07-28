import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ACTIVE_ESTIMATOR_POLICY,
  ESTIMATOR_POLICY_VERSION,
  MARKET_SCHEMA_VERSION,
} from './config.ts';
import {
  backtestAcceptancePath,
  loadMarketData,
  marketDataFreshness,
  publishStagedBuild,
  readBacktestAcceptance,
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
    transactions: {
      sourceUrls: ['https://example.test/115S3.zip'],
      publishedAt: null,
      checkedAt: '2026-07-25T00:00:00.000Z',
      sha256: 'transactions',
      recordCount,
      normalization: {
        rawRows: recordCount,
        reliableEligible: recordCount,
        reviewOnly: 0,
        excluded: 0,
        excludedByReason: {},
      },
    },
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
const transaction = {
  id: 'tx-1',
  transactionDate: '2025-12-01',
  sourceVersion: 'transactions',
  originalAddress: '台北市中正區測試路1號',
  location: {
    method: 'exact-doorplate' as const,
    coordinate: { lat: 25, lng: 121.5 },
    normalizedAddress: '台北市中正區測試路1號',
    matchedAddress: '台北市中正區測試路1號',
    uncertaintyMeters: 0,
    confidence: 'high' as const,
    datasetVersion: 'doorplates',
  },
  district: '中正區',
  ownership: 'freehold' as const,
  buildingType: 'apartment' as const,
  totalPriceNtd: 30_000_000,
  buildingPriceNtd: 30_000_000,
  buildingAreaPing: 30,
  parkingPriceNtd: 0,
  parkingAreaPing: 0,
  buildingUnitPriceWan: 100,
  floor: 3,
  totalFloors: 5,
  floorGroup: 'middle' as const,
  completionDate: null,
  notes: '',
  exclusionFlags: [],
  eligibility: 'reliable-eligible' as const,
  eligibilityReasons: [],
  primaryUse: 'residential' as const,
  transferredBuildingCount: 1,
};
const transactions: TransactionIndex = {
  schemaVersion: MARKET_SCHEMA_VERSION,
  datasetVersion: 'transactions',
  builtAt: '2026-07-25T00:00:00.000Z',
  cells: { '5000:24300': [transaction] },
};

async function writeBuild(dir: string, buildId: string, count = 1): Promise<void> {
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'raw', 'doorplates.csv'), 'a,b\n1,2\n');
  await writeFile(join(dir, 'doorplates-index.json'), JSON.stringify(doorplates));
  await writeFile(join(dir, 'transactions-index.json'), JSON.stringify(transactions));
  const value = manifest(buildId, count);
  value.transactions.recordCount = Object.values(transactions.cells).flat().length;
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

test('load rejects inconsistent or unstably ordered normalization diagnostics', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const inconsistent = join(parent, 'inconsistent');
  await writeBuild(inconsistent, 'inconsistent-diagnostics');
  const inconsistentManifest = JSON.parse(
    await readFile(join(inconsistent, 'manifest.json'), 'utf8'),
  ) as MarketDataManifest;
  inconsistentManifest.transactions.normalization.rawRows = 99;
  await writeFile(join(inconsistent, 'manifest.json'), JSON.stringify(inconsistentManifest));
  assert.equal(await loadMarketData(inconsistent, { minDoorplates: 0, minTransactions: 0 }), null);

  const unsorted = join(parent, 'unsorted');
  await writeBuild(unsorted, 'unsorted-diagnostics');
  const unsortedManifest = JSON.parse(
    await readFile(join(unsorted, 'manifest.json'), 'utf8'),
  ) as MarketDataManifest;
  unsortedManifest.transactions.normalization = {
    rawRows: 3,
    reliableEligible: 1,
    reviewOnly: 0,
    excluded: 2,
    excludedByReason: { zeta: 1, alpha: 1 },
  };
  await writeFile(join(unsorted, 'manifest.json'), JSON.stringify(unsortedManifest));
  assert.equal(await loadMarketData(unsorted, { minDoorplates: 0, minTransactions: 0 }), null);

  const zeroExcludedWithReason = join(parent, 'zero-excluded-with-reason');
  await writeBuild(zeroExcludedWithReason, 'zero-excluded-with-reason');
  const zeroExcludedManifest = JSON.parse(
    await readFile(join(zeroExcludedWithReason, 'manifest.json'), 'utf8'),
  ) as MarketDataManifest;
  zeroExcludedManifest.transactions.normalization.excludedByReason = { bogus: 99 };
  await writeFile(
    join(zeroExcludedWithReason, 'manifest.json'),
    JSON.stringify(zeroExcludedManifest),
  );
  assert.equal(
    await loadMarketData(zeroExcludedWithReason, { minDoorplates: 0, minTransactions: 0 }),
    null,
  );

  const inconsistentReasons = join(parent, 'inconsistent-reasons');
  await writeBuild(inconsistentReasons, 'inconsistent-reasons');
  const inconsistentReasonsManifest = JSON.parse(
    await readFile(join(inconsistentReasons, 'manifest.json'), 'utf8'),
  ) as MarketDataManifest;
  inconsistentReasonsManifest.transactions.normalization = {
    rawRows: 3,
    reliableEligible: 1,
    reviewOnly: 0,
    excluded: 2,
    excludedByReason: { alpha: 1 },
  };
  await writeFile(
    join(inconsistentReasons, 'manifest.json'),
    JSON.stringify(inconsistentReasonsManifest),
  );
  assert.equal(
    await loadMarketData(inconsistentReasons, { minDoorplates: 0, minTransactions: 0 }),
    null,
  );

  const valid = join(parent, 'valid');
  await writeBuild(valid, 'valid-diagnostics');
  const validManifest = JSON.parse(
    await readFile(join(valid, 'manifest.json'), 'utf8'),
  ) as MarketDataManifest;
  validManifest.transactions.normalization = {
    rawRows: 3,
    reliableEligible: 1,
    reviewOnly: 0,
    excluded: 2,
    excludedByReason: { alpha: 1, zeta: 1 },
  };
  await writeFile(join(valid, 'manifest.json'), JSON.stringify(validManifest));
  assert.equal(
    (await loadMarketData(valid, { minDoorplates: 0, minTransactions: 0 }))?.manifest.buildId,
    'valid-diagnostics',
  );
});

test('external diagnostics leave the active build valid while undeclared internal files fail closed', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const active = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'closed-build');

  const diagnostics = join(parent, 'backtests', 'taipei');
  await mkdir(diagnostics, { recursive: true });
  await writeFile(join(diagnostics, '2026-07-26.json'), '{}\n');
  assert.equal(
    (await loadMarketData(active, { minDoorplates: 1, minTransactions: 0 }))?.manifest.buildId,
    'closed-build',
  );

  const undeclared = join(active, 'backtests');
  await mkdir(undeclared, { recursive: true });
  await writeFile(join(undeclared, '2026-07-26.json'), '{}\n');
  assert.equal(await loadMarketData(active, { minDoorplates: 1, minTransactions: 0 }), null);
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

test('reader retries the bounded active-directory rename window and still validates the build', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const active = join(parent, 'taipei');
  const backup = join(parent, '.taipei-backup-reader-window');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'reader-build');
  await rename(active, backup);
  const restore = new Promise<void>((resolve, reject) => {
    setTimeout(() => { void rename(backup, active).then(resolve, reject); }, 15);
  });
  const bundle = await loadMarketData(active, {
    minDoorplates: 1, minTransactions: 0,
    readerRetries: 5, readerRetryDelayMs: 10,
  });
  await restore;
  assert.equal(bundle?.manifest.buildId, 'reader-build');
});

test('backtest acceptance loads only for the active transaction artifact checksum', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const root = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'accepted-build');
  const checksum = transactionArtifactChecksum(readManifest(root)!);
  assert.ok(checksum);

  const acceptance: BacktestAcceptance = {
    schemaVersion: 2,
    estimatorPolicyVersion: ESTIMATOR_POLICY_VERSION,
    policyId: ACTIVE_ESTIMATOR_POLICY.id,
    transactionArtifactSha256: checksum,
    approvedAt: '2026-07-26T01:00:00.000Z',
    asOf: '2026-07-25',
    evaluatedThrough: '2026-07-25',
    latestEligibleTransactionDate: '2025-12-01',
    thresholds: {
      medianApeMax: 0.12,
      p75ApeMax: 0.20,
      minimumEstimateCoverage: 0.70,
      minimumConfidenceSliceCases: 20,
      minimumHighConfidenceImprovement: 0.01,
    },
    metrics: {
      estimateCoverage: 0.8,
      reliableEstimatedCount: 20,
      reliableMedianApe: 0.08,
      reliableP75Ape: 0.16,
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
  await assert.rejects(
    () => writeBacktestAcceptance(root, {
      ...acceptance,
      estimatorPolicyVersion: ESTIMATOR_POLICY_VERSION + 1,
    }),
    /estimator policy/,
  );
  await assert.rejects(
    () => writeBacktestAcceptance(root, {
      ...acceptance,
      policyId: '48-month',
    }),
    /active estimator policy/,
  );
  await assert.rejects(
    () => writeBacktestAcceptance(root, {
      ...acceptance,
      evaluatedThrough: '2025-11-30',
    }),
    /complete active transaction index/,
  );
  await assert.rejects(
    () => writeBacktestAcceptance(root, {
      ...acceptance,
      latestEligibleTransactionDate: '2025-11-30',
    }),
    /complete active transaction index/,
  );
  await assert.rejects(
    () => writeBacktestAcceptance(root, {
      ...acceptance,
      asOf: '2026-02-30',
      evaluatedThrough: '2026-02-30',
    }),
    /non-passing backtest acceptance/,
  );
  for (const invalid of [
    { ...acceptance, schemaVersion: 1 },
    { ...acceptance, estimatorPolicyVersion: 2 },
    { ...acceptance, policyId: '48-month' },
    { ...acceptance, asOf: '2026-02-30', evaluatedThrough: '2026-02-30' },
    { ...acceptance, latestEligibleTransactionDate: '2026-02-30' },
  ]) {
    await writeFile(backtestAcceptancePath(root), JSON.stringify(invalid));
    assert.equal(readBacktestAcceptance(root), null);
  }
  await writeBacktestAcceptance(root, { ...acceptance, transactionArtifactSha256: 'different-dataset' });
  assert.equal(
    (await loadMarketData(root, { minDoorplates: 1, minTransactions: 0 }))?.backtestAcceptance,
    undefined,
  );
});
