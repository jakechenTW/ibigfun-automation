import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import type { Logger } from '../journal.ts';
import { deriveBuildingValues, relativeIqrRatio } from './arithmetic.ts';
import {
  backtestCandidateTransactions,
  candidateBacktestAcceptance,
  evaluateCandidateBacktestGate,
  type BacktestGateResult,
  type CandidateBacktestReport,
} from './backtest.ts';
import { buildDoorplateIndex } from './doorplates.ts';
import { gridKey } from './grid.ts';
import {
  CANDIDATE_ESTIMATOR_POLICY_VERSION,
  CANDIDATE_MARKET_SCHEMA_VERSION,
  ACTIVE_ESTIMATOR_POLICY,
  MARKET_DATA_ROOT,
  PARKING_POLICY,
  type EstimatorPolicy,
} from './config.ts';
import { estimateParking } from './parking.ts';
import { weightedQuantile } from './statistics.ts';
import { extractTaipeiSalesCsv, downloadConditional, moiSeasonUrl, quartersForLookback, resolveTaipeiDoorplateSource, TAIPEI_DOORPLATE_DETAIL_URL, type FetchLike, type ZipEntry, zipEntriesFromFile } from './sources.ts';
import {
  compareStableText,
  countIndexEntries,
  loadMarketData,
  publishStagedBuildWithAcceptance,
  recoverInterruptedMarketDataPublication,
  assertNoPendingMarketDataPublication,
  sha256File,
  validateCandidateStagedBuild,
  writeStableJson,
} from './store.ts';
import { normalizeSaleTransaction, validateSaleTransactionHeaders, type SaleTransactionRow } from './transactions.ts';
import { NORMALIZED_PRIMARY_USES, PARKING_GRADES } from './types.ts';
import type {
  CandidateBacktestAcceptance,
  DoorplateIndex,
  MarketDataBundle,
  MarketDataManifest,
  MarketTransaction,
  NormalizedPrimaryUse,
  ParkingGrade,
  ParkingImputationEvidence,
  ParkingPriceAreaPair,
  TransactionBuildDiagnostics,
  TransactionIndex,
} from './types.ts';

export interface EnsureTaipeiMarketDataOptions {
  asOf: string;
  rootPath?: string;
  fetch?: FetchLike;
  clock?: () => Date;
  logger?: Pick<Logger, 'event'>;
  minDoorplates?: number;
  minTransactions?: number;
  openZip?: (file: string) => Promise<ZipEntry[]>;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  lockPollMs?: number;
  /** Test seam may reject or throw, but cannot override the candidate gate. */
  gateEvaluator?: (report: CandidateBacktestReport) => BacktestGateResult;
  publisher?: typeof publishStagedBuildWithAcceptance;
}

export interface CandidateEvaluation {
  report: CandidateBacktestReport;
  gate: BacktestGateResult;
  acceptance: CandidateBacktestAcceptance | null;
  diagnostics: TransactionBuildDiagnostics;
}

export interface EvaluateTaipeiMarketDataCandidateOptions {
  asOf: string;
  policy: EstimatorPolicy;
  publish: boolean;
  gateEvaluator?: (report: CandidateBacktestReport) => BacktestGateResult;
  rootPath?: string;
  fetch?: FetchLike;
  clock?: () => Date;
  logger?: Pick<Logger, 'event'>;
  minDoorplates?: number;
  minTransactions?: number;
  openZip?: (file: string) => Promise<ZipEntry[]>;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  lockPollMs?: number;
  /** Test seam retained to prove candidate evaluation never invokes publication. */
  publisher?: typeof publishStagedBuildWithAcceptance;
}

interface CandidateExecution {
  policy: EstimatorPolicy;
  rethrowErrors: boolean;
  publish: boolean;
  capture?: { evaluation?: CandidateEvaluation };
}

export interface MarketDataLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
  writeOwner?: (ownerPath: string, owner: string) => Promise<void>;
}

function nowIso(clock: () => Date): string { return clock().toISOString(); }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function currentSeason(asOf: string): string { return quartersForLookback(asOf, 0)[0]!; }
function priorSeason(asOf: string): string { return quartersForLookback(asOf, 3)[0]!; }
function log(logger: EnsureTaipeiMarketDataOptions['logger'], level: 'info' | 'warn' | 'error', event: string, msg: string, data?: unknown): void {
  logger?.event(level, event, msg, data);
}

/** Serializes refresh/publication while safely recovering abandoned lock directories. */
export async function withMarketDataLock<T>(
  root: string,
  operation: () => Promise<T>,
  options: MarketDataLockOptions = {},
): Promise<T> {
  const lockPath = path.join(path.dirname(root), `.${path.basename(root)}-refresh.lock`);
  const ownerPath = path.join(lockPath, 'owner');
  const owner = `${process.pid}-${randomUUID()}`;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const staleMs = options.staleMs ?? 30 * 60_000;
  const pollMs = options.pollMs ?? 50;
  const heartbeatMs = Math.max(10, Math.floor(staleMs / 3));
  const validPositive = (value: number) => Number.isFinite(value) && value > 0;
  if (!validPositive(timeoutMs) || !validPositive(staleMs) || !validPositive(pollMs) ||
      staleMs < 30 || heartbeatMs * 2 >= staleMs || pollMs > timeoutMs) {
    throw new RangeError('Invalid market-data lock timing relationship');
  }
  const writeOwner = options.writeOwner ??
    ((file: string, value: string) => fs.writeFile(file, value, { flag: 'wx' }));
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(root), { recursive: true });
  for (;;) {
    let created = false;
    try {
      await fs.mkdir(lockPath);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          const confirmed = await fs.stat(lockPath);
          if (confirmed.ino === stat.ino && confirmed.mtimeMs === stat.mtimeMs &&
              Date.now() - confirmed.mtimeMs > staleMs) {
            await fs.rm(lockPath, { recursive: true, force: true });
            continue;
          }
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for market-data refresh lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!created) continue;
    try {
      await writeOwner(ownerPath, owner);
    } catch (error) {
      await fs.rm(lockPath, { recursive: true, force: true });
      throw error;
    }
    break;
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs.utimes(lockPath, now, now).catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    try {
      if (await fs.readFile(ownerPath, 'utf8') === owner) {
        await fs.rm(lockPath, { recursive: true, force: true });
      }
    } catch { /* a stale-lock successor owns cleanup */ }
  }
}

async function artifactManifest(root: string): Promise<Record<string, { sha256: string; bytes: number }>> {
  const out: Record<string, { sha256: string; bytes: number }> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const relative = path.relative(root, full);
        out[relative] = { sha256: await sha256File(full), bytes: (await fs.stat(full)).size };
      }
    }
  }
  await walk(root);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => compareStableText(a, b)));
}

interface AcceptedParkingImputation {
  imputation: ParkingImputationEvidence;
  parkingPriceNtd: number;
  parkingAreaPing: number;
  buildingPriceNtd: number;
  buildingAreaPing: number;
  buildingUnitPriceWan: number;
  buildingUnitPriceBoundsWan: NonNullable<MarketTransaction['buildingUnitPriceBoundsWan']>;
}

function acceptedParkingImputation(
  transaction: MarketTransaction,
  directGradeA: readonly MarketTransaction[],
): AcceptedParkingImputation | null {
  const coordinate = transaction.location.coordinate;
  const family = transaction.parkingEvidence.family;
  const count = transaction.transferredParkingCount;
  if (!coordinate || (family !== 'flat' && family !== 'mechanical')
    || !Number.isSafeInteger(count) || count === null || count <= 0) return null;
  const officialPrice = transaction.parkingEvidence.officialPriceNtd;
  const officialArea = transaction.parkingEvidence.officialAreaPing;
  const estimate = estimateParking({
    coordinate,
    matchedAddress: transaction.location.matchedAddress,
    buildingType: transaction.buildingType,
    family,
    knownPriceNtd: officialPrice === null ? null : officialPrice / count,
    knownAreaPing: officialArea === null ? null : officialArea / count,
  }, directGradeA, transaction.transactionDate);
  if (!estimate) return null;

  const finalPair = (pair: ParkingPriceAreaPair): ParkingPriceAreaPair => ({
    priceNtd: officialPrice ?? pair.priceNtd * count,
    areaPing: officialArea ?? pair.areaPing * count,
  });
  const pairP25 = finalPair(estimate.pairP25);
  const pairP50 = finalPair(estimate.pairP50);
  const pairP75 = finalPair(estimate.pairP75);
  const finalPairs = estimate.directPairs.map((pair) => ({
    id: pair.id,
    ...finalPair(pair),
    weight: pair.weight,
  }));
  const componentQuantile = (component: 'priceNtd' | 'areaPing', quantile: number): number => weightedQuantile(
    finalPairs.map((pair) => ({ id: pair.id, value: pair[component], weight: pair.weight })),
    quantile,
  );
  const priceP25Ntd = Math.min(componentQuantile('priceNtd', 0.25), pairP50.priceNtd);
  const priceP75Ntd = Math.max(componentQuantile('priceNtd', 0.75), pairP50.priceNtd);
  const areaP25Ping = Math.min(componentQuantile('areaPing', 0.25), pairP50.areaPing);
  const areaP75Ping = Math.max(componentQuantile('areaPing', 0.75), pairP50.areaPing);
  const priceIqrRatio = relativeIqrRatio(priceP25Ntd, pairP50.priceNtd, priceP75Ntd);
  const areaIqrRatio = relativeIqrRatio(areaP25Ping, pairP50.areaPing, areaP75Ping);
  const buildingObservations = finalPairs.flatMap((pair) => {
    const buildingPriceNtd = transaction.totalPriceNtd - pair.priceNtd;
    const buildingAreaPing = transaction.totalAreaPing - pair.areaPing;
    const unitPriceWan = buildingPriceNtd / buildingAreaPing / 10_000;
    return buildingPriceNtd > 0 && buildingAreaPing > 0 && Number.isFinite(unitPriceWan) && unitPriceWan > 0
      ? [{ id: pair.id, value: unitPriceWan, weight: pair.weight }]
      : [];
  });
  if (buildingObservations.length !== finalPairs.length) return null;
  const { buildingPriceNtd, buildingAreaPing, buildingUnitPriceWan } = deriveBuildingValues(
    transaction.totalPriceNtd,
    transaction.totalAreaPing,
    pairP50.priceNtd,
    pairP50.areaPing,
  );
  const p25 = Math.min(weightedQuantile(buildingObservations, 0.25), buildingUnitPriceWan);
  const p75 = Math.max(weightedQuantile(buildingObservations, 0.75), buildingUnitPriceWan);
  const buildingIqrRatio = relativeIqrRatio(p25, buildingUnitPriceWan, p75);
  if (buildingPriceNtd <= 0 || buildingAreaPing <= 0
      || !Number.isFinite(priceIqrRatio) || priceIqrRatio > PARKING_POLICY.maximumPriceIqrRatio
      || !Number.isFinite(areaIqrRatio) || areaIqrRatio > PARKING_POLICY.maximumAreaIqrRatio
      || !Number.isFinite(buildingIqrRatio)
      || buildingIqrRatio > PARKING_POLICY.maximumBuildingUnitPriceIqrRatio) {
    return null;
  }
  return {
    imputation: {
      asOf: estimate.asOf,
      stage: estimate.stage,
      comparableIds: estimate.comparableIds,
      comparableCount: estimate.comparableCount,
      priceP25Ntd,
      priceP50Ntd: pairP50.priceNtd,
      priceP75Ntd,
      areaP25Ping,
      areaP50Ping: pairP50.areaPing,
      areaP75Ping,
      pairP25,
      pairP50,
      pairP75,
      priceIqrRatio,
      areaIqrRatio,
    },
    parkingPriceNtd: pairP50.priceNtd,
    parkingAreaPing: pairP50.areaPing,
    buildingPriceNtd,
    buildingAreaPing,
    buildingUnitPriceWan,
    buildingUnitPriceBoundsWan: { p25, p50: buildingUnitPriceWan, p75, relativeIqrRatio: buildingIqrRatio },
  };
}

/** Imputes grade-B parking from strictly earlier direct grade-A records. */
export function augmentParkingEvidenceCausally(
  transactions: readonly MarketTransaction[],
): MarketTransaction[] {
  const chronological = [...transactions].sort((left, right) =>
    compareStableText(left.transactionDate, right.transactionDate)
      || compareStableText(left.id, right.id));
  const directGradeA: MarketTransaction[] = [];
  const augmented: MarketTransaction[] = [];

  for (let start = 0; start < chronological.length;) {
    const transactionDate = chronological[start]!.transactionDate;
    let end = start + 1;
    while (end < chronological.length && chronological[end]!.transactionDate === transactionDate) end += 1;
    const dateGroup = chronological.slice(start, end);
    for (const transaction of dateGroup) {
      if (transaction.parkingEvidence.grade !== 'B') {
        augmented.push(transaction);
        continue;
      }
      const accepted = acceptedParkingImputation(transaction, directGradeA);
      if (!accepted) {
        augmented.push(transaction);
        continue;
      }
      augmented.push({
        ...transaction,
        parkingEvidence: { ...transaction.parkingEvidence, imputation: accepted.imputation },
        parkingPriceNtd: accepted.parkingPriceNtd,
        parkingAreaPing: accepted.parkingAreaPing,
        buildingPriceNtd: accepted.buildingPriceNtd,
        buildingAreaPing: accepted.buildingAreaPing,
        buildingUnitPriceWan: accepted.buildingUnitPriceWan,
        buildingUnitPriceBoundsWan: accepted.buildingUnitPriceBoundsWan,
      });
    }
    directGradeA.push(...dateGroup.filter((transaction) => transaction.parkingEvidence.grade === 'A'));
    start = end;
  }
  return augmented;
}

async function addTransactionCsv(
  input: NodeJS.ReadableStream,
  doorplates: DoorplateIndex,
  transactions: MarketTransaction[],
): Promise<TransactionBuildDiagnostics> {
  const sourcePath = (input as NodeJS.ReadableStream & { path?: string | Buffer }).path;
  const sourceVersion = typeof sourcePath === 'string'
    ? path.basename(sourcePath, path.extname(sourcePath))
    : 'unknown';
  const diagnostics: TransactionBuildDiagnostics = {
    rawRows: 0,
    reliableEligible: 0,
    reviewOnly: 0,
    excluded: 0,
    excludedByReason: {},
    byPrimaryUse: emptyPrimaryUseCounts(),
    byParkingGrade: emptyParkingGradeCounts(),
    gradeBByComponent: emptyGradeBComponentCounts(),
    gradeBImputed: 0,
    gradeBUnresolved: 0,
  };
  const parser = input.pipe(parse({ bom: true, columns: true, skip_empty_lines: true, trim: true }));
  let checkedHeaders = false;
  for await (const row of parser as AsyncIterable<SaleTransactionRow>) {
    if (!checkedHeaders) { validateSaleTransactionHeaders(Object.keys(row)); checkedHeaders = true; }
    const normalized = normalizeSaleTransaction(row, { doorplates, sourceVersion });
    if (normalized.kind === 'excluded' && normalized.reasons.includes('non-data-row')) continue;
    diagnostics.rawRows += 1;
    if (normalized.kind === 'excluded') {
      diagnostics.excluded += 1;
      const primaryReason = normalized.reasons[0] ?? 'unspecified';
      diagnostics.excludedByReason[primaryReason] =
        (diagnostics.excludedByReason[primaryReason] ?? 0) + 1;
      continue;
    }
    transactions.push(normalized.transaction);
    diagnostics.byPrimaryUse[normalized.transaction.primaryUse] += 1;
    diagnostics.byParkingGrade[normalized.transaction.parkingEvidence.grade] += 1;
    if (normalized.transaction.parkingEvidence.grade === 'B') {
      const hasOfficialPrice = normalized.transaction.parkingEvidence.officialPriceNtd !== null;
      const hasOfficialArea = normalized.transaction.parkingEvidence.officialAreaPing !== null;
      if (hasOfficialPrice && !hasOfficialArea) {
        diagnostics.gradeBByComponent.officialPriceOnly += 1;
      } else if (!hasOfficialPrice && hasOfficialArea) {
        diagnostics.gradeBByComponent.officialAreaOnly += 1;
      } else if (!hasOfficialPrice && !hasOfficialArea) {
        diagnostics.gradeBByComponent.missingBoth += 1;
      }
    }
    if (normalized.transaction.eligibility === 'reliable-eligible') diagnostics.reliableEligible += 1;
    else diagnostics.reviewOnly += 1;
  }
  if (!checkedHeaders) throw new Error(`MOI ${sourceVersion} CSV has no data rows or headers`);
  diagnostics.excludedByReason = Object.fromEntries(
    Object.entries(diagnostics.excludedByReason).sort(([left], [right]) => compareStableText(left, right)),
  );
  return diagnostics;
}

function emptyPrimaryUseCounts(): Record<NormalizedPrimaryUse, number> {
  return Object.fromEntries(NORMALIZED_PRIMARY_USES.map((key) => [key, 0])) as Record<NormalizedPrimaryUse, number>;
}

function emptyParkingGradeCounts(): Record<ParkingGrade, number> {
  return Object.fromEntries(PARKING_GRADES.map((key) => [key, 0])) as Record<ParkingGrade, number>;
}

function emptyGradeBComponentCounts(): TransactionBuildDiagnostics['gradeBByComponent'] {
  return { missingBoth: 0, officialAreaOnly: 0, officialPriceOnly: 0 };
}

function emptyTransactionBuildDiagnostics(): TransactionBuildDiagnostics {
  return {
    rawRows: 0,
    reliableEligible: 0,
    reviewOnly: 0,
    excluded: 0,
    excludedByReason: {},
    byPrimaryUse: emptyPrimaryUseCounts(),
    byParkingGrade: emptyParkingGradeCounts(),
    gradeBByComponent: emptyGradeBComponentCounts(),
    gradeBImputed: 0,
    gradeBUnresolved: 0,
  };
}

function mergeTransactionBuildDiagnostics(
  aggregate: TransactionBuildDiagnostics,
  next: TransactionBuildDiagnostics,
): void {
  aggregate.rawRows += next.rawRows;
  aggregate.reliableEligible += next.reliableEligible;
  aggregate.reviewOnly += next.reviewOnly;
  aggregate.excluded += next.excluded;
  for (const use of NORMALIZED_PRIMARY_USES) aggregate.byPrimaryUse[use] += next.byPrimaryUse[use];
  for (const grade of PARKING_GRADES) aggregate.byParkingGrade[grade] += next.byParkingGrade[grade];
  for (const component of ['missingBoth', 'officialAreaOnly', 'officialPriceOnly'] as const) {
    aggregate.gradeBByComponent[component] += next.gradeBByComponent[component];
  }
  for (const [reason, count] of Object.entries(next.excludedByReason)) {
    aggregate.excludedByReason[reason] = (aggregate.excludedByReason[reason] ?? 0) + count;
  }
  aggregate.excludedByReason = Object.fromEntries(
    Object.entries(aggregate.excludedByReason).sort(([left], [right]) => compareStableText(left, right)),
  );
}

function finishTransactionIndex(
  cells: TransactionIndex['cells'],
  builtAt: string,
  datasetVersion: string,
  schemaVersion: number,
): TransactionIndex {
  const sortedCells = Object.fromEntries(Object.entries(cells).sort(([a], [b]) => compareStableText(a, b))
    .map(([key, values]) => [key, values.sort((a, b) => compareStableText(a.id, b.id))]));
  return { schemaVersion, datasetVersion, builtAt, cells: sortedCells };
}

/**
 * Refreshes official sources into a sibling staging directory. Any source or
 * validation failure leaves the active build untouched and returns it instead.
 */
async function evaluateTaipeiMarketDataCandidateUnlocked(
  options: EnsureTaipeiMarketDataOptions,
  execution: CandidateExecution,
): Promise<MarketDataBundle | null> {
  const root = options.rootPath ?? MARKET_DATA_ROOT;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? (() => new Date());
  const openZip = options.openZip ?? zipEntriesFromFile;
  await assertNoPendingMarketDataPublication(root);
  const existing = await loadMarketData(root, {
    minDoorplates: options.minDoorplates,
    minTransactions: options.minTransactions,
  });
  log(options.logger, 'info', 'market-data.check', 'checking Taipei official market-data sources', { activeBuildId: existing?.manifest.buildId ?? null });
  const stageParent = path.dirname(root);
  let stage: string | null = null;
  try {
    await fs.mkdir(stageParent, { recursive: true });
    stage = await fs.mkdtemp(path.join(stageParent, `.${path.basename(root)}-staging-`));
    const rawRoot = path.join(stage, 'raw');
    const detailPath = path.join(rawRoot, 'doorplate-detail.html');
    const detail = await downloadConditional(fetcher, TAIPEI_DOORPLATE_DETAIL_URL, {}, detailPath);
    if (detail.kind === 'not-modified' && !existing) throw new Error('Doorplate detail returned not-modified without an active build');
    if (detail.kind === 'not-modified') log(options.logger, 'info', 'market-data.not-modified', 'doorplate detail was not modified');
    const doorplateSource = detail.kind === 'downloaded'
      ? resolveTaipeiDoorplateSource(await fs.readFile(detailPath, 'utf8'))
      : { url: existing!.manifest.doorplates.sourceUrl, publishedAt: existing!.manifest.doorplates.publishedAt };
    const oldDoorplate = existing?.manifest.doorplates;
    const doorplatePath = path.join(rawRoot, 'doorplates.csv');
    const doorplate = await downloadConditional(fetcher, doorplateSource.url, {
      etag: oldDoorplate?.etag,
      lastModified: oldDoorplate?.lastModified,
    }, doorplatePath);
    if (doorplate.kind === 'not-modified') await fs.copyFile(path.join(root, 'raw', 'doorplates.csv'), doorplatePath);
    const doorplateSha = await sha256File(doorplatePath);
    const seasons = quartersForLookback(options.asOf, 36);
    const activeSeason = currentSeason(options.asOf);
    const mutableSeasons = new Set([activeSeason, priorSeason(options.asOf)]);
    const sourceVersions: NonNullable<MarketDataManifest['transactionSources']> = {};
    const stagedCsvPaths: Array<{ season: string; path: string }> = [];
    for (const season of seasons) {
      const old = existing?.manifest.transactionSources?.[season];
      const stagedCsvPath = path.join(rawRoot, 'transactions', `${season}.csv`);
      const rawPath = path.join(root, 'raw', 'transactions', `${season}.csv`);
      if (!mutableSeasons.has(season) && old) {
        try {
          if (await sha256File(rawPath) === old.sha256) {
            await fs.mkdir(path.dirname(stagedCsvPath), { recursive: true });
            await fs.copyFile(rawPath, stagedCsvPath);
            sourceVersions[season] = old;
            stagedCsvPaths.push({ season, path: stagedCsvPath });
            continue;
          }
        } catch { /* source will be re-downloaded */ }
      }
      try {
        const zipPath = path.join(rawRoot, 'transactions', `${season}.zip`);
        const downloaded = await downloadConditional(fetcher, moiSeasonUrl(season), old, zipPath);
        if (downloaded.kind === 'not-modified') {
          await fs.mkdir(path.dirname(stagedCsvPath), { recursive: true });
          await fs.copyFile(rawPath, stagedCsvPath);
        } else {
          await extractTaipeiSalesCsv(await openZip(zipPath), stagedCsvPath);
        }
        const csvSha = await sha256File(stagedCsvPath);
        sourceVersions[season] = {
          url: moiSeasonUrl(season), sha256: csvSha,
          etag: downloaded.etag ?? old?.etag ?? null,
          lastModified: downloaded.lastModified ?? old?.lastModified ?? null,
        };
        stagedCsvPaths.push({ season, path: stagedCsvPath });
      } catch (error) {
        if (season !== activeSeason || old || !(error instanceof Error) || error.message !== 'FILE_ENDED') {
          throw error;
        }
        log(options.logger, 'warn', 'market-data.current-season-unavailable',
          'current MOI transaction season is not published; using completed seasons', {
            season,
            reason: error instanceof Error ? error.message : String(error),
          });
      }
    }

    const builtAt = nowIso(clock);
    const doorplates = await buildDoorplateIndex(
      createReadStream(doorplatePath),
      doorplateSha,
      CANDIDATE_MARKET_SCHEMA_VERSION,
    );
    const normalizedTransactions: MarketTransaction[] = [];
    const normalization = emptyTransactionBuildDiagnostics();
    for (const source of stagedCsvPaths) {
      mergeTransactionBuildDiagnostics(
        normalization,
        await addTransactionCsv(createReadStream(source.path), doorplates, normalizedTransactions),
      );
    }
    const augmentedTransactions = augmentParkingEvidenceCausally(normalizedTransactions);
    normalization.gradeBImputed = augmentedTransactions.filter((transaction) =>
      transaction.parkingEvidence.grade === 'B' && transaction.parkingEvidence.imputation !== null,
    ).length;
    normalization.gradeBUnresolved = normalization.byParkingGrade.B - normalization.gradeBImputed;
    const transactionCells: TransactionIndex['cells'] = {};
    for (const transaction of augmentedTransactions) {
      (transactionCells[gridKey(transaction.location.coordinate!)] ??= []).push(transaction);
    }
    const transactionCount = normalization.reliableEligible + normalization.reviewOnly;
    const transactions = finishTransactionIndex(
      transactionCells,
      builtAt,
      sha256(stagedCsvPaths.map(({ season }) => `${season}:${sourceVersions[season]!.sha256}`).join('\n')),
      CANDIDATE_MARKET_SCHEMA_VERSION,
    );
    await writeStableJson(path.join(stage, 'doorplates-index.json'), doorplates);
    await writeStableJson(path.join(stage, 'transactions-index.json'), transactions);
    const manifest: MarketDataManifest = {
      schemaVersion: CANDIDATE_MARKET_SCHEMA_VERSION,
      estimatorPolicyVersion: CANDIDATE_ESTIMATOR_POLICY_VERSION,
      buildId: `taipei-${builtAt.replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`,
      builtAt,
      doorplates: {
        sourceUrl: doorplateSource.url, publishedAt: doorplateSource.publishedAt, checkedAt: builtAt,
        sha256: doorplateSha, recordCount: countIndexEntries(doorplates.cells),
        etag: doorplate.kind === 'downloaded' ? doorplate.etag : oldDoorplate?.etag ?? null,
        lastModified: doorplate.kind === 'downloaded' ? doorplate.lastModified : oldDoorplate?.lastModified ?? null,
      },
      transactions: {
        sourceUrls: stagedCsvPaths.map(({ season }) => moiSeasonUrl(season)),
        publishedAt: null,
        checkedAt: builtAt,
        sha256: transactions.datasetVersion,
        recordCount: transactionCount,
        normalization,
      },
      lastFailure: null,
      artifacts: await artifactManifest(stage),
      transactionSources: sourceVersions,
    };
    await writeStableJson(path.join(stage, 'manifest.json'), manifest);
    const staged = await validateCandidateStagedBuild(stage, {
      minDoorplates: options.minDoorplates,
      minTransactions: options.minTransactions,
    });
    const transactionArtifactSha256 = await sha256File(path.join(stage, 'transactions-index.json'));
    const report = backtestCandidateTransactions(staged.transactions, {
      asOf: options.asOf,
      policy: execution.policy,
    });
    const candidateGate = evaluateCandidateBacktestGate(report);
    const injectedGate = options.gateEvaluator?.(report);
    const gate = injectedGate && !injectedGate.passed ? injectedGate : candidateGate;
    const acceptance = gate.passed && candidateGate.passed
      ? candidateBacktestAcceptance(report, transactionArtifactSha256, builtAt)
      : null;
    const evaluation: CandidateEvaluation = {
      report,
      gate,
      acceptance,
      diagnostics: normalization,
    };
    if (execution.capture) execution.capture.evaluation = evaluation;
    if (!gate.passed) {
      await fs.rm(stage, { recursive: true, force: true });
      stage = null;
      if (execution.publish) {
        const reason = `candidate-gate-failed: ${gate.reasons.join(', ') || 'incomplete-candidate-gate'}`;
        log(
          options.logger,
          existing ? 'warn' : 'error',
          existing ? 'market-data.last-known-good' : 'market-data.unavailable',
          existing
            ? 'market-data candidate gate failed; retaining last-known-good build'
            : 'market-data candidate gate failed and no accepted build is available',
          { reason },
        );
        if (existing) {
          existing.refresh = { status: 'last-known-good', failure: reason };
          return existing;
        }
      }
      return null;
    }
    if (!acceptance) {
      throw new Error('candidate backtest passed without a candidate acceptance');
    }
    if (execution.publish) {
      const published = await (options.publisher ?? publishStagedBuildWithAcceptance)(
        root,
        stage,
        acceptance,
        { minDoorplates: options.minDoorplates, minTransactions: options.minTransactions },
      );
      stage = null;
      published.refresh = { status: 'updated' };
      return published;
    }
    await fs.rm(stage, { recursive: true, force: true });
    stage = null;
    return null;
  } catch (error) {
    if (stage) await fs.rm(stage, { recursive: true, force: true });
    if (execution.rethrowErrors) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const schemaDrift = /schema drift|Missing required|headers/i.test(reason);
    log(options.logger, 'warn', schemaDrift ? 'market-data.schema-drift' : existing ? 'market-data.last-known-good' : 'market-data.unavailable',
      existing ? 'market-data refresh failed; retaining last-known-good build' : 'market-data is unavailable', { reason });
    if (existing) existing.refresh = { status: 'last-known-good', failure: reason };
    return existing;
  }
}

export async function ensureTaipeiMarketData(options: EnsureTaipeiMarketDataOptions): Promise<MarketDataBundle | null> {
  const root = options.rootPath ?? MARKET_DATA_ROOT;
  try {
    return await withMarketDataLock(
      root,
      async () => {
        await recoverInterruptedMarketDataPublication(root, {
          minDoorplates: options.minDoorplates,
          minTransactions: options.minTransactions,
        });
        return evaluateTaipeiMarketDataCandidateUnlocked(options, {
          policy: ACTIVE_ESTIMATOR_POLICY,
          rethrowErrors: false,
          publish: true,
        });
      },
      { timeoutMs: options.lockTimeoutMs, staleMs: options.lockStaleMs, pollMs: options.lockPollMs },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const existing = await loadMarketData(root, {
      minDoorplates: options.minDoorplates,
      minTransactions: options.minTransactions,
    });
    log(options.logger, 'warn', existing ? 'market-data.last-known-good' : 'market-data.unavailable',
      existing ? 'market-data refresh lock failed; retaining last-known-good build' : 'market-data is unavailable', { reason });
    if (existing) {
      existing.refresh = {
        status: 'last-known-good',
        failure: reason,
      };
    }
    return existing;
  }
}

export async function evaluateTaipeiMarketDataCandidate(
  options: EvaluateTaipeiMarketDataCandidateOptions,
): Promise<CandidateEvaluation> {
  if (options.publish) {
    throw new Error('Candidate evaluation is non-publishing; use market-data update for gated publication');
  }
  const capture: NonNullable<CandidateExecution['capture']> = {};
  const root = options.rootPath ?? MARKET_DATA_ROOT;
  await withMarketDataLock(
    root,
    () => evaluateTaipeiMarketDataCandidateUnlocked(
      {
        asOf: options.asOf,
        rootPath: root,
        fetch: options.fetch,
        clock: options.clock,
        logger: options.logger,
        minDoorplates: options.minDoorplates,
        minTransactions: options.minTransactions,
        openZip: options.openZip,
        gateEvaluator: options.gateEvaluator,
        publisher: options.publisher,
      },
      {
        policy: options.policy,
        rethrowErrors: true,
        publish: false,
        capture,
      },
    ),
    {
      timeoutMs: options.lockTimeoutMs,
      staleMs: options.lockStaleMs,
      pollMs: options.lockPollMs,
    },
  );
  if (!capture.evaluation) throw new Error('Candidate evaluation completed without a result');
  return capture.evaluation;
}
