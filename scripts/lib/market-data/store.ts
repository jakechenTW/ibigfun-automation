import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { isValidDateString } from '../date.ts';
import {
  BACKTEST_ACCEPTANCE_THRESHOLDS,
  ACTIVE_ESTIMATOR_POLICY,
  DOORPLATE_STALE_DAYS,
  ESTIMATOR_POLICY_VERSION,
  MARKET_SCHEMA_VERSION,
  MIN_PRODUCTION_DOORPLATES,
  MIN_PRODUCTION_TRANSACTIONS,
  TRANSACTION_STALE_DAYS,
} from './config.ts';
import { latestEligibleTransactionDate } from './backtest.ts';
import type {
  BacktestAcceptance,
  DoorplateIndex,
  MarketDataBundle,
  MarketDataManifest,
  SourceFreshness,
  TransactionBuildDiagnostics,
  TransactionIndex,
} from './types.ts';

const TAIPEI_BOUNDS = { minLat: 24.7, maxLat: 25.4, minLng: 121.2, maxLng: 121.9 };

export interface PublishOptions {
  minDoorplates?: number;
  minTransactions?: number;
  readerRetries?: number;
  readerRetryDelayMs?: number;
}

/** Byte/code-unit ordering is locale-independent and therefore checksum-safe. */
export function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareStableText(a, b))
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

/** Acceptance is a sibling of the immutable active build, so it cannot alter build checksums. */
export function backtestAcceptancePath(root: string): string {
  return path.join(path.dirname(root), `${path.basename(root)}-backtest-acceptance.json`);
}

export function transactionArtifactChecksum(manifest: MarketDataManifest): string | null {
  const checksum = manifest.artifacts?.['transactions-index.json']?.sha256;
  return typeof checksum === 'string' && checksum.length > 0 ? checksum : null;
}

function finiteRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateTransactionBuildDiagnostics(
  value: TransactionBuildDiagnostics,
  recordCount: number,
): void {
  if (!value || typeof value !== 'object') throw new Error('Manifest lacks transaction normalization diagnostics');
  const counts = [value.rawRows, value.reliableEligible, value.reviewOnly, value.excluded];
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new Error('Transaction normalization diagnostics contain invalid counts');
  }
  if (value.rawRows !== value.reliableEligible + value.reviewOnly + value.excluded
    || recordCount !== value.reliableEligible + value.reviewOnly) {
    throw new Error('Transaction normalization diagnostics do not match manifest counts');
  }
  if (!value.excludedByReason || typeof value.excludedByReason !== 'object'
    || Array.isArray(value.excludedByReason)) {
    throw new Error('Transaction normalization diagnostics lack exclusion reasons');
  }
  const reasons = Object.keys(value.excludedByReason);
  const excludedReasonCount = reasons.reduce(
    (total, reason) => total + (value.excludedByReason[reason] ?? 0),
    0,
  );
  if (reasons.some((reason) => !reason
      || !Number.isSafeInteger(value.excludedByReason[reason])
      || value.excludedByReason[reason]! <= 0)
    || reasons.join('\n') !== [...reasons].sort(compareStableText).join('\n')
    || excludedReasonCount !== value.excluded) {
    throw new Error('Transaction normalization exclusion reasons are invalid or unstable');
  }
}

function approvedBacktestThresholds(thresholds: BacktestAcceptance['thresholds']): boolean {
  return thresholds.medianApeMax === BACKTEST_ACCEPTANCE_THRESHOLDS.medianApeMax
    && thresholds.p75ApeMax === BACKTEST_ACCEPTANCE_THRESHOLDS.p75ApeMax
    && thresholds.minimumEstimateCoverage === BACKTEST_ACCEPTANCE_THRESHOLDS.minimumEstimateCoverage
    && thresholds.minimumConfidenceSliceCases === BACKTEST_ACCEPTANCE_THRESHOLDS.minimumConfidenceSliceCases
    && thresholds.minimumHighConfidenceImprovement === BACKTEST_ACCEPTANCE_THRESHOLDS.minimumHighConfidenceImprovement;
}

function validBacktestAcceptance(value: BacktestAcceptance): boolean {
  const { thresholds, metrics } = value;
  if (value.schemaVersion !== 2 || value.estimatorPolicyVersion !== ESTIMATOR_POLICY_VERSION
    || value.policyId !== ACTIVE_ESTIMATOR_POLICY.id
    || !value.transactionArtifactSha256
    || !Number.isFinite(Date.parse(value.approvedAt))
    || !isValidDateString(value.asOf)
    || !isValidDateString(value.evaluatedThrough)
    || !isValidDateString(value.latestEligibleTransactionDate)
    || value.asOf !== value.evaluatedThrough
    || value.evaluatedThrough < value.latestEligibleTransactionDate
    || !thresholds || !metrics) return false;
  if (!finiteRatio(thresholds.medianApeMax) || !finiteRatio(thresholds.p75ApeMax)
    || !finiteRatio(thresholds.minimumEstimateCoverage) || thresholds.minimumEstimateCoverage > 1
    || !Number.isInteger(thresholds.minimumConfidenceSliceCases) || thresholds.minimumConfidenceSliceCases <= 0
    || !finiteRatio(thresholds.minimumHighConfidenceImprovement)
    || !approvedBacktestThresholds(thresholds)) return false;
  if (!finiteRatio(metrics.estimateCoverage) || metrics.estimateCoverage > 1
    || !Number.isInteger(metrics.reliableEstimatedCount) || metrics.reliableEstimatedCount < 0
    || !finiteRatio(metrics.reliableMedianApe) || !finiteRatio(metrics.reliableP75Ape)
    || !Number.isInteger(metrics.highConfidenceEstimatedCount)
    || !Number.isInteger(metrics.mediumConfidenceEstimatedCount)
    || !finiteRatio(metrics.highConfidenceMedianApe)
    || !finiteRatio(metrics.mediumConfidenceMedianApe)) return false;
  return metrics.estimateCoverage >= thresholds.minimumEstimateCoverage
    && metrics.reliableMedianApe <= thresholds.medianApeMax
    && metrics.reliableP75Ape <= thresholds.p75ApeMax
    && metrics.highConfidenceEstimatedCount >= thresholds.minimumConfidenceSliceCases
    && metrics.mediumConfidenceEstimatedCount >= thresholds.minimumConfidenceSliceCases
    && metrics.highConfidenceMedianApe + thresholds.minimumHighConfidenceImprovement
      <= metrics.mediumConfidenceMedianApe + Number.EPSILON;
}

export function readBacktestAcceptance(root: string): BacktestAcceptance | null {
  const value = readJson<BacktestAcceptance>(backtestAcceptancePath(root));
  return value && validBacktestAcceptance(value) ? value : null;
}

/** Atomically replaces the aggregate-only local acceptance artifact. */
export async function writeBacktestAcceptance(root: string, acceptance: BacktestAcceptance): Promise<void> {
  if (acceptance.estimatorPolicyVersion !== ESTIMATOR_POLICY_VERSION) {
    throw new Error('Backtest acceptance estimator policy does not match the runtime policy');
  }
  if (acceptance.policyId !== ACTIVE_ESTIMATOR_POLICY.id) {
    throw new Error('Backtest acceptance policy does not match the active estimator policy');
  }
  if (!approvedBacktestThresholds(acceptance.thresholds)) {
    throw new Error('Backtest acceptance must use the approved quality thresholds');
  }
  const transactions = readJson<TransactionIndex>(path.join(root, 'transactions-index.json'));
  const latest = transactions && latestEligibleTransactionDate(transactions);
  if (!latest || acceptance.latestEligibleTransactionDate !== latest
    || acceptance.evaluatedThrough < latest) {
    throw new Error('Backtest acceptance must cover the complete active transaction index');
  }
  if (!validBacktestAcceptance(acceptance)) throw new Error('Refusing to persist a non-passing backtest acceptance');
  const target = backtestAcceptancePath(root);
  const temporary = `${target}.tmp-${randomUUID()}`;
  await writeStableJson(temporary, acceptance);
  await fsp.rename(temporary, target);
}

export type MarketAcceptanceDecision =
  | { accepted: true; reason: null }
  | { accepted: false; reason: 'market-backtest-not-approved' };

export interface MarketAcceptanceDiagnostics {
  eligibleTransactionScans: number;
}

export function marketDataBacktestAcceptanceDecision(
  bundle: MarketDataBundle,
  diagnostics?: MarketAcceptanceDiagnostics,
): MarketAcceptanceDecision {
  const acceptance = bundle.backtestAcceptance;
  if (diagnostics) diagnostics.eligibleTransactionScans += 1;
  const latest = latestEligibleTransactionDate(bundle.transactions);
  const accepted = acceptance !== undefined
    && validBacktestAcceptance(acceptance)
    && acceptance.transactionArtifactSha256 === transactionArtifactChecksum(bundle.manifest)
    && latest !== null
    && acceptance.latestEligibleTransactionDate === latest
    && acceptance.evaluatedThrough >= latest;
  return accepted
    ? { accepted: true, reason: null }
    : { accepted: false, reason: 'market-backtest-not-approved' };
}

export function marketDataBacktestAccepted(bundle: MarketDataBundle): boolean {
  return marketDataBacktestAcceptanceDecision(bundle).accepted;
}

function attachMatchingBacktestAcceptance(root: string, bundle: MarketDataBundle): MarketDataBundle {
  const acceptance = readBacktestAcceptance(root);
  if (!acceptance) return bundle;
  const candidate = { ...bundle, backtestAcceptance: acceptance };
  return marketDataBacktestAccepted(candidate) ? candidate : bundle;
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
  return keys.every((key, index) => index === 0 || compareStableText(keys[index - 1]!, key) <= 0);
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
  validateTransactionBuildDiagnostics(
    manifest.transactions.normalization,
    manifest.transactions.recordCount,
  );
  validateIndexes(doorplates, transactions);
  const doorplateCount = Object.values(doorplates.cells).flat().length;
  const transactionCount = Object.values(transactions.cells).flat().length;
  if (manifest.doorplates.recordCount !== doorplateCount || manifest.transactions.recordCount !== transactionCount) {
    throw new Error('Manifest record counts do not match validated indexes');
  }
  await validateArtifacts(root, manifest);
  return { manifest, doorplates, transactions };
}

/** Validates an isolated build without attaching or mutating active acceptance state. */
export async function validateStagedBuild(
  stageRoot: string,
  options: PublishOptions = {},
): Promise<MarketDataBundle> {
  return validateBuild(stageRoot, options);
}

/** Loads only a fully validated active build; malformed partial data is never exposed. */
export async function loadMarketData(root: string, options: PublishOptions = {}): Promise<MarketDataBundle | null> {
  const retries = options.readerRetries ?? 4;
  const retryDelayMs = options.readerRetryDelayMs ?? 10;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return attachMatchingBacktestAcceptance(root, await validateBuild(root, options));
    } catch {
      if (attempt === retries) return null;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return null;
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
  return attachMatchingBacktestAcceptance(activeRoot, bundle);
}
