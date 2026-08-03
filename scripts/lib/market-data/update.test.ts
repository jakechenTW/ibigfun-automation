import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  augmentParkingEvidenceCausally,
  ensureTaipeiMarketData,
  evaluateTaipeiMarketDataCandidate,
  withMarketDataLock,
} from './update.ts';
import {
  backtestAcceptancePath,
  loadMarketData,
  sha256File,
  writeBacktestAcceptance,
} from './store.ts';
import {
  ACTIVE_ESTIMATOR_POLICY,
  BACKTEST_ACCEPTANCE_THRESHOLDS,
  ESTIMATOR_POLICY_VERSION,
  MARKET_SCHEMA_VERSION,
} from './config.ts';
import type { MarketDataManifest, MarketTransaction } from './types.ts';

function parkingTransaction(
  id: string,
  transactionDate: string,
  grade: 'A' | 'B',
  parkingPriceNtd: number | null = grade === 'A' ? 2_000_000 : null,
  parkingAreaPing: number | null = grade === 'A' ? 10 : null,
): MarketTransaction {
  const totalPriceNtd = 12_000_000;
  const totalAreaPing = 40;
  const separable = grade === 'A';
  return {
    id,
    transactionDate,
    sourceVersion: 'fixture',
    originalAddress: '台北市信義區測試路1號',
    location: {
      method: 'exact-doorplate',
      coordinate: { lat: 25.033, lng: 121.565 },
      normalizedAddress: '台北市信義區測試路1號',
      matchedAddress: '台北市信義區測試路1號',
      uncertaintyMeters: 0,
      confidence: 'high',
      datasetVersion: 'fixture',
    },
    district: '信義區',
    ownership: 'freehold',
    buildingType: 'highrise',
    totalPriceNtd,
    totalAreaPing,
    buildingPriceNtd: separable ? totalPriceNtd - parkingPriceNtd! : null,
    buildingAreaPing: separable ? totalAreaPing - parkingAreaPing! : null,
    parkingPriceNtd,
    parkingAreaPing,
    buildingUnitPriceWan: separable
      ? (totalPriceNtd - parkingPriceNtd!) / (totalAreaPing - parkingAreaPing!) / 10_000
      : null,
    buildingUnitPriceBoundsWan: null,
    parkingEvidence: {
      grade,
      family: 'flat',
      originalType: '坡道平面',
      officialPriceNtd: parkingPriceNtd,
      officialAreaPing: parkingAreaPing,
      imputation: null,
      reasons: grade === 'A' ? [] : ['parking-area-unavailable', 'parking-price-unavailable'],
    },
    floor: 8,
    totalFloors: 20,
    floorGroup: 'middle',
    completionDate: '2010-01-01',
    notes: '',
    exclusionFlags: [],
    eligibility: grade === 'A' ? 'reliable-eligible' : 'review-only',
    eligibilityReasons: grade === 'A' ? [] : ['parking-not-separable'],
    originalPrimaryUse: '住家用',
    primaryUse: 'residential',
    transferredBuildingCount: 1,
    transferredParkingCount: 1,
  };
}

test('grade-B augmentation uses three prior grade-A pairs without same-date or future leakage', () => {
  const priorA = parkingTransaction('prior-a', '2025-10-01', 'A', 1_800_000, 9);
  const priorB = parkingTransaction('prior-b', '2025-11-01', 'A', 2_000_000, 10);
  const priorC = parkingTransaction('prior-c', '2025-12-01', 'A', 2_200_000, 11);
  const subject = parkingTransaction('subject-b', '2026-01-01', 'B');
  const sameDate = parkingTransaction('same-date-a', '2026-01-01', 'A');
  const future = parkingTransaction('future-a', '2026-02-01', 'A');

  const unresolved = augmentParkingEvidenceCausally([
    subject, sameDate, priorA, future, priorB,
  ]).find((transaction) => transaction.id === subject.id)!;
  assert.equal(unresolved.parkingEvidence.imputation, null);
  assert.equal(unresolved.buildingUnitPriceWan, null);

  const imputed = augmentParkingEvidenceCausally([
    subject, sameDate, priorA, future, priorB, priorC,
  ]);
  assert.deepEqual(imputed.map((transaction) => transaction.id), [
    'prior-a', 'prior-b', 'prior-c', 'same-date-a', 'subject-b', 'future-a',
  ]);
  const imputedSubject = imputed.find((transaction) => transaction.id === subject.id)!;
  assert.deepEqual(imputedSubject.parkingEvidence.imputation?.comparableIds, [
    'prior-a', 'prior-b', 'prior-c',
  ]);
  assert.ok(!imputedSubject.parkingEvidence.imputation?.comparableIds.includes('same-date-a'));
  assert.ok(!imputedSubject.parkingEvidence.imputation?.comparableIds.includes('future-a'));
  assert.equal(imputedSubject.parkingPriceNtd, 2_000_000);
  assert.equal(imputedSubject.parkingAreaPing, 10);
  assert.equal(imputedSubject.buildingPriceNtd, 10_000_000);
  assert.equal(imputedSubject.buildingAreaPing, 30);
  assert.ok(Math.abs((imputedSubject.buildingUnitPriceWan ?? 0) - (100 / 3)) < 1e-12);
  assert.ok(imputedSubject.buildingUnitPriceBoundsWan);
  assert.ok(imputedSubject.buildingUnitPriceBoundsWan!.p25
    <= imputedSubject.buildingUnitPriceBoundsWan!.p50);
  assert.ok(imputedSubject.buildingUnitPriceBoundsWan!.p50
    <= imputedSubject.buildingUnitPriceBoundsWan!.p75);
});

test('grade-B augmentation preserves an official parking price and imputes only count-scaled area', () => {
  const subject = parkingTransaction('price-known-b', '2026-01-01', 'B', 4_000_000, null);
  subject.transferredParkingCount = 2;
  subject.parkingEvidence.reasons = ['parking-area-unavailable'];
  const result = augmentParkingEvidenceCausally([
    parkingTransaction('prior-a', '2025-10-01', 'A', 1_800_000, 9),
    parkingTransaction('prior-b', '2025-11-01', 'A', 2_000_000, 10),
    parkingTransaction('prior-c', '2025-12-01', 'A', 2_200_000, 11),
    subject,
  ]).find((transaction) => transaction.id === subject.id)!;

  assert.equal(result.parkingEvidence.officialPriceNtd, 4_000_000);
  assert.equal(result.parkingPriceNtd, 4_000_000);
  assert.equal(result.parkingAreaPing, 20);
  assert.deepEqual(result.parkingEvidence.imputation?.pairP50, {
    priceNtd: 4_000_000,
    areaPing: 20,
  });
  assert.equal(result.buildingPriceNtd, 8_000_000);
  assert.equal(result.buildingAreaPing, 20);
});

test('grade-B augmentation preserves an official parking area and imputes only count-scaled price', () => {
  const subject = parkingTransaction('area-known-b', '2026-01-01', 'B', null, 20);
  subject.transferredParkingCount = 2;
  subject.parkingEvidence.reasons = ['parking-price-unavailable'];
  const result = augmentParkingEvidenceCausally([
    parkingTransaction('prior-a', '2025-10-01', 'A', 1_800_000, 9),
    parkingTransaction('prior-b', '2025-11-01', 'A', 2_000_000, 10),
    parkingTransaction('prior-c', '2025-12-01', 'A', 2_200_000, 11),
    subject,
  ]).find((transaction) => transaction.id === subject.id)!;

  assert.equal(result.parkingEvidence.officialAreaPing, 20);
  assert.equal(result.parkingAreaPing, 20);
  assert.equal(result.parkingPriceNtd, 4_000_000);
  assert.deepEqual(result.parkingEvidence.imputation?.pairP50, {
    priceNtd: 4_000_000,
    areaPing: 20,
  });
});

test('grade-B augmentation scales both imputed parking components by official transferred count', () => {
  const subject = parkingTransaction('both-missing-b', '2026-01-01', 'B');
  subject.transferredParkingCount = 2;
  const result = augmentParkingEvidenceCausally([
    parkingTransaction('prior-a', '2025-10-01', 'A', 1_800_000, 9),
    parkingTransaction('prior-b', '2025-11-01', 'A', 2_000_000, 10),
    parkingTransaction('prior-c', '2025-12-01', 'A', 2_200_000, 11),
    subject,
  ]).find((transaction) => transaction.id === subject.id)!;

  assert.equal(result.parkingPriceNtd, 4_000_000);
  assert.equal(result.parkingAreaPing, 20);
});

test('grade-B augmentation fails closed when official parking count is missing or zero', () => {
  const unknown = parkingTransaction('unknown-count-b', '2026-01-01', 'B');
  unknown.transferredParkingCount = null;
  const zero = parkingTransaction('zero-count-b', '2026-01-01', 'B');
  zero.transferredParkingCount = 0;
  const results = augmentParkingEvidenceCausally([
    parkingTransaction('prior-a', '2025-10-01', 'A', 1_800_000, 9),
    parkingTransaction('prior-b', '2025-11-01', 'A', 2_000_000, 10),
    parkingTransaction('prior-c', '2025-12-01', 'A', 2_200_000, 11),
    unknown,
    zero,
  ]);

  assert.equal(results.find((item) => item.id === unknown.id)?.parkingEvidence.imputation, null);
  assert.equal(results.find((item) => item.id === zero.id)?.parkingEvidence.imputation, null);
});

test('grade-B augmentation rejects parking estimates wider than the price IQR policy', () => {
  const subject = parkingTransaction('subject-b', '2026-01-01', 'B');
  const result = augmentParkingEvidenceCausally([
    parkingTransaction('prior-a', '2025-10-01', 'A', 1_000_000, 10),
    parkingTransaction('prior-b', '2025-11-01', 'A', 2_000_000, 10),
    parkingTransaction('prior-c', '2025-12-01', 'A', 8_000_000, 10),
    subject,
  ]).find((transaction) => transaction.id === subject.id)!;

  assert.equal(result.parkingEvidence.imputation, null);
  assert.equal(result.buildingUnitPriceWan, null);
});

test('grade-B augmentation rejects parking estimates wider than the area IQR policy', () => {
  const subject = parkingTransaction('subject-b', '2026-01-01', 'B');
  const result = augmentParkingEvidenceCausally([
    parkingTransaction('prior-a', '2025-10-01', 'A', 2_000_000, 5),
    parkingTransaction('prior-b', '2025-11-01', 'A', 2_000_000, 10),
    parkingTransaction('prior-c', '2025-12-01', 'A', 2_000_000, 30),
    subject,
  ]).find((transaction) => transaction.id === subject.id)!;

  assert.equal(result.parkingEvidence.imputation, null);
  assert.equal(result.buildingUnitPriceWan, null);
});

test('grade-B augmentation rejects an imputation with non-positive derived building price or area', () => {
  const priceSubject = {
    ...parkingTransaction('subject-b', '2026-01-01', 'B'),
    totalPriceNtd: 1_000_000,
  };
  const areaSubject = {
    ...parkingTransaction('subject-b', '2026-01-01', 'B'),
    totalAreaPing: 5,
  };
  const directPairs = [
    parkingTransaction('prior-a', '2025-10-01', 'A'),
    parkingTransaction('prior-b', '2025-11-01', 'A'),
    parkingTransaction('prior-c', '2025-12-01', 'A'),
  ];
  const priceResult = augmentParkingEvidenceCausally([
    ...directPairs, priceSubject,
  ]).find((transaction) => transaction.id === priceSubject.id)!;
  const areaResult = augmentParkingEvidenceCausally([
    ...directPairs, areaSubject,
  ]).find((transaction) => transaction.id === areaSubject.id)!;

  assert.equal(priceResult.parkingEvidence.imputation, null);
  assert.equal(priceResult.buildingPriceNtd, null);
  assert.equal(areaResult.parkingEvidence.imputation, null);
  assert.equal(areaResult.buildingAreaPing, null);
});

function productionPassingTransactionCsv(base: Buffer): Buffer {
  const rows = base.toString('utf8').trimEnd().split('\n');
  const transactionRows: string[] = [];
  for (let day = 0; day < 36; day += 1) {
    const date = new Date(Date.UTC(2025, 0, 1 + day));
    const rocDate = `${date.getUTCFullYear() - 1911}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
    transactionRows.push(
      `房地(土地+建物),台北市中正區測試路1段10號,${rocDate},五層,十層,華廈(10層含以下有電梯),1000101,100,30000000,300000,無車位,0,0,住家用,土地1建物1車位0,有,,G-H-${day}`,
    );
    transactionRows.push(
      `房地(土地+建物+車位),台北市中正區測試路1段10號,${rocDate},八層,十五層,住宅大樓(11層含以上有電梯),1000101,130,32000000,300000,坡道平面,30,2000000,住家用,土地1建物1車位1,有,,G-PF-${day}`,
    );
    transactionRows.push(
      `房地(土地+建物+車位),台北市中正區測試路1段10號,${rocDate},八層,十五層,住宅大樓(11層含以上有電梯),1000101,115,31000000,300000,升降機械,15,1000000,住家用,土地1建物1車位1,有,,G-PM-${day}`,
    );
    const totalPrice = [27_000_000, 30_000_000, 33_000_000][day % 3]!;
    transactionRows.push(
      `房地(土地+建物),台北市中正區測試路1段10號,${rocDate},三層,五層,公寓(5樓含以下無電梯),0900101,100,${totalPrice},${totalPrice / 100},無車位,0,0,住家用,土地1建物1車位0,無,,G-M-${day}`,
    );
  }
  for (let day = 0; day < 25; day += 1) {
    const date = new Date(Date.UTC(2025, 2, 1 + day));
    const rocDate = `${date.getUTCFullYear() - 1911}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
    transactionRows.push(
      `房地(土地+建物+車位),台北市中正區測試路1段10號,${rocDate},八層,十五層,住宅大樓(11層含以上有電梯),1000101,130,32000000,300000,坡道平面,0,0,辦公用,土地1建物1車位1,有,,G-B-${day}`,
    );
  }
  transactionRows.push(
    '房地(土地+建物+車位),台北市中正區測試路1段10號,1140326,八層,十五層,住宅大樓(11層含以上有電梯),1000101,130,32000000,300000,坡道平面,0,2000000,辦公用,土地1建物1車位1,有,,G-B-PRICE-ONLY',
  );
  transactionRows.push(
    '房地(土地+建物+車位),台北市中正區測試路1段10號,1140327,八層,十五層,住宅大樓(11層含以上有電梯),1000101,130,32000000,300000,坡道平面,30,0,辦公用,土地1建物1車位1,有,,G-B-AREA-ONLY',
  );
  for (let day = 0; day < 20; day += 1) {
    const date = new Date(Date.UTC(2025, 3, 1 + day));
    const rocDate = `${date.getUTCFullYear() - 1911}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
    transactionRows.push(
      `房地(土地+建物+車位),台北市中正區測試路1段10號,${rocDate},八層,十五層,住宅大樓(11層含以上有電梯),1000101,130,32000000,300000,坡道平面,30,2000000,辦公用,土地1建物1車位1,有,,G-OA-${day}`,
    );
  }
  return Buffer.from([...rows, ...transactionRows].join('\n'));
}

async function seedValidBuild(root: string): Promise<void> {
  await mkdir(join(root, 'raw'), { recursive: true });
  await writeFile(join(root, 'raw', 'source.csv'), 'fixture\n');
  await writeFile(join(root, 'doorplates-index.json'), JSON.stringify({ schemaVersion: MARKET_SCHEMA_VERSION, datasetVersion: 'd', byCanonicalAddress: {}, byRoad: {}, cells: { cell: [{ canonicalAddress: '台北市中正區測試路1號', coordinate: { lat: 25, lng: 121.5 }, district: '中正區', roadKey: 'r', mainNumber: 1, subNumber: null }] } }));
  await writeFile(join(root, 'transactions-index.json'), JSON.stringify({
    schemaVersion: MARKET_SCHEMA_VERSION,
    datasetVersion: 't',
    builtAt: '2026-07-01T00:00:00.000Z',
    cells: { cell: [parkingTransaction('tx-1', '2025-12-01', 'A')] },
  }));
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
      } as unknown as MarketDataManifest['transactions']['normalization'],
    },
    artifacts, lastFailure: null,
  };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
}

async function seedValidAcceptedBuild(root: string): Promise<void> {
  await seedValidBuild(root);
  await writeBacktestAcceptance(root, {
    schemaVersion: 2,
    estimatorPolicyVersion: ESTIMATOR_POLICY_VERSION,
    policyId: ACTIVE_ESTIMATOR_POLICY.id,
    transactionArtifactSha256: await sha256File(join(root, 'transactions-index.json')),
    approvedAt: '2026-07-26T01:00:00.000Z',
    asOf: '2026-07-25',
    evaluatedThrough: '2026-07-25',
    latestEligibleTransactionDate: '2025-12-01',
    thresholds: { ...BACKTEST_ACCEPTANCE_THRESHOLDS },
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
  });
}

test('production ensure is load-only and leaves the accepted pair byte-identical', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-safe-stop-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  await seedValidAcceptedBuild(rootPath);
  const beforeManifest = await readFile(join(rootPath, 'manifest.json'));
  const beforeTransactions = await readFile(join(rootPath, 'transactions-index.json'));
  const beforeAcceptance = await readFile(backtestAcceptancePath(rootPath));
  let fetchCalls = 0;
  let publisherCalls = 0;

  const bundle = await ensureTaipeiMarketData({
    asOf: '2026-07-25',
    rootPath,
    minDoorplates: 1,
    minTransactions: 1,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('production ensure must not fetch');
    },
    gateEvaluator: () => ({ passed: false, complete: true, reasons: ['injected-candidate-failure'] }),
    publisher: async () => {
      publisherCalls += 1;
      throw new Error('production ensure must not publish');
    },
  });

  assert.equal(bundle?.manifest.buildId, 'known-good');
  assert.equal(bundle?.refresh?.status, 'last-known-good');
  assert.equal(bundle?.refresh?.failure, 'challenger-activation-withheld');
  assert.equal(fetchCalls, 0);
  assert.equal(publisherCalls, 0);
  assert.deepEqual(await readFile(join(rootPath, 'manifest.json')), beforeManifest);
  assert.deepEqual(await readFile(join(rootPath, 'transactions-index.json')), beforeTransactions);
  assert.deepEqual(await readFile(backtestAcceptancePath(rootPath)), beforeAcceptance);
});

test('candidate evaluation rejects every publish request before doing work', async () => {
  await assert.rejects(
    () => evaluateTaipeiMarketDataCandidate({
      asOf: '2026-07-25',
      policy: ACTIVE_ESTIMATOR_POLICY,
      publish: true,
    }),
    /challenger activation is withheld/i,
  );
});

async function downgradeAcceptedBuild(
  root: string,
  schemaVersion: 1 | 2 | 4,
): Promise<string> {
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
  if (schemaVersion === 4) legacyManifest.estimatorPolicyVersion = 5;
  else delete legacyManifest.estimatorPolicyVersion;
  if (schemaVersion === 1) {
    delete legacyManifest.transactions.normalization;
  } else if (schemaVersion === 2) {
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

  const transactionChecksum =
    legacyManifest.artifacts['transactions-index.json']!.sha256;
  const acceptance = JSON.parse(
    await readFile(backtestAcceptancePath(root), 'utf8'),
  ) as { transactionArtifactSha256: string };
  acceptance.transactionArtifactSha256 = transactionChecksum;
  await writeFile(
    backtestAcceptancePath(root),
    `${JSON.stringify(acceptance)}\n`,
  );
  return transactionChecksum;
}

async function candidateFixtureInputs(): Promise<{
  fetch: (input: string | URL) => Promise<Response>;
  openZip: (file: string) => Promise<Array<{ path: string; stream: () => Readable }>>;
}> {
  const doorplateCsv = await readFile(
    fileURLToPath(new URL('./fixtures/doorplates.csv', import.meta.url)),
  );
  const transactionCsv = await readFile(
    fileURLToPath(new URL('./fixtures/transactions.csv', import.meta.url)),
  );
  const passingTransactionCsv = productionPassingTransactionCsv(transactionCsv);
  const headersOnlyCsv = Buffer.from(
    transactionCsv.toString('utf8').split('\n').slice(0, 2).join('\n'),
  );
  const detail =
    '<a href="https://example.test/resource.download?rid=one&amp;fileName=doorplates.csv">doorplates.csv</a>';
  return {
    fetch: async (input) => String(input).includes('dataset/detail')
      ? new Response(detail)
      : String(input).includes('resource.download')
        ? new Response(doorplateCsv)
        : new Response('synthetic zip'),
    openZip: async (file) => [{
      path: 'a_lvr_land_a.csv',
      stream: () => Readable.from(
        file.endsWith('/115S2.zip') ? passingTransactionCsv : headersOnlyCsv,
      ),
    }],
  };
}

test('load-only ensure returns null without fetching when production has no valid build', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-empty-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  const events: string[] = [];
  let fetchCalls = 0;
  const bundle = await ensureTaipeiMarketData({
    asOf: '2026-07-25',
    rootPath,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('must not fetch');
    },
    logger: { event: (_level, event) => events.push(event) },
  });
  assert.equal(bundle, null);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(events, ['market-data.unavailable']);
});

test('load-only ensure retains a valid active build with the explicit freeze warning', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-frozen-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  await seedValidBuild(rootPath);
  const events: string[] = [];
  const bundle = await ensureTaipeiMarketData({
    asOf: '2026-07-25',
    rootPath,
    minDoorplates: 1,
    minTransactions: 1,
    logger: { event: (_level, event) => events.push(event) },
  });
  assert.equal(bundle?.manifest.buildId, 'known-good');
  assert.equal(bundle?.refresh?.status, 'last-known-good');
  assert.equal(bundle?.refresh?.failure, 'challenger-activation-withheld');
  assert.deepEqual(events, ['market-data.last-known-good']);
});

test('candidate evaluation builds schema-5 evidence in an isolated disposable stage', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-candidate-isolated-'));
  const rootPath = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  const fixture = await candidateFixtureInputs();
  const evaluation = await evaluateTaipeiMarketDataCandidate({
    asOf: '2026-07-25',
    policy: ACTIVE_ESTIMATOR_POLICY,
    publish: false,
    rootPath,
    minDoorplates: 1,
    minTransactions: 1,
    fetch: fixture.fetch,
    openZip: fixture.openZip,
    clock: () => new Date('2026-07-25T01:00:00.000Z'),
  });

  assert.equal(evaluation.gate.passed, true);
  assert.equal(evaluation.acceptance?.schemaVersion, 3);
  assert.equal(evaluation.acceptance?.estimatorPolicyVersion, 6);
  assert.deepEqual(evaluation.diagnostics.gradeBByComponent, {
    missingBoth: 25,
    officialAreaOnly: 1,
    officialPriceOnly: 1,
  });
  assert.doesNotMatch(JSON.stringify(evaluation.diagnostics), /G-B-|測試路|address|caseIds/i);
  assert.deepEqual(await readdir(parent), []);
});

test('failed candidate gate never publishes and leaves production bytes unchanged', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'market-candidate-failed-'));
  const rootPath = join(parent, 'taipei');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await seedValidAcceptedBuild(rootPath);
  const fixture = await candidateFixtureInputs();
  const beforeManifest = await readFile(join(rootPath, 'manifest.json'));
  const beforeTransactions = await readFile(join(rootPath, 'transactions-index.json'));
  const beforeAcceptance = await readFile(backtestAcceptancePath(rootPath));
  let publisherCalls = 0;

  const evaluation = await evaluateTaipeiMarketDataCandidate({
    asOf: '2026-07-25',
    policy: ACTIVE_ESTIMATOR_POLICY,
    publish: false,
    rootPath,
    minDoorplates: 1,
    minTransactions: 1,
    fetch: fixture.fetch,
    openZip: fixture.openZip,
    gateEvaluator: () => ({
      passed: false,
      complete: true,
      reasons: ['injected-candidate-failure'],
    }),
    publisher: async () => {
      publisherCalls += 1;
      throw new Error('candidate publisher must never run');
    },
  });

  assert.deepEqual(evaluation.gate, {
    passed: false,
    complete: true,
    reasons: ['injected-candidate-failure'],
  });
  assert.equal(evaluation.acceptance, null);
  assert.equal(publisherCalls, 0);
  assert.deepEqual(await readFile(join(rootPath, 'manifest.json')), beforeManifest);
  assert.deepEqual(await readFile(join(rootPath, 'transactions-index.json')), beforeTransactions);
  assert.deepEqual(await readFile(backtestAcceptancePath(rootPath)), beforeAcceptance);
  assert.equal(
    (await loadMarketData(rootPath, { minDoorplates: 1, minTransactions: 1 }))?.manifest.buildId,
    'known-good',
  );
  assert.deepEqual((await readdir(parent)).sort(), [
    'taipei',
    'taipei-backtest-acceptance.json',
  ]);
});

test('load-only ensure never migrates schema-1, schema-2, or schema-4 state', async (t) => {
  for (const schemaVersion of [1, 2, 4] as const) {
    await t.test(`schema ${schemaVersion}`, async (t) => {
      const parent = await mkdtemp(join(tmpdir(), `market-no-migrate-${schemaVersion}-`));
      const rootPath = join(parent, 'taipei');
      t.after(() => rm(parent, { recursive: true, force: true }));
      await seedValidAcceptedBuild(rootPath);
      await downgradeAcceptedBuild(rootPath, schemaVersion);
      const beforeManifest = await readFile(join(rootPath, 'manifest.json'));
      const beforeAcceptance = await readFile(backtestAcceptancePath(rootPath));
      let fetchCalls = 0;
      const bundle = await ensureTaipeiMarketData({
        asOf: '2026-07-25',
        rootPath,
        minDoorplates: 1,
        minTransactions: 1,
        fetch: async () => {
          fetchCalls += 1;
          throw new Error('must not fetch');
        },
      });
      assert.equal(bundle, null);
      assert.equal(fetchCalls, 0);
      assert.deepEqual(await readFile(join(rootPath, 'manifest.json')), beforeManifest);
      assert.deepEqual(await readFile(backtestAcceptancePath(rootPath)), beforeAcceptance);
    });
  }
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
