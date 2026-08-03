import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runMarketDataCommand } from '../../market-data.ts';
import {
  ACTIVE_ESTIMATOR_POLICY,
  CANDIDATE_ESTIMATOR_POLICY_VERSION,
  CANDIDATE_MARKET_SCHEMA_VERSION,
  ESTIMATOR_POLICY_VERSION,
  MARKET_SCHEMA_VERSION,
  PARKING_BACKTEST_GATE,
  SCENARIO_BACKTEST_GATE,
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
  validBacktestAcceptance,
  validCandidateBacktestAcceptance,
  validateCandidateStagedBuild,
  writeBacktestAcceptance,
} from './store.ts';
import { ensureTaipeiMarketData } from './update.ts';
import type {
  BacktestAcceptance,
  CandidateBacktestAcceptance,
  DoorplateIndex,
  LegacyBacktestAcceptance,
  MarketDataManifest,
  MarketTransaction,
  ScenarioBacktestAcceptance,
  TransactionIndex,
} from './types.ts';

function manifest(buildId: string, recordCount = 1): MarketDataManifest {
  return {
    schemaVersion: MARKET_SCHEMA_VERSION,
    estimatorPolicyVersion: ESTIMATOR_POLICY_VERSION,
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
        byPrimaryUse: { commercial: 0, industrial: 0, 'mixed-industrial': 0, 'mixed-residential': 0, office: 0, residential: recordCount, unknown: 0 },
        byParkingGrade: { A: recordCount, B: 0, C: 0 },
        gradeBByComponent: { missingBoth: 0, officialAreaOnly: 0, officialPriceOnly: 0 },
        gradeBImputed: 0,
        gradeBUnresolved: 0,
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
  totalAreaPing: 30,
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
  originalPrimaryUse: '住家用',
  primaryUse: 'residential' as const,
  transferredBuildingCount: 1,
  transferredParkingCount: 0,
  buildingUnitPriceBoundsWan: null,
  parkingEvidence: {
    grade: 'A' as const, family: 'none' as const, originalType: '無車位',
    officialPriceNtd: 0, officialAreaPing: 0, imputation: null, reasons: [],
  },
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

async function rewriteTransactionIndexChecksum(root: string, index: TransactionIndex): Promise<void> {
  const indexPath = join(root, 'transactions-index.json');
  await writeFile(indexPath, JSON.stringify(index));
  const value = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as MarketDataManifest;
  value.artifacts['transactions-index.json'] = {
    sha256: await sha256File(indexPath),
    bytes: (await readFile(indexPath)).byteLength,
  };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(value));
}

function consistentGradeBTransaction(): MarketTransaction {
  return {
    ...transaction,
    id: 'grade-b-consistent',
    transferredParkingCount: 1,
    parkingPriceNtd: 2_000_000,
    parkingAreaPing: 5,
    buildingPriceNtd: 28_000_000,
    buildingAreaPing: 25,
    buildingUnitPriceWan: 112,
    buildingUnitPriceBoundsWan: {
      p25: 100,
      p50: 112,
      p75: 120,
      relativeIqrRatio: 20 / 112,
    },
    parkingEvidence: {
      grade: 'B', family: 'flat', originalType: '坡道平面',
      officialPriceNtd: null, officialAreaPing: null, reasons: ['parking-components-incomplete'],
      imputation: {
        asOf: '2025-12-01', stage: 'same-building',
        comparableIds: ['a', 'b', 'c'], comparableCount: 3,
        priceP25Ntd: 1_000_000, priceP50Ntd: 2_000_000, priceP75Ntd: 3_000_000,
        areaP25Ping: 4, areaP50Ping: 5, areaP75Ping: 6,
        pairP25: { priceNtd: 1_200_000, areaPing: 4.2 },
        pairP50: { priceNtd: 2_000_000, areaPing: 5 },
        pairP75: { priceNtd: 2_800_000, areaPing: 5.8 },
        priceIqrRatio: 1,
        areaIqrRatio: 0.4,
      },
    },
  };
}

async function downgradeBuildToLegacySchema(
  root: string,
  schemaVersion: 1 | 2 | 3 | 4,
  schema2Normalization: 'absent' | 'legacy-five' = 'legacy-five',
): Promise<void> {
  for (const indexFile of ['doorplates-index.json', 'transactions-index.json']) {
    const index = JSON.parse(await readFile(join(root, indexFile), 'utf8')) as {
      schemaVersion: number;
    };
    index.schemaVersion = schemaVersion;
    await writeFile(join(root, indexFile), `${JSON.stringify(index)}\n`);
  }
  const legacyManifest = JSON.parse(
    await readFile(join(root, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown> & {
    artifacts: MarketDataManifest['artifacts'];
    transactions: Record<string, unknown>;
  };
  legacyManifest.schemaVersion = schemaVersion;
  if (schemaVersion <= 2) delete legacyManifest.estimatorPolicyVersion;
  else legacyManifest.estimatorPolicyVersion = schemaVersion === 3 ? 4 : 5;
  if (schemaVersion === 1
      || (schemaVersion === 2 && schema2Normalization === 'absent')) {
    delete legacyManifest.transactions.normalization;
  } else if (schemaVersion <= 3) {
    const current = legacyManifest.transactions.normalization as Record<string, unknown>;
    legacyManifest.transactions.normalization = {
      rawRows: current.rawRows,
      reliableEligible: current.reliableEligible,
      reviewOnly: current.reviewOnly,
      excluded: current.excluded,
      excludedByReason: current.excludedByReason,
    };
  } else {
    const current = legacyManifest.transactions.normalization as Record<string, unknown>;
    const { gradeBByComponent: _gradeBByComponent, ...schema4 } = current;
    legacyManifest.transactions.normalization = schema4;
  }
  for (const indexFile of ['doorplates-index.json', 'transactions-index.json']) {
    legacyManifest.artifacts[indexFile] = {
      sha256: await sha256File(join(root, indexFile)),
      bytes: (await readFile(join(root, indexFile))).byteLength,
    };
  }
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(legacyManifest)}\n`);
}

async function convertBuildToCandidate(root: string): Promise<void> {
  for (const indexFile of ['doorplates-index.json', 'transactions-index.json']) {
    const index = JSON.parse(await readFile(join(root, indexFile), 'utf8')) as {
      schemaVersion: number;
    };
    index.schemaVersion = CANDIDATE_MARKET_SCHEMA_VERSION;
    await writeFile(join(root, indexFile), `${JSON.stringify(index)}\n`);
  }
  const candidateManifest = JSON.parse(
    await readFile(join(root, 'manifest.json'), 'utf8'),
  ) as MarketDataManifest;
  candidateManifest.schemaVersion = CANDIDATE_MARKET_SCHEMA_VERSION;
  candidateManifest.estimatorPolicyVersion = CANDIDATE_ESTIMATOR_POLICY_VERSION;
  candidateManifest.transactions.normalization = {
    rawRows: candidateManifest.transactions.recordCount,
    reliableEligible: candidateManifest.transactions.recordCount,
    reviewOnly: 0,
    excluded: 0,
    excludedByReason: {},
    byPrimaryUse: {
      commercial: 0,
      industrial: 0,
      'mixed-industrial': 0,
      'mixed-residential': 0,
      office: 0,
      residential: candidateManifest.transactions.recordCount,
      unknown: 0,
    },
    byParkingGrade: { A: candidateManifest.transactions.recordCount, B: 0, C: 0 },
    gradeBByComponent: {
      missingBoth: 0,
      officialAreaOnly: 0,
      officialPriceOnly: 0,
    },
    gradeBImputed: 0,
    gradeBUnresolved: 0,
  };
  for (const indexFile of ['doorplates-index.json', 'transactions-index.json']) {
    candidateManifest.artifacts[indexFile] = {
      sha256: await sha256File(join(root, indexFile)),
      bytes: (await readFile(join(root, indexFile))).byteLength,
    };
  }
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(candidateManifest)}\n`);
}

test('activation loads only the schema-5 policy-7 pair', async (t) => {
  assert.equal(MARKET_SCHEMA_VERSION, 5);
  assert.equal(ESTIMATOR_POLICY_VERSION, 7);
  assert.equal(CANDIDATE_MARKET_SCHEMA_VERSION, 5);
  assert.equal(CANDIDATE_ESTIMATOR_POLICY_VERSION, 7);

  const parent = await mkdtemp(join(tmpdir(), 'market-store-activation-contract-'));
  const root = join(parent, 'taipei');
  const candidateRoot = join(parent, '.taipei-staging-candidate');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'production-contract');
  const productionAcceptance = await passingAcceptance(root);
  await writeFile(backtestAcceptancePath(root), JSON.stringify(productionAcceptance));

  const active = await loadMarketData(root, { minDoorplates: 1, minTransactions: 0 });
  assert.equal(active?.backtestAcceptance?.schemaVersion, 3);
  assert.equal(marketDataBacktestAccepted(active!), true);
  assert.equal((await validateCandidateStagedBuild(root, { minDoorplates: 1, minTransactions: 0 })).manifest.schemaVersion, 5);

  await writeBuild(candidateRoot, 'candidate-contract');
  await convertBuildToCandidate(candidateRoot);
  const challenger = await validateCandidateStagedBuild(candidateRoot, {
    minDoorplates: 1,
    minTransactions: 0,
  });
  const candidateAcceptance = await passingCandidateAcceptance(candidateRoot);
  assert.equal(challenger.manifest.schemaVersion, 5);
  assert.equal((await loadMarketData(candidateRoot, { minDoorplates: 1, minTransactions: 0 }))?.manifest.schemaVersion, 5);
  assert.equal(validCandidateBacktestAcceptance(candidateAcceptance, 'baseline'), true);
  assert.equal(validBacktestAcceptance(candidateAcceptance), false);
});

async function passingCandidateAcceptance(root: string): Promise<CandidateBacktestAcceptance> {
  const checksum = transactionArtifactChecksum(readManifest(root)!);
  assert.ok(checksum);
  const diagnosticOnly = {
    status: 'diagnostic-only' as const,
    scoredCases: 0,
    estimateCoverage: 0,
    medianApe: null,
    p75Ape: null,
    bias: null,
    intervalCoverage: null,
    reasons: ['insufficient-use-cohort-cases', 'incomplete-use-cohort-metrics'],
  };
  return {
    schemaVersion: 3,
    estimatorPolicyVersion: CANDIDATE_ESTIMATOR_POLICY_VERSION,
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
      minimumUseCohortCases: 20,
      maximumAbsoluteBiasRegression: 0.01,
      maximumIntervalCoverageRegression: 0.05,
      maximumAbsoluteBias: 0.05,
      minimumIntervalCoverage: 0.30,
      minimumParkingFamilyCases: 20,
      minimumParkingEstimateCoverage: 0.50,
      parkingPriceMedianApeMax: 0.25,
      parkingPriceP75ApeMax: 0.45,
      parkingAreaMedianApeMax: 0.15,
      parkingAreaP75ApeMax: 0.30,
      minimumParkingPriceIntervalCoverage: 0.30,
      minimumParkingAreaIntervalCoverage: 0.30,
    },
    metrics: {
      estimateCoverage: 0.8,
      reliableEstimatedCount: 40,
      reliableMedianApe: 0.08,
      reliableP75Ape: 0.16,
      highConfidenceEstimatedCount: 20,
      highConfidenceMedianApe: 0.07,
      mediumConfidenceEstimatedCount: 20,
      mediumConfidenceMedianApe: 0.09,
    },
    useCohorts: {
      commercial: { ...diagnosticOnly },
      industrial: { ...diagnosticOnly },
      'mixed-industrial': { ...diagnosticOnly },
      'mixed-residential': { ...diagnosticOnly },
      office: { ...diagnosticOnly },
      residential: {
        status: 'accepted',
        scoredCases: 20,
        estimateCoverage: 0.8,
        medianApe: 0.08,
        p75Ape: 0.16,
        bias: 0,
        intervalCoverage: 0.8,
        reasons: [],
      },
    },
    parkingImputationAccepted: true,
    parkingFamilies: {
      flat: {
        status: 'accepted',
        caseCount: 20,
        estimatedCount: 16,
        estimateCoverage: 0.8,
        priceMedianApe: 0.10,
        priceP75Ape: 0.20,
        areaMedianApe: 0.08,
        areaP75Ape: 0.12,
        priceIntervalCoverage: 0.50,
        areaIntervalCoverage: 0.50,
        reasons: [],
      },
      mechanical: {
        status: 'accepted',
        caseCount: 20,
        estimatedCount: 16,
        estimateCoverage: 0.8,
        priceMedianApe: 0.10,
        priceP75Ape: 0.20,
        areaMedianApe: 0.08,
        areaP75Ape: 0.12,
        priceIntervalCoverage: 0.50,
        areaIntervalCoverage: 0.50,
        reasons: [],
      },
    },
    parkingComparison: {
      directCoverage: 0.70,
      imputedCoverage: 0.71,
      directMedianApe: 0.10,
      imputedMedianApe: 0.11,
      directP75Ape: 0.18,
      imputedP75Ape: 0.19,
      biasRegression: 0.01,
      intervalCoverageRegression: 0.05,
    },
  };
}

async function passingAcceptance(root: string): Promise<CandidateBacktestAcceptance> {
  return passingCandidateAcceptance(root);
}

async function passingLegacyAcceptance(root: string): Promise<LegacyBacktestAcceptance> {
  const current = await passingCandidateAcceptance(root);
  return {
    schemaVersion: 2,
    estimatorPolicyVersion: ESTIMATOR_POLICY_VERSION,
    policyId: current.policyId,
    transactionArtifactSha256: current.transactionArtifactSha256,
    approvedAt: current.approvedAt,
    asOf: current.asOf,
    evaluatedThrough: current.evaluatedThrough,
    latestEligibleTransactionDate: current.latestEligibleTransactionDate,
    thresholds: {
      medianApeMax: current.thresholds.medianApeMax,
      p75ApeMax: current.thresholds.p75ApeMax,
      minimumEstimateCoverage: current.thresholds.minimumEstimateCoverage,
      minimumConfidenceSliceCases: current.thresholds.minimumConfidenceSliceCases,
      minimumHighConfidenceImprovement: current.thresholds.minimumHighConfidenceImprovement,
    },
    metrics: { ...current.metrics },
  };
}

async function crashPublicationAfterRename(
  active: string,
  stage: string,
  acceptance: BacktestAcceptance | CandidateBacktestAcceptance,
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

test('publication rollback preserves exact accepted predecessor bytes', async (t) => {
  for (const predecessor of [
    { schemaVersion: 3 as const, policyVersion: 4, acceptanceSchema: 2 as const },
    { schemaVersion: 4 as const, policyVersion: 5, acceptanceSchema: 3 as const },
  ]) await t.test(`schema-${predecessor.schemaVersion} policy-${predecessor.policyVersion}`, async (t) => {
    const parent = await mkdtemp(join(tmpdir(), 'market-store-predecessor-rollback-'));
    const active = join(parent, 'taipei');
    const stage = join(parent, '.taipei-staging-next');
    t.after(() => rm(parent, { recursive: true, force: true }));
    await writeBuild(active, `old-schema-${predecessor.schemaVersion}`);
    await downgradeBuildToLegacySchema(active, predecessor.schemaVersion);
    const oldAcceptance = predecessor.acceptanceSchema === 2
      ? { ...await passingLegacyAcceptance(active), estimatorPolicyVersion: predecessor.policyVersion }
      : { ...await passingAcceptance(active), estimatorPolicyVersion: predecessor.policyVersion };
    await writeFile(backtestAcceptancePath(active), `${stableJson(oldAcceptance)}\n`);
    const oldManifestBytes = await readFile(join(active, 'manifest.json'));
    const oldTransactionBytes = await readFile(join(active, 'transactions-index.json'));
    const oldAcceptanceBytes = await readFile(backtestAcceptancePath(active));
    await writeBuild(stage, 'next-current-build');
    const nextAcceptance = await passingAcceptance(stage);
    const acceptancePath = backtestAcceptancePath(active);

    await assert.rejects(
      () => publishStagedBuildWithAcceptance(active, stage, nextAcceptance, {
        minDoorplates: 1,
        minTransactions: 0,
        publicationFileOps: {
          rename: async (from, to) => {
            if (to === acceptancePath && from !== stage) {
              throw new Error('injected pre-acceptance rename failure');
            }
            await rename(from, to);
          },
        },
      }),
      (error) => {
        assert.equal(error instanceof AggregateError, false);
        assert.match((error as Error).message, /injected pre-acceptance rename failure/);
        return true;
      },
    );

    assert.deepEqual(await readFile(join(active, 'manifest.json')), oldManifestBytes);
    assert.deepEqual(await readFile(join(active, 'transactions-index.json')), oldTransactionBytes);
    assert.deepEqual(await readFile(acceptancePath), oldAcceptanceBytes);
  });
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

test('restart recovery restores schema 1-3 predecessors after the first production rename', async (t) => {
  const predecessors = [
    { schemaVersion: 1 as const, schema2Normalization: 'legacy-five' as const, label: 'schema 1' },
    { schemaVersion: 2 as const, schema2Normalization: 'absent' as const, label: 'schema 2 without normalization' },
    { schemaVersion: 2 as const, schema2Normalization: 'legacy-five' as const, label: 'schema 2 with legacy normalization' },
    { schemaVersion: 3 as const, schema2Normalization: 'legacy-five' as const, label: 'schema 3' },
  ];
  for (const predecessor of predecessors) {
    await t.test(predecessor.label, async (t) => {
      const { schemaVersion, schema2Normalization } = predecessor;
      const parent = await mkdtemp(
        join(tmpdir(), `market-store-schema${schemaVersion}-${schema2Normalization}-crash-`),
      );
      const active = join(parent, 'taipei');
      const stage = join(parent, '.taipei-staging-next');
      t.after(() => rm(parent, { recursive: true, force: true }));
      const oldBuildId = `schema${schemaVersion}-${schema2Normalization}-build`;
      await writeBuild(active, oldBuildId);
      await downgradeBuildToLegacySchema(active, schemaVersion, schema2Normalization);
      await writeBuild(stage, 'schema5-build');

      await crashPublicationAfterRename(
        active,
        stage,
        await passingAcceptance(stage),
        1,
      );
      const recovered = await recoverInterruptedMarketDataPublication(active, {
        minDoorplates: 1,
        minTransactions: 0,
      });

      assert.equal(recovered?.manifest.schemaVersion ?? null, null);
      assert.equal(readManifest(active)?.buildId, oldBuildId);
      assert.equal(readManifest(active)?.schemaVersion, schemaVersion);
      const loaded = await loadMarketData(active, { minDoorplates: 1, minTransactions: 0 });
      assert.equal(loaded?.manifest.schemaVersion ?? null, null);
      assert.deepEqual(await readdir(parent), ['taipei']);
    });
  }
});

test('production publication validates both historical schema-2 manifest shapes', async (t) => {
  for (const schema2Normalization of ['absent', 'legacy-five'] as const) {
    await t.test(schema2Normalization, async (t) => {
      const parent = await mkdtemp(
        join(tmpdir(), `market-store-schema2-${schema2Normalization}-publication-`),
      );
      const active = join(parent, 'taipei');
      const stage = join(parent, '.taipei-staging-next');
      t.after(() => rm(parent, { recursive: true, force: true }));
      await writeBuild(active, `schema2-${schema2Normalization}-build`);
      await downgradeBuildToLegacySchema(active, 2, schema2Normalization);
      const oldManifest = readManifest(active)! as unknown as Record<string, unknown> & {
        transactions: Record<string, unknown>;
      };
      assert.equal(Object.hasOwn(oldManifest, 'estimatorPolicyVersion'), false);
      assert.equal(
        Object.hasOwn(oldManifest.transactions, 'normalization'),
        schema2Normalization === 'legacy-five',
      );
      await writeBuild(stage, 'schema5-build');

      const published = await publishStagedBuildWithAcceptance(
        active,
        stage,
        await passingAcceptance(stage),
        { minDoorplates: 1, minTransactions: 0 },
      );

      assert.equal(published.manifest.schemaVersion, MARKET_SCHEMA_VERSION);
      assert.equal(published.manifest.estimatorPolicyVersion, ESTIMATOR_POLICY_VERSION);
      assert.equal(published.backtestAcceptance?.schemaVersion, 3);
      assert.equal(marketDataBacktestAccepted(published), true);
    });
  }
});

test('restorable schema 2 rejects partial, extra, or incorrectly typed normalization', async (t) => {
  const mutations = [
    {
      label: 'partial',
      mutate: (normalization: Record<string, unknown>): unknown => {
        const partial = { ...normalization };
        delete partial.excludedByReason;
        return partial;
      },
    },
    {
      label: 'extra',
      mutate: (normalization: Record<string, unknown>): unknown => ({
        ...normalization,
        byPrimaryUse: {},
      }),
    },
    {
      label: 'incorrect type',
      mutate: (_normalization: Record<string, unknown>): unknown => [],
    },
  ];
  for (const mutation of mutations) {
    await t.test(mutation.label, async (t) => {
      const parent = await mkdtemp(join(tmpdir(), 'market-store-schema2-invalid-shape-'));
      const active = join(parent, 'taipei');
      const stage = join(parent, '.taipei-staging-next');
      t.after(() => rm(parent, { recursive: true, force: true }));
      await writeBuild(active, `schema2-${mutation.label}-build`);
      await downgradeBuildToLegacySchema(active, 2, 'legacy-five');
      const oldManifest = JSON.parse(
        await readFile(join(active, 'manifest.json'), 'utf8'),
      ) as Record<string, unknown> & { transactions: Record<string, unknown> };
      oldManifest.transactions.normalization = mutation.mutate(
        oldManifest.transactions.normalization as Record<string, unknown>,
      );
      await writeFile(join(active, 'manifest.json'), `${JSON.stringify(oldManifest)}\n`);
      await writeBuild(stage, 'schema4-build');
      const acceptance = await passingAcceptance(stage);

      await assert.rejects(
        () => publishStagedBuildWithAcceptance(
          active,
          stage,
          acceptance,
          { minDoorplates: 1, minTransactions: 0 },
        ),
        /legacy transaction normalization.*schema/i,
      );
    });
  }
});

test('production publication validates a true schema-3 policy-4 predecessor', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-schema3-predecessor-'));
  const active = join(parent, 'taipei');
  const stage = join(parent, '.taipei-staging-next');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'schema3-policy4-build');
  await downgradeBuildToLegacySchema(active, 3);
  const oldManifest = readManifest(active)!;
  assert.equal(oldManifest.estimatorPolicyVersion, 4);
  assert.deepEqual(
    Object.keys(oldManifest.transactions.normalization).sort(),
    ['excluded', 'excludedByReason', 'rawRows', 'reliableEligible', 'reviewOnly'],
  );
  await writeFile(backtestAcceptancePath(active), JSON.stringify({
    ...await passingLegacyAcceptance(active),
    estimatorPolicyVersion: 4,
  }));
  await writeBuild(stage, 'schema5-policy6-build');

  const published = await publishStagedBuildWithAcceptance(
    active,
    stage,
    await passingAcceptance(stage),
    { minDoorplates: 1, minTransactions: 0 },
  );

  assert.equal(published.manifest.schemaVersion, MARKET_SCHEMA_VERSION);
  assert.equal(published.manifest.estimatorPolicyVersion, ESTIMATOR_POLICY_VERSION);
  assert.equal(published.backtestAcceptance?.schemaVersion, 3);
  assert.equal(marketDataBacktestAccepted(published), true);
});

test('production publication recovers a schema-4 policy-5 predecessor', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-schema4-predecessor-'));
  const active = join(parent, 'taipei');
  const stage = join(parent, '.taipei-staging-next');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(active, 'schema4-policy5-build');
  await downgradeBuildToLegacySchema(active, 4);
  const oldManifest = readManifest(active)!;
  assert.equal(oldManifest.estimatorPolicyVersion, 5);
  assert.equal(
    Object.hasOwn(oldManifest.transactions.normalization, 'gradeBByComponent'),
    false,
  );
  await writeBuild(stage, 'schema5-policy6-build');

  const published = await publishStagedBuildWithAcceptance(
      active,
      stage,
      await passingAcceptance(stage),
      { minDoorplates: 1, minTransactions: 0 },
  );
  assert.equal(published.manifest.schemaVersion, 5);
  assert.equal(readManifest(active)?.schemaVersion, 5);
  assert.equal(readManifest(stage), null);
});

test('restorable schema 1-3 reject fields from a different manifest generation', async (t) => {
  for (const schemaVersion of [1, 2, 3] as const) {
    await t.test(`schema ${schemaVersion}`, async (t) => {
      const parent = await mkdtemp(
        join(tmpdir(), `market-store-schema${schemaVersion}-shape-`),
      );
      const active = join(parent, 'taipei');
      const stage = join(parent, '.taipei-staging-next');
      t.after(() => rm(parent, { recursive: true, force: true }));
      await writeBuild(active, `schema${schemaVersion}-build`);
      await downgradeBuildToLegacySchema(active, schemaVersion);
      const oldManifest = JSON.parse(
        await readFile(join(active, 'manifest.json'), 'utf8'),
      ) as Record<string, unknown> & { transactions: Record<string, unknown> };
      if (schemaVersion === 1) {
        oldManifest.transactions.normalization = {
          rawRows: 1,
          reliableEligible: 1,
          reviewOnly: 0,
          excluded: 0,
          excludedByReason: {},
        };
      } else if (schemaVersion === 2) {
        oldManifest.estimatorPolicyVersion = 4;
      } else {
        (oldManifest.transactions.normalization as Record<string, unknown>).byPrimaryUse = {};
      }
      await writeFile(join(active, 'manifest.json'), `${JSON.stringify(oldManifest)}\n`);
      await writeBuild(stage, 'schema4-build');
      const acceptance = await passingAcceptance(stage);

      await assert.rejects(
        () => publishStagedBuildWithAcceptance(
          active,
          stage,
          acceptance,
          { minDoorplates: 1, minTransactions: 0 },
        ),
        /legacy .* schema/i,
      );
    });
  }
});

test('current load rejects the schema-3 build and schema-2 acceptance pair', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-prior-pair-'));
  const root = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'schema3-policy4-build');
  await downgradeBuildToLegacySchema(root, 3);
  await writeFile(backtestAcceptancePath(root), JSON.stringify({
    ...await passingLegacyAcceptance(root),
    estimatorPolicyVersion: 4,
  }));

  const loaded = await loadMarketData(root, { minDoorplates: 1, minTransactions: 0 });
  assert.equal(loaded, null);
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
    ...unsortedManifest.transactions.normalization,
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
    ...inconsistentReasonsManifest.transactions.normalization,
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
    ...validManifest.transactions.normalization,
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

test('candidate validation rejects incomplete, unstable, or inconsistent use and parking diagnostics', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-'));
  t.after(() => rm(parent, { recursive: true, force: true }));

  async function changeDiagnostics(
    name: string,
    change: (normalization: MarketDataManifest['transactions']['normalization']) => void,
  ): Promise<void> {
    const root = join(parent, name);
    await writeBuild(root, name);
    await convertBuildToCandidate(root);
    const value = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as MarketDataManifest;
    change(value.transactions.normalization);
    await writeFile(join(root, 'manifest.json'), JSON.stringify(value));
    await assert.rejects(
      () => validateCandidateStagedBuild(root, { minDoorplates: 0, minTransactions: 0 }),
      /normalization/i,
    );
  }

  await changeDiagnostics('use-count-mismatch', (normalization) => {
    normalization.byPrimaryUse.residential = 0;
  });
  await changeDiagnostics('parking-count-mismatch', (normalization) => {
    normalization.byParkingGrade.A = 0;
  });
  await changeDiagnostics('grade-b-resolution-mismatch', (normalization) => {
    normalization.byParkingGrade = { A: 0, B: 1, C: 0 };
  });
  await changeDiagnostics('missing-grade-b-component-breakdown', (normalization) => {
    delete (normalization as unknown as Record<string, unknown>).gradeBByComponent;
  });
  await changeDiagnostics('extra-grade-b-component-key', (normalization) => {
    (normalization as unknown as Record<string, unknown>).gradeBByComponent = {
      ...normalization.gradeBByComponent,
      privateCaseIds: ['must-not-load'],
    };
  });
  await changeDiagnostics('grade-b-component-count-mismatch', (normalization) => {
    normalization.byParkingGrade = { A: 0, B: 1, C: 0 };
    normalization.gradeBImputed = 1;
    normalization.gradeBByComponent.officialPriceOnly = 0;
  });
  await changeDiagnostics('missing-use-key', (normalization) => {
    delete (normalization.byPrimaryUse as Partial<typeof normalization.byPrimaryUse>).unknown;
  });
  await changeDiagnostics('unstable-parking-key-order', (normalization) => {
    normalization.byParkingGrade = { B: 0, A: 1, C: 0 };
  });
  await changeDiagnostics('aggregate-only-current-shape', (normalization) => {
    (normalization as unknown as Record<string, unknown>).rawCases = [{
      address: '台北市不可載入的地址',
    }];
  });
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

test('load rejects missing or mismatched index policy provenance', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-provenance-'));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const missing = join(parent, 'missing');
  await writeBuild(missing, 'missing-provenance');
  const missingManifest = JSON.parse(
    await readFile(join(missing, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  delete missingManifest.estimatorPolicyVersion;
  await writeFile(join(missing, 'manifest.json'), JSON.stringify(missingManifest));
  assert.equal(
    await loadMarketData(missing, { minDoorplates: 1, minTransactions: 0 }),
    null,
  );

  const mismatched = join(parent, 'mismatched');
  await writeBuild(mismatched, 'mismatched-provenance');
  const mismatchedManifest = JSON.parse(
    await readFile(join(mismatched, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  mismatchedManifest.estimatorPolicyVersion = ESTIMATOR_POLICY_VERSION - 1;
  await writeFile(join(mismatched, 'manifest.json'), JSON.stringify(mismatchedManifest));
  assert.equal(
    await loadMarketData(mismatched, { minDoorplates: 1, minTransactions: 0 }),
    null,
  );
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
  assert.equal(readBacktestAcceptance(root)?.schemaVersion, 3);
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
  await assert.rejects(
    () => writeBacktestAcceptance(root, {
      ...acceptance,
      transactionArtifactSha256: 'different-dataset',
    }),
    /transaction.*checksum/i,
  );
});

test('candidate schema-3 acceptance is exact, aggregate-only, and internally consistent', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-scenario-acceptance-'));
  const root = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'scenario-acceptance');
  await convertBuildToCandidate(root);
  const acceptance = await passingCandidateAcceptance(root);
  assert.equal(validCandidateBacktestAcceptance(acceptance, 'baseline'), true);
  assert.equal(validBacktestAcceptance(acceptance), false);

  await assert.rejects(
    () => writeBacktestAcceptance(root, {
      ...acceptance,
      cases: [{ originalAddress: 'must-not-persist' }],
    } as unknown as BacktestAcceptance),
    /index policy provenance|non-passing backtest acceptance/,
  );

  const { office: _office, ...missingOffice } = acceptance.useCohorts;
  const { mechanical: _mechanical, ...missingMechanicalFamily } = acceptance.parkingFamilies;
  const { intervalCoverageRegression: _interval, ...missingParkingMetric } = acceptance.parkingComparison;
  const invalid: unknown[] = [
    { ...acceptance, transactionArtifactSha256: 'not-a-sha256' },
    { ...acceptance, unexpected: true },
    { ...acceptance, rawCases: [{ address: '台北市不可載入的地址' }] },
    { ...acceptance, useCohorts: missingOffice },
    { ...acceptance, useCohorts: { ...acceptance.useCohorts, unknown: acceptance.useCohorts.office } },
    {
      ...acceptance,
      useCohorts: {
        ...acceptance.useCohorts,
        office: { ...acceptance.useCohorts.office, caseIds: ['private-case-id'] },
      },
    },
    {
      ...acceptance,
      useCohorts: {
        ...acceptance.useCohorts,
        office: {
          ...acceptance.useCohorts.office,
          status: 'accepted',
          scoredCases: 19,
          medianApe: 0.05,
          p75Ape: 0.10,
          bias: 0,
          intervalCoverage: 0.8,
          reasons: [],
        },
      },
    },
    {
      ...acceptance,
      useCohorts: {
        ...acceptance.useCohorts,
        residential: { ...acceptance.useCohorts.residential, scoredCases: 20.5 },
      },
    },
    {
      ...acceptance,
      useCohorts: {
        ...acceptance.useCohorts,
        residential: { ...acceptance.useCohorts.residential, medianApe: Number.NaN },
      },
    },
    {
      ...acceptance,
      useCohorts: {
        ...acceptance.useCohorts,
        office: { ...acceptance.useCohorts.office, estimateCoverage: 0.1 },
      },
    },
    {
      ...acceptance,
      useCohorts: {
        ...acceptance.useCohorts,
        office: { ...acceptance.useCohorts.office, scoredCases: 1, estimateCoverage: 0.1 },
      },
    },
    {
      ...acceptance,
      metrics: {
        ...acceptance.metrics,
        reliableMedianApe: 0.10,
        reliableP75Ape: 0.09,
      },
    },
    { ...acceptance, metrics: { ...acceptance.metrics, reliableEstimatedCount: 39 } },
    { ...acceptance, metrics: { ...acceptance.metrics, reliableEstimatedCount: 41 } },
    {
      ...acceptance,
      useCohorts: {
        ...acceptance.useCohorts,
        residential: {
          ...acceptance.useCohorts.residential,
          medianApe: 0.10,
          p75Ape: 0.09,
        },
      },
    },
    {
      ...acceptance,
      useCohorts: {
        ...acceptance.useCohorts,
        residential: { ...acceptance.useCohorts.residential, estimateCoverage: 0.81 },
      },
    },
    {
      ...acceptance,
      useCohorts: {
        ...acceptance.useCohorts,
        residential: {
          ...acceptance.useCohorts.residential,
          estimateCoverage: 0.8000000000001,
        },
      },
    },
    { ...acceptance, metrics: { ...acceptance.metrics, reliableEstimatedCount: 0 } },
    { ...acceptance, parkingFamilies: missingMechanicalFamily },
    {
      ...acceptance,
      parkingFamilies: {
        ...acceptance.parkingFamilies,
        flat: {
          ...acceptance.parkingFamilies.flat,
          caseIds: ['private-case-id'],
        },
      },
    },
    {
      ...acceptance,
      parkingFamilies: {
        ...acceptance.parkingFamilies,
        flat: {
          ...acceptance.parkingFamilies.flat,
          address: '台北市不可載入的地址',
        },
      },
    },
    {
      ...acceptance,
      parkingFamilies: {
        ...acceptance.parkingFamilies,
        flat: { ...acceptance.parkingFamilies.flat, estimateCoverage: 0.81 },
      },
    },
    {
      ...acceptance,
      parkingFamilies: {
        ...acceptance.parkingFamilies,
        flat: { ...acceptance.parkingFamilies.flat, status: 'failed' },
      },
    },
    {
      ...acceptance,
      useCohorts: {
        ...acceptance.useCohorts,
        residential: {
          ...acceptance.useCohorts.residential,
          bias: 0.99,
          intervalCoverage: 0,
        },
      },
    },
    { ...acceptance, parkingImputationAccepted: false },
    { ...acceptance, parkingComparison: missingParkingMetric },
    { ...acceptance, parkingComparison: { ...acceptance.parkingComparison, directCoverage: 1.1 } },
    { ...acceptance, parkingComparison: { ...acceptance.parkingComparison, directMedianApe: null } },
    {
      ...acceptance,
      parkingComparison: {
        ...acceptance.parkingComparison,
        directMedianApe: 0.10,
        directP75Ape: 0.09,
      },
    },
    {
      ...acceptance,
      parkingImputationAccepted: false,
      parkingComparison: { ...acceptance.parkingComparison, intervalCoverageRegression: 2 },
    },
    { ...acceptance, thresholds: { ...acceptance.thresholds, minimumUseCohortCases: 19 } },
    { ...acceptance, thresholds: { ...acceptance.thresholds, maximumAbsoluteBias: 0.99 } },
    {
      ...acceptance,
      thresholds: {
        ...acceptance.thresholds,
        minimumParkingFamilyCases: PARKING_BACKTEST_GATE.minimumMaskedCases - 1,
      },
    },
  ];
  for (const candidate of invalid) {
    assert.equal(validCandidateBacktestAcceptance(candidate, 'baseline'), false);
  }
});

test('candidate schema-3 prior-policy acceptance fails closed while exact policy-7 acceptance validates', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-policy6-acceptance-'));
  const root = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'policy6-acceptance');
  await convertBuildToCandidate(root);
  const acceptance = await passingCandidateAcceptance(root);

  assert.equal(validCandidateBacktestAcceptance(acceptance, 'baseline'), true);
  assert.equal(validBacktestAcceptance(acceptance), false);

  assert.equal(validCandidateBacktestAcceptance({
    ...acceptance,
    estimatorPolicyVersion: 5,
  }, 'baseline'), false);
});

test('candidate acceptance validates only against its explicitly expected estimator policy', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-candidate-policy-identity-'));
  const root = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'candidate-policy-identity');
  await convertBuildToCandidate(root);
  const baseline = await passingCandidateAcceptance(root);

  assert.equal(validCandidateBacktestAcceptance(baseline, 'baseline'), true);
  assert.equal(validCandidateBacktestAcceptance(baseline, '48-month'), false);
  assert.equal(validCandidateBacktestAcceptance({ ...baseline, policyId: '48-month' }, 'baseline'), false);
  assert.equal(validCandidateBacktestAcceptance({ ...baseline, policyId: '48-month' }, '48-month'), true);
  assert.equal(validCandidateBacktestAcceptance({ ...baseline, policyId: '1000-meter' }, '48-month'), false);
});

test('candidate validation recomputes exact manifest categories from persisted rows', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-candidate-row-counts-'));
  const root = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'candidate-row-counts');
  await convertBuildToCandidate(root);
  const candidateManifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as MarketDataManifest;
  candidateManifest.transactions.normalization.byPrimaryUse.residential -= 1;
  candidateManifest.transactions.normalization.byPrimaryUse.office += 1;
  candidateManifest.transactions.normalization.byParkingGrade.A -= 1;
  candidateManifest.transactions.normalization.byParkingGrade.C += 1;
  await writeFile(join(root, 'manifest.json'), JSON.stringify(candidateManifest));

  await assert.rejects(
    () => validateCandidateStagedBuild(root, { minDoorplates: 1, minTransactions: 0 }),
    /diagnostics.*persisted rows|persisted rows.*diagnostics/i,
  );
});

test('candidate validation rejects malformed persisted row invariants even with matching checksums', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-candidate-row-invariants-'));
  const root = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'candidate-row-invariants');
  await convertBuildToCandidate(root);
  const indexPath = join(root, 'transactions-index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8')) as TransactionIndex;
  Object.values(index.cells)[0]![0]!.transferredParkingCount = -1;
  await writeFile(indexPath, JSON.stringify(index));
  const candidateManifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as MarketDataManifest;
  candidateManifest.artifacts['transactions-index.json'] = {
    sha256: await sha256File(indexPath),
    bytes: (await readFile(indexPath)).byteLength,
  };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(candidateManifest));

  await assert.rejects(
    () => validateCandidateStagedBuild(root, { minDoorplates: 1, minTransactions: 0 }),
    /candidate transaction row/i,
  );
});

test('schema-5 validation rejects checksum-consistent positive arithmetic tampering', async (t) => {
  const mutations: Array<[string, (row: MarketTransaction) => void]> = [
    ['building price', (row) => { row.buildingPriceNtd = 29_000_000; }],
    ['building area', (row) => { row.buildingAreaPing = 24; }],
    ['building unit price', (row) => { row.buildingUnitPriceWan = 999_999; }],
    ['parking price IQR', (row) => { row.parkingEvidence.imputation!.priceIqrRatio = 0.5; }],
    ['parking area IQR', (row) => { row.parkingEvidence.imputation!.areaIqrRatio = 0.5; }],
    ['parking scalar P50', (row) => { row.parkingEvidence.imputation!.priceP50Ntd = 2_100_000; }],
    ['building bounds P50', (row) => { row.buildingUnitPriceBoundsWan!.p50 = 113; }],
    ['building bounds IQR', (row) => { row.buildingUnitPriceBoundsWan!.relativeIqrRatio = 0.1; }],
    ['joint P50 pair', (row) => {
      row.parkingEvidence.imputation!.pairP50.priceNtd = 2_100_000;
      row.parkingPriceNtd = 2_100_000;
      row.buildingPriceNtd = 27_900_000;
      row.buildingUnitPriceWan = 111.6;
      row.buildingUnitPriceBoundsWan!.p50 = 111.6;
    }],
  ];

  for (const [label, mutate] of mutations) await t.test(label, async (t) => {
    const parent = await mkdtemp(join(tmpdir(), 'market-store-arithmetic-tamper-'));
    const root = join(parent, 'taipei');
    t.after(() => rm(parent, { recursive: true, force: true }));
    await writeBuild(root, `arithmetic-${label}`);
    await convertBuildToCandidate(root);
    const index = JSON.parse(await readFile(join(root, 'transactions-index.json'), 'utf8')) as TransactionIndex;
    const row = consistentGradeBTransaction();
    mutate(row);
    index.cells[Object.keys(index.cells)[0]!] = [row];
    const value = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as MarketDataManifest;
    value.transactions.normalization.byParkingGrade = { A: 0, B: 1, C: 0 };
    value.transactions.normalization.gradeBByComponent = {
      missingBoth: 1, officialAreaOnly: 0, officialPriceOnly: 0,
    };
    value.transactions.normalization.gradeBImputed = 1;
    value.transactions.normalization.gradeBUnresolved = 0;
    await writeFile(join(root, 'manifest.json'), JSON.stringify(value));
    await rewriteTransactionIndexChecksum(root, index);

    await assert.rejects(
      () => validateCandidateStagedBuild(root, { minDoorplates: 1, minTransactions: 0 }),
      /arithmetic|derived|imputation evidence/i,
    );
  });
});

test('schema-5 validation accepts a checksum-consistent arithmetically valid grade-B row', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-arithmetic-valid-'));
  const root = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'arithmetic-valid');
  await convertBuildToCandidate(root);
  const index = JSON.parse(await readFile(join(root, 'transactions-index.json'), 'utf8')) as TransactionIndex;
  index.cells[Object.keys(index.cells)[0]!] = [consistentGradeBTransaction()];
  const value = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as MarketDataManifest;
  value.transactions.normalization.byParkingGrade = { A: 0, B: 1, C: 0 };
  value.transactions.normalization.gradeBByComponent = {
    missingBoth: 1, officialAreaOnly: 0, officialPriceOnly: 0,
  };
  value.transactions.normalization.gradeBImputed = 1;
  value.transactions.normalization.gradeBUnresolved = 0;
  await writeFile(join(root, 'manifest.json'), JSON.stringify(value));
  await rewriteTransactionIndexChecksum(root, index);

  await validateCandidateStagedBuild(root, { minDoorplates: 1, minTransactions: 0 });
});

test('schema-5 validation rejects a Grade-B pair that contradicts its official component total', async (t) => {
  for (const component of ['price', 'area'] as const) await t.test(component, async (t) => {
    const parent = await mkdtemp(join(tmpdir(), 'market-store-official-component-'));
    const root = join(parent, 'taipei');
    t.after(() => rm(parent, { recursive: true, force: true }));
    await writeBuild(root, `official-${component}`);
    await convertBuildToCandidate(root);
    const index = JSON.parse(await readFile(join(root, 'transactions-index.json'), 'utf8')) as TransactionIndex;
    const row = consistentGradeBTransaction();
    const imputation = row.parkingEvidence.imputation!;
    if (component === 'price') {
      row.parkingEvidence.officialPriceNtd = 2_000_000;
      imputation.priceP25Ntd = 2_000_000;
      imputation.priceP75Ntd = 2_000_000;
      imputation.priceIqrRatio = 0;
      imputation.pairP25.priceNtd = 1_900_000;
      imputation.pairP75.priceNtd = 2_000_000;
    } else {
      row.parkingEvidence.officialAreaPing = 5;
      imputation.areaP25Ping = 5;
      imputation.areaP75Ping = 5;
      imputation.areaIqrRatio = 0;
      imputation.pairP25.areaPing = 4.9;
      imputation.pairP75.areaPing = 5;
    }
    index.cells[Object.keys(index.cells)[0]!] = [row];
    const value = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as MarketDataManifest;
    value.transactions.normalization.byParkingGrade = { A: 0, B: 1, C: 0 };
    value.transactions.normalization.gradeBByComponent = component === 'price'
      ? { missingBoth: 0, officialAreaOnly: 0, officialPriceOnly: 1 }
      : { missingBoth: 0, officialAreaOnly: 1, officialPriceOnly: 0 };
    value.transactions.normalization.gradeBImputed = 1;
    value.transactions.normalization.gradeBUnresolved = 0;
    await writeFile(join(root, 'manifest.json'), JSON.stringify(value));
    await rewriteTransactionIndexChecksum(root, index);

    await assert.rejects(
      () => validateCandidateStagedBuild(root, { minDoorplates: 1, minTransactions: 0 }),
      /arithmetic|imputation evidence/i,
    );
  });
});

test('candidate acceptance rejects an artifact unless residential and both parking families passed', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-production-gate-'));
  const root = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'production-gate');
  await convertBuildToCandidate(root);
  const acceptance = await passingCandidateAcceptance(root);

  for (const invalid of [
    {
      ...acceptance,
      useCohorts: {
        ...acceptance.useCohorts,
        residential: {
          ...acceptance.useCohorts.residential,
          status: 'failed' as const,
          bias: SCENARIO_BACKTEST_GATE.maximumAbsoluteBias + 0.01,
          reasons: ['absolute-bias-target-missed'],
        },
      },
    },
    {
      ...acceptance,
      parkingImputationAccepted: false,
      parkingFamilies: {
        ...acceptance.parkingFamilies,
        mechanical: {
          ...acceptance.parkingFamilies.mechanical,
          status: 'failed' as const,
          priceMedianApe: PARKING_BACKTEST_GATE.priceMedianApeMax + 0.01,
          reasons: ['parking-price-median-ape-target-missed'],
        },
      },
    },
  ]) {
    assert.equal(validCandidateBacktestAcceptance(invalid, 'baseline'), false);
  }
});

test('schema-2 acceptance cannot authorize the activated production runtime', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-legacy-acceptance-'));
  const root = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'legacy-acceptance');
  const acceptance = await passingLegacyAcceptance(root);

  await assert.rejects(() => writeBacktestAcceptance(root, acceptance), /policy provenance/);
  assert.equal(readBacktestAcceptance(root), null);
  assert.equal(validCandidateBacktestAcceptance(acceptance, 'baseline'), false);
  const loaded = await loadMarketData(root, { minDoorplates: 1, minTransactions: 0 });
  assert.equal(loaded?.backtestAcceptance, undefined);
  assert.equal(marketDataBacktestAccepted(loaded!), false);
});

test('acceptance writer rejects old active index provenance before creating an artifact', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-store-writer-provenance-'));
  const root = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeBuild(root, 'old-policy-index');
  const acceptance = await passingAcceptance(root);
  const activeManifest = JSON.parse(
    await readFile(join(root, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  activeManifest.estimatorPolicyVersion = ESTIMATOR_POLICY_VERSION - 1;
  await writeFile(join(root, 'manifest.json'), JSON.stringify(activeManifest));

  await assert.rejects(
    () => writeBacktestAcceptance(root, acceptance),
    /index policy provenance.*run update first/i,
  );
  await assert.rejects(() => readFile(backtestAcceptancePath(root)), { code: 'ENOENT' });
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
