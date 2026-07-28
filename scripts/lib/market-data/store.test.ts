import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runMarketDataCommand } from '../../market-data.ts';
import {
  ACTIVE_ESTIMATOR_POLICY,
  ESTIMATOR_POLICY_VERSION,
  MARKET_SCHEMA_VERSION,
} from './config.ts';
import {
  backtestAcceptancePath,
  loadMarketData,
  marketDataBacktestAccepted,
  marketDataFreshness,
  publishStagedBuild,
  publishStagedBuildWithAcceptance,
  readBacktestAcceptance,
  readManifest,
  recoverInterruptedMarketDataPublication,
  sha256File,
  stableJson,
  transactionArtifactChecksum,
  writeBacktestAcceptance,
} from './store.ts';
import { ensureTaipeiMarketData } from './update.ts';
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
  await writeFile(join(dir, 'transactions-index.json'), JSON.stringify({
    ...transactions,
    datasetVersion: `transactions-${buildId}`,
    cells: {
      '5000:24300': [{
        ...transaction,
        id: `tx-${buildId}`,
        sourceVersion: `transactions-${buildId}`,
      }],
    },
  }));
  const value = manifest(buildId, count);
  value.transactions.recordCount = Object.values(transactions.cells).flat().length;
  for (const file of ['raw/doorplates.csv', 'doorplates-index.json', 'transactions-index.json']) {
    value.artifacts[file] = { sha256: await sha256File(join(dir, file)), bytes: (await readFile(join(dir, file))).byteLength };
  }
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(value, null, 2)}\n`);
}

async function passingAcceptance(root: string): Promise<BacktestAcceptance> {
  const checksum = transactionArtifactChecksum(readManifest(root)!);
  assert.ok(checksum);
  return {
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
}

async function crashPublicationAfterRename(
  active: string,
  stage: string,
  acceptance: BacktestAcceptance,
  checkpoint: 1 | 2 | 3,
): Promise<void> {
  const storeUrl = new URL('./store.ts', import.meta.url).href;
  const script = `
    import { rename } from 'node:fs/promises';
    import { publishStagedBuildWithAcceptance } from ${JSON.stringify(storeUrl)};
    const [active, stage, acceptanceJson, checkpointText] = process.argv.slice(1);
    let completedRenames = 0;
    await publishStagedBuildWithAcceptance(active, stage, JSON.parse(acceptanceJson), {
      minDoorplates: 1,
      minTransactions: 0,
      publicationFileOps: {
        rename: async (from, to) => {
          await rename(from, to);
          completedRenames += 1;
          if (completedRenames === Number(checkpointText)) process.exit(86);
        },
      },
    });
  `;
  const child = spawn(process.execPath, [
    '--import', 'tsx',
    '--input-type=module',
    '--eval', script,
    active,
    stage,
    JSON.stringify(acceptance),
    String(checkpoint),
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exitCode, 86, stderr);
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

test('transactional publication loads the new build with its matching acceptance', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const active = join(parent, 'taipei');
  const stage = join(parent, '.taipei-staging-next');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'good-build');
  await writeBuild(stage, 'next-build');
  const acceptance = await passingAcceptance(stage);

  const published = await publishStagedBuildWithAcceptance(active, stage, acceptance, {
    minDoorplates: 1,
    minTransactions: 0,
  });
  const loaded = await loadMarketData(active, { minDoorplates: 1, minTransactions: 0 });

  assert.equal(published.manifest.buildId, 'next-build');
  assert.equal(published.backtestAcceptance?.transactionArtifactSha256, acceptance.transactionArtifactSha256);
  assert.equal(loaded?.manifest.buildId, 'next-build');
  assert.equal(loaded?.backtestAcceptance?.transactionArtifactSha256, acceptance.transactionArtifactSha256);
  assert.equal(marketDataBacktestAccepted(loaded!), true);
});

test('acceptance publication failure restores the old build and acceptance pair', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const active = join(parent, 'taipei');
  const stage = join(parent, '.taipei-staging-next');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'good-build');
  const oldAcceptance = await passingAcceptance(active);
  await writeBacktestAcceptance(active, oldAcceptance);
  const oldAcceptanceBytes = await readFile(backtestAcceptancePath(active));
  await writeBuild(stage, 'next-build');
  const nextAcceptance = await passingAcceptance(stage);
  const acceptancePath = backtestAcceptancePath(active);

  await assert.rejects(
    () => publishStagedBuildWithAcceptance(active, stage, nextAcceptance, {
      minDoorplates: 1,
      minTransactions: 0,
      publicationFileOps: {
        rename: async (from, to) => {
          if (to === acceptancePath && from !== stage) {
            throw new Error('injected acceptance publication failure');
          }
          await rename(from, to);
        },
      },
    }),
    /injected acceptance publication failure/,
  );

  const restored = await loadMarketData(active, { minDoorplates: 1, minTransactions: 0 });
  assert.equal(restored?.manifest.buildId, 'good-build');
  assert.equal(restored?.backtestAcceptance?.transactionArtifactSha256, oldAcceptance.transactionArtifactSha256);
  assert.deepEqual(await readFile(acceptancePath), oldAcceptanceBytes);
  assert.equal(marketDataBacktestAccepted(restored!), true);
});

test('acceptance publication failure restores an absent old acceptance', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const active = join(parent, 'taipei');
  const stage = join(parent, '.taipei-staging-next');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'good-build');
  await writeBuild(stage, 'next-build');
  const acceptancePath = backtestAcceptancePath(active);

  await assert.rejects(
    async () => publishStagedBuildWithAcceptance(active, stage, await passingAcceptance(stage), {
      minDoorplates: 1,
      minTransactions: 0,
      publicationFileOps: {
        rename: async (from, to) => {
          if (to === acceptancePath && from !== stage) {
            throw new Error('injected acceptance publication failure');
          }
          await rename(from, to);
        },
      },
    }),
    /injected acceptance publication failure/,
  );

  const restored = await loadMarketData(active, { minDoorplates: 1, minTransactions: 0 });
  assert.equal(restored?.manifest.buildId, 'good-build');
  assert.equal(restored?.backtestAcceptance, undefined);
  await assert.rejects(() => readFile(acceptancePath), { code: 'ENOENT' });
});

test('transaction checksum mismatch is rejected before any publication rename', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const active = join(parent, 'taipei');
  const stage = join(parent, '.taipei-staging-next');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'good-build');
  await writeBuild(stage, 'next-build');
  const acceptance = {
    ...await passingAcceptance(stage),
    transactionArtifactSha256: 'wrong-transaction-checksum',
  };

  await assert.rejects(
    () => publishStagedBuildWithAcceptance(active, stage, acceptance, {
      minDoorplates: 1,
      minTransactions: 0,
      publicationFileOps: {
        rename: async () => { throw new Error('publication renamed before checksum validation'); },
      },
    }),
    /transaction.*checksum/i,
  );

  assert.equal(readManifest(active)?.buildId, 'good-build');
  assert.equal(readManifest(stage)?.buildId, 'next-build');
});

test('reader in the build-to-acceptance rename window sees a review-only mismatch', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const active = join(parent, 'taipei');
  const stage = join(parent, '.taipei-staging-next');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'good-build');
  await writeBacktestAcceptance(active, await passingAcceptance(active));
  await writeBuild(stage, 'next-build');
  const nextAcceptance = await passingAcceptance(stage);
  let observed: Awaited<ReturnType<typeof loadMarketData>> | undefined;

  await publishStagedBuildWithAcceptance(active, stage, nextAcceptance, {
    minDoorplates: 1,
    minTransactions: 0,
    publicationFileOps: {
      rename: async (from, to) => {
        await rename(from, to);
        if (from === stage && to === active) {
          observed = await loadMarketData(active, {
            minDoorplates: 1,
            minTransactions: 0,
            readerRetries: 0,
          });
        }
      },
    },
  });

  assert.equal(observed?.manifest.buildId, 'next-build');
  assert.equal(observed?.backtestAcceptance, undefined);
  assert.equal(marketDataBacktestAccepted(observed!), false);
});

test('successful transactional publication removes candidate and backup paths', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const active = join(parent, 'taipei');
  const stage = join(parent, '.taipei-staging-next');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'good-build');
  await writeBacktestAcceptance(active, await passingAcceptance(active));
  await writeBuild(stage, 'next-build');

  await publishStagedBuildWithAcceptance(active, stage, await passingAcceptance(stage), {
    minDoorplates: 1,
    minTransactions: 0,
  });

  assert.deepEqual(
    (await readdir(parent)).sort(),
    ['taipei', 'taipei-backtest-acceptance.json'],
  );
});

test('backup cleanup failure preserves the committed new accepted pair', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const active = join(parent, 'taipei');
  const stage = join(parent, '.taipei-staging-next');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'good-build');
  await writeBacktestAcceptance(active, await passingAcceptance(active));
  await writeBuild(stage, 'next-build');

  const published = await publishStagedBuildWithAcceptance(
    active,
    stage,
    await passingAcceptance(stage),
    {
      minDoorplates: 1,
      minTransactions: 0,
      publicationFileOps: {
        rm: async (file, options) => {
          if (file.includes('.taipei-backup-')) throw new Error('injected backup cleanup failure');
          await rm(file, options);
        },
      },
    },
  );

  const loaded = await loadMarketData(active, { minDoorplates: 1, minTransactions: 0 });
  assert.equal(published.manifest.buildId, 'next-build');
  assert.equal(loaded?.manifest.buildId, 'next-build');
  assert.equal(marketDataBacktestAccepted(loaded!), true);
  assert.equal((await readdir(parent)).some((entry) => entry.startsWith('.taipei-backup-')), true);
});

test('restart recovery yields a validated old or new pair after every publication rename', async (t) => {
  for (const checkpoint of [1, 2, 3] as const) {
    await t.test(`rename checkpoint ${checkpoint}`, async (t) => {
      const parent = await mkdtemp(join(tmpdir(), 'market-store-crash-'));
      const active = join(parent, 'taipei');
      const stage = join(parent, '.taipei-staging-next');
      t.after(() => rm(parent, { recursive: true, force: true }));
      await writeBuild(active, 'good-build');
      await writeBacktestAcceptance(active, await passingAcceptance(active));
      await writeBuild(stage, 'next-build');

      await crashPublicationAfterRename(active, stage, await passingAcceptance(stage), checkpoint);
      const recovered = await ensureTaipeiMarketData({
        asOf: '2026-07-25',
        rootPath: active,
        minDoorplates: 1,
        minTransactions: 0,
        fetch: async () => { throw new Error('offline after restart'); },
      });

      const expectedBuildId = checkpoint === 1 ? 'good-build' : 'next-build';
      assert.equal(recovered?.manifest.buildId, expectedBuildId);
      assert.equal(marketDataBacktestAccepted(recovered!), true);
      assert.deepEqual(
        (await readdir(parent)).sort(),
        ['taipei', 'taipei-backtest-acceptance.json'],
      );
    });
  }
});

test('production backtest recovers an interrupted publication before its locked load', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-backtest-crash-'));
  const active = join(parent, 'taipei');
  const stage = join(parent, '.taipei-staging-next');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'good-build');
  await writeBacktestAcceptance(active, await passingAcceptance(active));
  await writeBuild(stage, 'next-build');
  await crashPublicationAfterRename(active, stage, await passingAcceptance(stage), 1);

  const exitCode = await runMarketDataCommand(
    ['backtest', '--city', 'taipei', '--as-of', '2026-07-25'],
    new Date('2026-07-26T01:00:00.000Z'),
    {
      backtest: {
        root: active,
        recover: (root) => recoverInterruptedMarketDataPublication(root, {
          minDoorplates: 1,
          minTransactions: 0,
        }),
        load: (root) => loadMarketData(root, {
          minDoorplates: 1,
          minTransactions: 0,
        }),
      },
    },
  );
  const recovered = await loadMarketData(active, { minDoorplates: 1, minTransactions: 0 });

  assert.equal(exitCode, 1);
  assert.equal(recovered?.manifest.buildId, 'good-build');
  assert.equal(marketDataBacktestAccepted(recovered!), true);
});

test('recovery rejects malformed journal phase, id, and stage basename before network work', async (t) => {
  const malformed = [
    { phase: 'unknown' },
    { publicationId: '../escape' },
    { stageBasename: '../outside-stage' },
  ];
  for (const [index, override] of malformed.entries()) {
    await t.test(`malformed journal ${index + 1}`, async (t) => {
      const parent = await mkdtemp(join(tmpdir(), 'market-store-journal-'));
      const active = join(parent, 'taipei');
      const sentinel = join(parent, 'outside-stage');
      const journal = join(parent, '.taipei-publication-journal.json');
      t.after(() => rm(parent, { recursive: true, force: true }));
      await writeBuild(active, 'good-build');
      await writeBacktestAcceptance(active, await passingAcceptance(active));
      await writeFile(sentinel, 'do not touch');
      await writeFile(journal, JSON.stringify({
        schemaVersion: 1,
        phase: 'prepared',
        publicationId: '11111111-1111-4111-8111-111111111111',
        activeBasename: 'taipei',
        stageBasename: '.taipei-staging-next',
        stagedBuildId: 'next-build',
        oldBuildId: 'good-build',
        oldAcceptancePresent: true,
        candidateAcceptanceSha256: '0'.repeat(64),
        oldAcceptanceSha256: '1'.repeat(64),
        ...override,
      }));
      let fetchCalls = 0;

      const retained = await ensureTaipeiMarketData({
        asOf: '2026-07-25',
        rootPath: active,
        minDoorplates: 1,
        minTransactions: 0,
        fetch: async () => {
          fetchCalls += 1;
          throw new Error('network must not run before journal validation');
        },
      });

      assert.equal(fetchCalls, 0);
      assert.equal(retained?.manifest.buildId, 'good-build');
      assert.match(retained?.refresh?.failure ?? '', /publication journal/i);
      assert.equal(await readFile(sentinel, 'utf8'), 'do not touch');
    });
  }
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

test('validated index counts do not materialize flattened cell copies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'market-store-count-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeBuild(root, 'counted-build');
  const flatDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'flat');
  assert.ok(flatDescriptor);
  Object.defineProperty(Array.prototype, 'flat', {
    ...flatDescriptor,
    value: () => { throw new Error('full-index flat materialization is forbidden'); },
  });
  try {
    const loaded = await loadMarketData(root, { minDoorplates: 1, minTransactions: 0 });
    assert.equal(loaded?.manifest.buildId, 'counted-build');
  } finally {
    Object.defineProperty(Array.prototype, 'flat', flatDescriptor);
  }
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

  const acceptance = await passingAcceptance(root);
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

test('prior policy-v3 acceptance fails closed after location eligibility changes', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  const root = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'policy-v4-build');
  const priorAcceptance = {
    ...await passingAcceptance(root),
    estimatorPolicyVersion: 3,
  };

  await writeFile(backtestAcceptancePath(root), JSON.stringify(priorAcceptance));

  assert.equal(readBacktestAcceptance(root), null);
  assert.equal(
    (await loadMarketData(root, { minDoorplates: 1, minTransactions: 0 }))?.backtestAcceptance,
    undefined,
  );
});
