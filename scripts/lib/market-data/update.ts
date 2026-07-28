import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import type { Logger } from '../journal.ts';
import {
  backtestAcceptance,
  backtestTransactions,
  evaluateBacktestGate,
  type BacktestGateResult,
  type BacktestReport,
} from './backtest.ts';
import { buildDoorplateIndex } from './doorplates.ts';
import { gridKey } from './grid.ts';
import {
  ACTIVE_ESTIMATOR_POLICY,
  MARKET_DATA_ROOT,
  MARKET_SCHEMA_VERSION,
  type EstimatorPolicy,
} from './config.ts';
import { extractTaipeiSalesCsv, downloadConditional, moiSeasonUrl, quartersForLookback, resolveTaipeiDoorplateSource, TAIPEI_DOORPLATE_DETAIL_URL, type FetchLike, type ZipEntry, zipEntriesFromFile } from './sources.ts';
import {
  compareStableText,
  countIndexEntries,
  loadMarketData,
  marketDataBacktestAccepted,
  publishStagedBuildWithAcceptance,
  recoverInterruptedMarketDataPublication,
  sha256File,
  validateStagedBuild,
  writeStableJson,
} from './store.ts';
import { normalizeSaleTransaction, validateSaleTransactionHeaders, type SaleTransactionRow } from './transactions.ts';
import type {
  BacktestAcceptance,
  DoorplateIndex,
  MarketDataBundle,
  MarketDataManifest,
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
  /** Test seam may reject or throw, but cannot override the production gate. */
  gateEvaluator?: (report: BacktestReport) => BacktestGateResult;
  publisher?: typeof publishStagedBuildWithAcceptance;
}

export interface CandidateEvaluation {
  report: BacktestReport;
  gate: BacktestGateResult;
  acceptance: BacktestAcceptance | null;
  diagnostics: TransactionBuildDiagnostics;
}

export interface EvaluateTaipeiMarketDataCandidateOptions {
  asOf: string;
  policy: EstimatorPolicy;
  publish: boolean;
  gateEvaluator?: (report: BacktestReport) => BacktestGateResult;
}

interface CandidateExecution {
  policy: EstimatorPolicy;
  publish: boolean;
  forceCandidateBuild: boolean;
  rethrowErrors: boolean;
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

async function addTransactionCsv(
  input: NodeJS.ReadableStream,
  doorplates: DoorplateIndex,
  cells: TransactionIndex['cells'],
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
    (cells[gridKey(normalized.transaction.location.coordinate!)] ??= []).push(normalized.transaction);
    if (normalized.transaction.eligibility === 'reliable-eligible') diagnostics.reliableEligible += 1;
    else diagnostics.reviewOnly += 1;
  }
  if (!checkedHeaders) throw new Error(`MOI ${sourceVersion} CSV has no data rows or headers`);
  diagnostics.excludedByReason = Object.fromEntries(
    Object.entries(diagnostics.excludedByReason).sort(([left], [right]) => compareStableText(left, right)),
  );
  return diagnostics;
}

function emptyTransactionBuildDiagnostics(): TransactionBuildDiagnostics {
  return { rawRows: 0, reliableEligible: 0, reviewOnly: 0, excluded: 0, excludedByReason: {} };
}

function mergeTransactionBuildDiagnostics(
  aggregate: TransactionBuildDiagnostics,
  next: TransactionBuildDiagnostics,
): void {
  aggregate.rawRows += next.rawRows;
  aggregate.reliableEligible += next.reliableEligible;
  aggregate.reviewOnly += next.reviewOnly;
  aggregate.excluded += next.excluded;
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
): TransactionIndex {
  const sortedCells = Object.fromEntries(Object.entries(cells).sort(([a], [b]) => compareStableText(a, b))
    .map(([key, values]) => [key, values.sort((a, b) => compareStableText(a.id, b.id))]));
  return { schemaVersion: MARKET_SCHEMA_VERSION, datasetVersion, builtAt, cells: sortedCells };
}

/**
 * Refreshes official sources into a sibling staging directory. Any source or
 * validation failure leaves the active build untouched and returns it instead.
 */
async function ensureTaipeiMarketDataUnlocked(
  options: EnsureTaipeiMarketDataOptions,
  execution: CandidateExecution = {
    policy: ACTIVE_ESTIMATOR_POLICY,
    publish: true,
    forceCandidateBuild: false,
    rethrowErrors: false,
  },
): Promise<MarketDataBundle | null> {
  const root = options.rootPath ?? MARKET_DATA_ROOT;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? (() => new Date());
  const openZip = options.openZip ?? zipEntriesFromFile;
  await recoverInterruptedMarketDataPublication(root, {
    minDoorplates: options.minDoorplates,
    minTransactions: options.minTransactions,
  });
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
    let sourcesChanged = !existing || doorplateSha !== existing.manifest.doorplates.sha256;
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
        if (!old || csvSha !== old.sha256) sourcesChanged = true;
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
    if (existing && !sourcesChanged && !execution.forceCandidateBuild
        && marketDataBacktestAccepted(existing)) {
      const current = await loadMarketData(root, {
        minDoorplates: options.minDoorplates,
        minTransactions: options.minTransactions,
      });
      if (!current ||
          current.manifest.buildId !== existing.manifest.buildId ||
          JSON.stringify(current.manifest.artifacts) !== JSON.stringify(existing.manifest.artifacts)) {
        throw new Error('Active market-data build changed during the locked refresh');
      }
      const refreshedManifest: MarketDataManifest = {
        ...current.manifest,
        doorplates: {
          ...current.manifest.doorplates,
          sourceUrl: doorplateSource.url,
          publishedAt: doorplateSource.publishedAt,
          checkedAt: builtAt,
          etag: doorplate.etag ?? oldDoorplate?.etag ?? null,
          lastModified: doorplate.lastModified ?? oldDoorplate?.lastModified ?? null,
        },
        transactions: { ...current.manifest.transactions, checkedAt: builtAt },
        transactionSources: sourceVersions,
        lastFailure: null,
      };
      const stagedManifest = path.join(stage, 'manifest.json');
      await writeStableJson(stagedManifest, refreshedManifest);
      await fs.rename(stagedManifest, path.join(root, 'manifest.json'));
      await fs.rm(stage, { recursive: true, force: true });
      stage = null;
      current.manifest = refreshedManifest;
      current.refresh = { status: 'not-modified' };
      log(options.logger, 'info', 'market-data.not-modified', 'official source checksums are unchanged', { buildId: current.manifest.buildId });
      return current;
    }

    const doorplates = await buildDoorplateIndex(createReadStream(doorplatePath), doorplateSha);
    const transactionCells: TransactionIndex['cells'] = {};
    const normalization = emptyTransactionBuildDiagnostics();
    for (const source of stagedCsvPaths) {
      mergeTransactionBuildDiagnostics(
        normalization,
        await addTransactionCsv(createReadStream(source.path), doorplates, transactionCells),
      );
    }
    const transactionCount = normalization.reliableEligible + normalization.reviewOnly;
    const transactions = finishTransactionIndex(
      transactionCells,
      builtAt,
      sha256(stagedCsvPaths.map(({ season }) => `${season}:${sourceVersions[season]!.sha256}`).join('\n')),
    );
    await writeStableJson(path.join(stage, 'doorplates-index.json'), doorplates);
    await writeStableJson(path.join(stage, 'transactions-index.json'), transactions);
    const manifest: MarketDataManifest = {
      schemaVersion: MARKET_SCHEMA_VERSION,
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
    const staged = await validateStagedBuild(stage, {
      minDoorplates: options.minDoorplates,
      minTransactions: options.minTransactions,
    });
    const transactionArtifactSha256 = await sha256File(path.join(stage, 'transactions-index.json'));
    const report = backtestTransactions(staged.transactions, {
      asOf: options.asOf,
      policy: execution.policy,
    });
    const productionGate = evaluateBacktestGate(report);
    const injectedGate = options.gateEvaluator?.(report);
    const gate = injectedGate && !injectedGate.passed ? injectedGate : productionGate;
    const acceptance = gate.passed && productionGate.passed
      ? backtestAcceptance(report, transactionArtifactSha256, builtAt)
      : null;
    const evaluation: CandidateEvaluation = {
      report,
      gate,
      acceptance,
      diagnostics: normalization,
    };
    if (execution.capture) execution.capture.evaluation = evaluation;
    if (!gate.passed) {
      if (execution.publish) {
        throw new Error(`candidate backtest failed: ${gate.reasons.join(', ') || 'gate rejected candidate'}`);
      }
      await fs.rm(stage, { recursive: true, force: true });
      stage = null;
      return null;
    }
    if (!acceptance) {
      throw new Error('candidate backtest passed without a production acceptance');
    }
    if (!execution.publish) {
      await fs.rm(stage, { recursive: true, force: true });
      stage = null;
      return null;
    }
    const publisher = options.publisher ?? publishStagedBuildWithAcceptance;
    const published = await publisher(root, stage, acceptance, {
      minDoorplates: options.minDoorplates,
      minTransactions: options.minTransactions,
    });
    stage = null;
    published.refresh = { status: 'updated' };
    log(options.logger, 'info', 'market-data.updated', 'published a validated Taipei market-data build', { buildId: published.manifest.buildId });
    return published;
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
  try {
    return await withMarketDataLock(
      options.rootPath ?? MARKET_DATA_ROOT,
      () => ensureTaipeiMarketDataUnlocked(options),
      { timeoutMs: options.lockTimeoutMs, staleMs: options.lockStaleMs, pollMs: options.lockPollMs },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const existing = await loadMarketData(options.rootPath ?? MARKET_DATA_ROOT, {
      minDoorplates: options.minDoorplates,
      minTransactions: options.minTransactions,
    });
    log(options.logger, 'warn', existing ? 'market-data.last-known-good' : 'market-data.unavailable',
      existing ? 'market-data refresh lock failed; retaining last-known-good build' : 'market-data is unavailable', { reason });
    if (existing) existing.refresh = { status: 'last-known-good', failure: reason };
    return existing;
  }
}

export async function evaluateTaipeiMarketDataCandidate(
  options: EvaluateTaipeiMarketDataCandidateOptions,
): Promise<CandidateEvaluation> {
  if (options.publish && options.policy.id !== ACTIVE_ESTIMATOR_POLICY.id) {
    throw new Error('Only the active estimator policy may publish a market-data candidate');
  }
  const capture: NonNullable<CandidateExecution['capture']> = {};
  await withMarketDataLock(
    MARKET_DATA_ROOT,
    () => ensureTaipeiMarketDataUnlocked(
      { asOf: options.asOf, gateEvaluator: options.gateEvaluator },
      {
        policy: options.policy,
        publish: options.publish,
        forceCandidateBuild: true,
        rethrowErrors: true,
        capture,
      },
    ),
  );
  if (!capture.evaluation) throw new Error('Candidate evaluation completed without a result');
  return capture.evaluation;
}
