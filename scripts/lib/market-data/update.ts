import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import type { Logger } from '../journal.ts';
import { buildDoorplateIndex } from './doorplates.ts';
import { gridKey } from './grid.ts';
import { MARKET_DATA_ROOT, MARKET_SCHEMA_VERSION } from './config.ts';
import { extractTaipeiSalesCsv, downloadConditional, moiSeasonUrl, quartersForLookback, resolveTaipeiDoorplateSource, TAIPEI_DOORPLATE_DETAIL_URL, type FetchLike, zipEntriesFromBuffer } from './sources.ts';
import { loadMarketData, publishStagedBuild, sha256File, writeStableJson } from './store.ts';
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
function sha256(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
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
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function buildTransactionIndex(
  csvs: Array<{ season: string; csv: Buffer }>,
  doorplates: Awaited<ReturnType<typeof buildDoorplateIndex>>,
  builtAt: string,
): Promise<{ index: TransactionIndex; count: number }> {
  const cells: TransactionIndex['cells'] = {};
  let count = 0;
  for (const { season, csv } of csvs) {
    const parser = Readable.from(csv).pipe(parse({ bom: true, columns: true, skip_empty_lines: true, trim: true }));
    let checkedHeaders = false;
    for await (const row of parser as AsyncIterable<SaleTransactionRow>) {
      if (!checkedHeaders) { validateSaleTransactionHeaders(Object.keys(row)); checkedHeaders = true; }
      const normalized = normalizeSaleTransaction(row, { doorplates, sourceVersion: season });
      if (normalized.kind !== 'included') continue;
      (cells[gridKey(normalized.transaction.location.coordinate!)] ??= []).push(normalized.transaction);
      count += 1;
    }
    if (!checkedHeaders) throw new Error(`MOI ${season} CSV has no data rows or headers`);
  }
  const sortedCells = Object.fromEntries(Object.entries(cells).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => [key, values.sort((a, b) => a.id.localeCompare(b.id))]));
  return { index: { schemaVersion: MARKET_SCHEMA_VERSION, datasetVersion: sha256(Buffer.concat(csvs.map((value) => value.csv))), builtAt, cells: sortedCells }, count };
}

/**
 * Refreshes official sources into a sibling staging directory. Any source or
 * validation failure leaves the active build untouched and returns it instead.
 */
export async function ensureTaipeiMarketData(options: EnsureTaipeiMarketDataOptions): Promise<MarketDataBundle | null> {
  const root = options.rootPath ?? MARKET_DATA_ROOT;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? (() => new Date());
  const existing = await loadMarketData(root);
  log(options.logger, 'info', 'market-data.check', 'checking Taipei official market-data sources', { activeBuildId: existing?.manifest.buildId ?? null });
  const stageParent = path.dirname(root);
  let stage: string | null = null;
  try {
    const detail = await downloadConditional(fetcher, TAIPEI_DOORPLATE_DETAIL_URL);
    if (detail.kind === 'not-modified' && !existing) throw new Error('Doorplate detail returned not-modified without an active build');
    if (detail.kind === 'not-modified') log(options.logger, 'info', 'market-data.not-modified', 'doorplate detail was not modified');
    const doorplateSource = detail.kind === 'downloaded'
      ? resolveTaipeiDoorplateSource(detail.bytes.toString('utf8'))
      : { url: existing!.manifest.doorplates.sourceUrl, publishedAt: existing!.manifest.doorplates.publishedAt };
    const oldDoorplate = existing?.manifest.doorplates;
    const doorplate = await downloadConditional(fetcher, doorplateSource.url, {
      etag: oldDoorplate?.etag,
      lastModified: oldDoorplate?.lastModified,
    });
    const doorplateBytes = doorplate.kind === 'downloaded'
      ? doorplate.bytes
      : await fs.readFile(path.join(root, 'raw', 'doorplates.csv'));
    const seasons = quartersForLookback(options.asOf, 36);
    const mutableSeasons = new Set([currentSeason(options.asOf), priorSeason(options.asOf)]);
    const csvs: Array<{ season: string; csv: Buffer }> = [];
    const sourceVersions: NonNullable<MarketDataManifest['transactionSources']> = {};
    for (const season of seasons) {
      const old = existing?.manifest.transactionSources?.[season];
      const rawPath = path.join(root, 'raw', 'transactions', `${season}.csv`);
      if (!mutableSeasons.has(season) && old) {
        try {
          const cached = await fs.readFile(rawPath);
          if (sha256(cached) === old.sha256) { csvs.push({ season, csv: cached }); sourceVersions[season] = old; continue; }
        } catch { /* source will be re-downloaded */ }
      }
      const downloaded = await downloadConditional(fetcher, moiSeasonUrl(season), old);
      if (downloaded.kind === 'not-modified') {
        const cached = await fs.readFile(rawPath);
        csvs.push({ season, csv: cached });
        sourceVersions[season] = { url: moiSeasonUrl(season), sha256: sha256(cached), etag: downloaded.etag ?? old?.etag ?? null, lastModified: downloaded.lastModified ?? old?.lastModified ?? null };
        continue;
      }
      const csv = await extractTaipeiSalesCsv(await zipEntriesFromBuffer(downloaded.bytes));
      csvs.push({ season, csv });
      sourceVersions[season] = { url: moiSeasonUrl(season), sha256: sha256(csv), etag: downloaded.etag, lastModified: downloaded.lastModified };
    }

    await fs.mkdir(stageParent, { recursive: true });
    stage = await fs.mkdtemp(path.join(stageParent, `.${path.basename(root)}-staging-`));
    const builtAt = nowIso(clock);
    await fs.mkdir(path.join(stage, 'raw', 'transactions'), { recursive: true });
    await fs.writeFile(path.join(stage, 'raw', 'doorplates.csv'), doorplateBytes);
    for (const item of csvs) await fs.writeFile(path.join(stage, 'raw', 'transactions', `${item.season}.csv`), item.csv);
    const doorplates = await buildDoorplateIndex(Readable.from(doorplateBytes), sha256(doorplateBytes));
    const builtTransactions = await buildTransactionIndex(csvs, doorplates, builtAt);
    await writeStableJson(path.join(stage, 'doorplates-index.json'), doorplates);
    await writeStableJson(path.join(stage, 'transactions-index.json'), builtTransactions.index);
    const manifest: MarketDataManifest = {
      schemaVersion: MARKET_SCHEMA_VERSION,
      buildId: `taipei-${builtAt.replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`,
      builtAt,
      doorplates: {
        sourceUrl: doorplateSource.url, publishedAt: doorplateSource.publishedAt, checkedAt: builtAt,
        sha256: sha256(doorplateBytes), recordCount: Object.values(doorplates.cells).flat().length,
        etag: doorplate.kind === 'downloaded' ? doorplate.etag : oldDoorplate?.etag ?? null,
        lastModified: doorplate.kind === 'downloaded' ? doorplate.lastModified : oldDoorplate?.lastModified ?? null,
      },
      transactions: { sourceUrls: seasons.map(moiSeasonUrl), publishedAt: null, checkedAt: builtAt, sha256: sha256(Buffer.concat(csvs.map((item) => item.csv))), recordCount: builtTransactions.count },
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
