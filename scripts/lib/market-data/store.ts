import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { MARKET_SCHEMA_VERSION, MIN_PRODUCTION_DOORPLATES, MIN_PRODUCTION_TRANSACTIONS } from './config.ts';
import { DOORPLATE_STALE_DAYS, TRANSACTION_STALE_DAYS } from './config.ts';
import type { DoorplateIndex, MarketDataBundle, MarketDataManifest, SourceFreshness, TransactionIndex } from './types.ts';

const TAIPEI_BOUNDS = { minLat: 24.7, maxLat: 25.4, minLng: 121.2, maxLng: 121.9 };

export interface PublishOptions {
  minDoorplates?: number;
  minTransactions?: number;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk: string | Buffer) => { hash.update(chunk); });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function writeStableJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${stableJson(value)}\n`);
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

export function readManifest(root: string): MarketDataManifest | null {
  return readJson<MarketDataManifest>(path.join(root, 'manifest.json'));
}

/** Computes source freshness from recorded successful checks, never from failed refresh attempts. */
export function marketDataFreshness(manifest: MarketDataManifest, asOf: string | Date): SourceFreshness {
  const now = typeof asOf === 'string' ? Date.parse(asOf) : asOf.getTime();
  if (!Number.isFinite(now)) throw new RangeError('Freshness time must be a valid ISO timestamp or Date');
  const stale = (checkedAt: string, windowDays: number): boolean => {
    const checked = Date.parse(checkedAt);
    return !Number.isFinite(checked) || now - checked > windowDays * 24 * 60 * 60 * 1_000;
  };
  return {
    transactionCheckedAt: manifest.transactions.checkedAt,
    doorplateCheckedAt: manifest.doorplates.checkedAt,
    transactionStale: stale(manifest.transactions.checkedAt, TRANSACTION_STALE_DAYS),
    doorplateStale: stale(manifest.doorplates.checkedAt, DOORPLATE_STALE_DAYS),
  };
}

function sortedKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.every((key, index) => index === 0 || keys[index - 1]! <= key);
}

function validCoordinate(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const { lat, lng } = value as { lat?: unknown; lng?: unknown };
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= TAIPEI_BOUNDS.minLat && lat <= TAIPEI_BOUNDS.maxLat &&
    lng >= TAIPEI_BOUNDS.minLng && lng <= TAIPEI_BOUNDS.maxLng;
}

function validateCells(
  cells: Record<string, unknown[]>,
  coordinate: (item: unknown) => unknown,
  orderKey: (item: unknown) => string = stableJson,
): void {
  if (!sortedKeys(cells)) throw new Error('Index cell keys must be sorted');
  for (const entries of Object.values(cells)) {
    let prior = '';
    for (const entry of entries) {
      if (!validCoordinate(coordinate(entry))) throw new Error('Index coordinate lies outside Taipei bounds');
      const current = orderKey(entry);
      if (current < prior) throw new Error('Index records must have stable sorted order');
      prior = current;
    }
  }
}

function validateIndexes(doorplates: DoorplateIndex, transactions: TransactionIndex): void {
  if (doorplates.schemaVersion !== MARKET_SCHEMA_VERSION || transactions.schemaVersion !== MARKET_SCHEMA_VERSION) {
    throw new Error('Market index schema version mismatch');
  }
  if (!sortedKeys(doorplates.byCanonicalAddress) || !sortedKeys(doorplates.byRoad)) {
    throw new Error('Doorplate index keys must be sorted');
  }
  validateCells(doorplates.cells as Record<string, unknown[]>, (entry) => (entry as { coordinate?: unknown }).coordinate);
  validateCells(
    transactions.cells as Record<string, unknown[]>,
    (entry) => (entry as { location?: { coordinate?: unknown } }).location?.coordinate,
    (entry) => {
      const id = (entry as { id?: unknown }).id;
      if (typeof id !== 'string' || !id) throw new Error('Transaction index record lacks a stable ID');
      return id;
    },
  );
}

async function artifactFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && path.relative(root, full) !== 'manifest.json') results.push(path.relative(root, full));
    }
  }
  await visit(root);
  return results.sort();
}

async function validateArtifacts(root: string, manifest: MarketDataManifest): Promise<void> {
  if (!manifest.artifacts || typeof manifest.artifacts !== 'object') throw new Error('Manifest lacks artifact checksums');
  const files = await artifactFiles(root);
  const declared = Object.keys(manifest.artifacts).sort();
  if (files.join('\n') !== declared.join('\n')) throw new Error('Manifest artifact list does not match build files');
  for (const relative of files) {
    const expected = manifest.artifacts[relative];
    const file = path.join(root, relative);
    const bytes = (await fsp.stat(file)).size;
    if (!expected || expected.bytes !== bytes || expected.sha256 !== await sha256File(file)) {
      throw new Error(`Artifact checksum mismatch: ${relative}`);
    }
  }
}

async function validateBuild(root: string, options: PublishOptions): Promise<MarketDataBundle> {
  const manifest = readManifest(root);
  const doorplates = readJson<DoorplateIndex>(path.join(root, 'doorplates-index.json'));
  const transactions = readJson<TransactionIndex>(path.join(root, 'transactions-index.json'));
  if (!manifest || !doorplates || !transactions) throw new Error('Market build is missing manifest or indexes');
  if (manifest.schemaVersion !== MARKET_SCHEMA_VERSION || !manifest.buildId || !manifest.builtAt) {
    throw new Error('Market manifest schema version mismatch');
  }
  const minDoorplates = options.minDoorplates ?? MIN_PRODUCTION_DOORPLATES;
  const minTransactions = options.minTransactions ?? MIN_PRODUCTION_TRANSACTIONS;
  if (!Number.isInteger(manifest.doorplates.recordCount) || manifest.doorplates.recordCount < minDoorplates) {
    throw new Error(`Doorplate count below required threshold (${minDoorplates})`);
  }
  if (!Number.isInteger(manifest.transactions.recordCount) || manifest.transactions.recordCount < minTransactions) {
    throw new Error(`Transaction count below required threshold (${minTransactions})`);
  }
  validateIndexes(doorplates, transactions);
  const doorplateCount = Object.values(doorplates.cells).flat().length;
  const transactionCount = Object.values(transactions.cells).flat().length;
  if (manifest.doorplates.recordCount !== doorplateCount || manifest.transactions.recordCount !== transactionCount) {
    throw new Error('Manifest record counts do not match validated indexes');
  }
  await validateArtifacts(root, manifest);
  return { manifest, doorplates, transactions };
}

/** Loads only a fully validated active build; malformed partial data is never exposed. */
export async function loadMarketData(root: string, options: PublishOptions = {}): Promise<MarketDataBundle | null> {
  try { return await validateBuild(root, options); } catch { return null; }
}

/** Replaces the complete active directory only after independently validating a sibling staging build. */
export async function publishStagedBuild(activeRoot: string, stageRoot: string, options: PublishOptions = {}): Promise<MarketDataBundle> {
  const parent = path.dirname(activeRoot);
  const expectedPrefix = `.${path.basename(activeRoot)}-staging-`;
  if (path.dirname(stageRoot) !== parent || !path.basename(stageRoot).startsWith(expectedPrefix)) {
    throw new Error('Staging directory must be a sibling with the expected market-data prefix');
  }
  const bundle = await validateBuild(stageRoot, options);
  const backup = path.join(parent, `.${path.basename(activeRoot)}-backup-${bundle.manifest.buildId.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
  if (fs.existsSync(backup)) throw new Error(`Refusing to overwrite existing market-data backup: ${backup}`);
  let movedActive = false;
  try {
    if (fs.existsSync(activeRoot)) {
      await fsp.rename(activeRoot, backup);
      movedActive = true;
    }
    await fsp.rename(stageRoot, activeRoot);
  } catch (error) {
    if (movedActive && !fs.existsSync(activeRoot) && fs.existsSync(backup)) await fsp.rename(backup, activeRoot);
    throw error;
  }
  if (movedActive) {
    // Publication is committed once stage becomes active. A cleanup failure may
    // leave a recoverable backup, but must not make the new active build look failed.
    try { await fsp.rm(backup, { recursive: true, force: false }); } catch { /* recoverable backup retained */ }
  }
  return bundle;
}
