import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import type { Logger } from '../journal.ts';
import { buildDoorplateIndex } from './doorplates.ts';
import { gridKey } from './grid.ts';
import { MARKET_DATA_ROOT, MARKET_SCHEMA_VERSION } from './config.ts';
import { extractTaipeiSalesCsv, downloadConditional, moiSeasonUrl, quartersForLookback, resolveTaipeiDoorplateSource, TAIPEI_DOORPLATE_DETAIL_URL, type FetchLike, zipEntriesFromFile } from './sources.ts';
import { compareStableText, loadMarketData, publishStagedBuild, sha256File, writeStableJson } from './store.ts';
import { normalizeSaleTransaction, validateSaleTransactionHeaders, type SaleTransactionRow } from './transactions.ts';
import type { MarketDataBundle, MarketDataManifest, TransactionIndex } from './types.ts';

export interface EnsureTaipeiMarketDataOptions {
  asOf: string;
  rootPath?: string;
  fetch?: FetchLike;
  clock?: () => Date;
  logger?: Pick<Logger, 'event'>;
  minDoorplates?: number;
  minTransactions?: number;
}

function nowIso(clock: () => Date): string { return clock().toISOString(); }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function currentSeason(asOf: string): string { return quartersForLookback(asOf, 0)[0]!; }
function priorSeason(asOf: string): string { return quartersForLookback(asOf, 3)[0]!; }
function log(logger: EnsureTaipeiMarketDataOptions['logger'], level: 'info' | 'warn' | 'error', event: string, msg: string, data?: unknown): void {
  logger?.event(level, event, msg, data);
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
  csvPath: string,
  season: string,
  doorplates: Awaited<ReturnType<typeof buildDoorplateIndex>>,
  cells: TransactionIndex['cells'],
): Promise<number> {
  let count = 0;
  const parser = createReadStream(csvPath).pipe(parse({ bom: true, columns: true, skip_empty_lines: true, trim: true }));
  let checkedHeaders = false;
  for await (const row of parser as AsyncIterable<SaleTransactionRow>) {
    if (!checkedHeaders) { validateSaleTransactionHeaders(Object.keys(row)); checkedHeaders = true; }
    const normalized = normalizeSaleTransaction(row, { doorplates, sourceVersion: season });
    if (normalized.kind !== 'included') continue;
    (cells[gridKey(normalized.transaction.location.coordinate!)] ??= []).push(normalized.transaction);
    count += 1;
  }
  if (!checkedHeaders) throw new Error(`MOI ${season} CSV has no data rows or headers`);
  return count;
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
export async function ensureTaipeiMarketData(options: EnsureTaipeiMarketDataOptions): Promise<MarketDataBundle | null> {
  const root = options.rootPath ?? MARKET_DATA_ROOT;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? (() => new Date());
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
    const doorplates = await buildDoorplateIndex(createReadStream(doorplatePath), doorplateSha);
    const seasons = quartersForLookback(options.asOf, 36);
    const mutableSeasons = new Set([currentSeason(options.asOf), priorSeason(options.asOf)]);
    const sourceVersions: NonNullable<MarketDataManifest['transactionSources']> = {};
    const transactionCells: TransactionIndex['cells'] = {};
    let transactionCount = 0;
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
            transactionCount += await addTransactionCsv(stagedCsvPath, season, doorplates, transactionCells);
            continue;
          }
        } catch { /* source will be re-downloaded */ }
      }
      const zipPath = path.join(rawRoot, 'transactions', `${season}.zip`);
      const downloaded = await downloadConditional(fetcher, moiSeasonUrl(season), old, zipPath);
      if (downloaded.kind === 'not-modified') {
        await fs.mkdir(path.dirname(stagedCsvPath), { recursive: true });
        await fs.copyFile(rawPath, stagedCsvPath);
      } else {
        await extractTaipeiSalesCsv(await zipEntriesFromFile(zipPath), stagedCsvPath);
      }
      const csvSha = await sha256File(stagedCsvPath);
      sourceVersions[season] = {
        url: moiSeasonUrl(season), sha256: csvSha,
        etag: downloaded.etag ?? old?.etag ?? null,
        lastModified: downloaded.lastModified ?? old?.lastModified ?? null,
      };
      transactionCount += await addTransactionCsv(stagedCsvPath, season, doorplates, transactionCells);
    }

    const builtAt = nowIso(clock);
    const transactions = finishTransactionIndex(
      transactionCells,
      builtAt,
      sha256(seasons.map((season) => `${season}:${sourceVersions[season]!.sha256}`).join('\n')),
    );
    await writeStableJson(path.join(stage, 'doorplates-index.json'), doorplates);
    await writeStableJson(path.join(stage, 'transactions-index.json'), transactions);
    const manifest: MarketDataManifest = {
      schemaVersion: MARKET_SCHEMA_VERSION,
      buildId: `taipei-${builtAt.replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`,
      builtAt,
      doorplates: {
        sourceUrl: doorplateSource.url, publishedAt: doorplateSource.publishedAt, checkedAt: builtAt,
        sha256: doorplateSha, recordCount: Object.values(doorplates.cells).flat().length,
        etag: doorplate.kind === 'downloaded' ? doorplate.etag : oldDoorplate?.etag ?? null,
        lastModified: doorplate.kind === 'downloaded' ? doorplate.lastModified : oldDoorplate?.lastModified ?? null,
      },
      transactions: { sourceUrls: seasons.map(moiSeasonUrl), publishedAt: null, checkedAt: builtAt, sha256: transactions.datasetVersion, recordCount: transactionCount },
      lastFailure: null,
      artifacts: await artifactManifest(stage),
      transactionSources: sourceVersions,
    };
    await writeStableJson(path.join(stage, 'manifest.json'), manifest);
    const published = await publishStagedBuild(root, stage, { minDoorplates: options.minDoorplates, minTransactions: options.minTransactions });
    stage = null;
    log(options.logger, 'info', 'market-data.updated', 'published a validated Taipei market-data build', { buildId: published.manifest.buildId });
    return published;
  } catch (error) {
    if (stage) await fs.rm(stage, { recursive: true, force: true });
    const reason = error instanceof Error ? error.message : String(error);
    const schemaDrift = /schema drift|Missing required|headers/i.test(reason);
    log(options.logger, 'warn', schemaDrift ? 'market-data.schema-drift' : existing ? 'market-data.last-known-good' : 'market-data.unavailable',
      existing ? 'market-data refresh failed; retaining last-known-good build' : 'market-data is unavailable', { reason });
    return existing;
  }
}
