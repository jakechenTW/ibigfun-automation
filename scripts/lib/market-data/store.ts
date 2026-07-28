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

interface PublicationFileOps {
  rename(from: string, to: string): Promise<void>;
  rm(file: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  readFile(file: string): Promise<Buffer>;
}

export interface PublishOptions {
  minDoorplates?: number;
  minTransactions?: number;
  readerRetries?: number;
  readerRetryDelayMs?: number;
  /** @internal Narrow file-operation seam for publication failure/window tests. */
  publicationFileOps?: Partial<Pick<PublicationFileOps, 'rename' | 'rm'>>;
}

const publicationFileOps: PublicationFileOps = {
  rename: (from, to) => fsp.rename(from, to),
  rm: (file, options) => fsp.rm(file, options),
  readFile: (file) => fsp.readFile(file),
};

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

/** Counts cell entries without allocating a full-index flattened copy. */
export function countIndexEntries(cells: Record<string, readonly unknown[]>): number {
  let count = 0;
  for (const entries of Object.values(cells)) count += entries.length;
  return count;
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

export function marketDataManifestHasCurrentPolicyProvenance(
  manifest: MarketDataManifest,
): boolean {
  return manifest.schemaVersion === MARKET_SCHEMA_VERSION
    && manifest.estimatorPolicyVersion === ESTIMATOR_POLICY_VERSION;
}

export function assertCurrentMarketDataIndexPolicy(
  manifest: MarketDataManifest,
): void {
  if (!marketDataManifestHasCurrentPolicyProvenance(manifest)) {
    throw new Error(
      'Active market-data index policy provenance does not match the runtime policy; run update first',
    );
  }
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
  const active = await validateBuild(root, {
    minDoorplates: 0,
    minTransactions: 0,
  });
  if (acceptance.estimatorPolicyVersion !== ESTIMATOR_POLICY_VERSION) {
    throw new Error('Backtest acceptance estimator policy does not match the runtime policy');
  }
  if (acceptance.policyId !== ACTIVE_ESTIMATOR_POLICY.id) {
    throw new Error('Backtest acceptance policy does not match the active estimator policy');
  }
  if (!approvedBacktestThresholds(acceptance.thresholds)) {
    throw new Error('Backtest acceptance must use the approved quality thresholds');
  }
  const latest = latestEligibleTransactionDate(active.transactions);
  if (!latest || acceptance.latestEligibleTransactionDate !== latest
      || acceptance.evaluatedThrough < latest) {
    throw new Error('Backtest acceptance must cover the complete active transaction index');
  }
  validateAcceptanceForBundle(acceptance, active);
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
    && marketDataManifestHasCurrentPolicyProvenance(bundle.manifest)
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

function validateIndexes(
  doorplates: DoorplateIndex,
  transactions: TransactionIndex,
  expectedSchemaVersion: number,
): void {
  if (doorplates.schemaVersion !== expectedSchemaVersion
      || transactions.schemaVersion !== expectedSchemaVersion) {
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

type BuildValidationMode = 'current' | 'restorable';

function validateManifestPolicy(
  manifest: MarketDataManifest,
  mode: BuildValidationMode,
): void {
  if (mode === 'current') {
    assertCurrentMarketDataIndexPolicy(manifest);
    return;
  }
  if (manifest.schemaVersion !== 2 && manifest.schemaVersion !== MARKET_SCHEMA_VERSION) {
    throw new Error('Market manifest schema version is not restorable');
  }
}

async function validateBuild(
  root: string,
  options: PublishOptions,
  mode: BuildValidationMode = 'current',
): Promise<MarketDataBundle> {
  const manifest = readManifest(root);
  const doorplates = readJson<DoorplateIndex>(path.join(root, 'doorplates-index.json'));
  const transactions = readJson<TransactionIndex>(path.join(root, 'transactions-index.json'));
  if (!manifest || !doorplates || !transactions) throw new Error('Market build is missing manifest or indexes');
  if (!manifest.buildId || !manifest.builtAt) {
    throw new Error('Market manifest schema version mismatch');
  }
  validateManifestPolicy(manifest, mode);
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
  validateIndexes(doorplates, transactions, manifest.schemaVersion);
  const doorplateCount = countIndexEntries(doorplates.cells);
  const transactionCount = countIndexEntries(transactions.cells);
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

function stagingPathError(activeRoot: string, stageRoot: string): Error | null {
  const parent = path.dirname(activeRoot);
  const expectedPrefix = `.${path.basename(activeRoot)}-staging-`;
  return path.dirname(stageRoot) !== parent || !path.basename(stageRoot).startsWith(expectedPrefix)
    ? new Error('Staging directory must be a sibling with the expected market-data prefix')
    : null;
}

type PublicationPhase = 'prepared';

interface PublicationJournal {
  schemaVersion: 1;
  phase: PublicationPhase;
  publicationId: string;
  activeBasename: string;
  stageBasename: string;
  stagedBuildId: string;
  oldBuildId: string | null;
  oldAcceptancePresent: boolean;
  candidateAcceptanceSha256: string;
  oldAcceptanceSha256: string | null;
}

interface PublicationPaths {
  parent: string;
  activeRoot: string;
  stageRoot: string;
  backupRoot: string;
  acceptanceTarget: string;
  acceptanceCandidate: string;
  acceptanceBackup: string;
  journal: string;
}

function publicationJournalPath(activeRoot: string): string {
  return path.join(
    path.dirname(activeRoot),
    `.${path.basename(activeRoot)}-publication-journal.json`,
  );
}

function publicationPaths(activeRoot: string, journal: PublicationJournal): PublicationPaths {
  const parent = path.dirname(activeRoot);
  const basename = path.basename(activeRoot);
  const acceptanceTarget = backtestAcceptancePath(activeRoot);
  return {
    parent,
    activeRoot,
    stageRoot: path.join(parent, journal.stageBasename),
    backupRoot: path.join(parent, `.${basename}-backup-${journal.publicationId}`),
    acceptanceTarget,
    acceptanceCandidate: `${acceptanceTarget}.candidate-${journal.publicationId}`,
    acceptanceBackup: `${acceptanceTarget}.backup-${journal.publicationId}`,
    journal: publicationJournalPath(activeRoot),
  };
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableUnique(file: string, data: Uint8Array): Promise<void> {
  const handle = await fsp.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

async function writeDurableJournal(file: string, journal: PublicationJournal): Promise<void> {
  const temporary = `${file}.tmp-${journal.publicationId}`;
  try {
    await writeDurableUnique(temporary, Buffer.from(`${stableJson(journal)}\n`));
    await fsp.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    try { await fsp.rm(temporary, { force: true }); } catch { /* best-effort pre-publication cleanup */ }
    throw error;
  }
}

function validPublicationJournal(value: unknown, activeRoot: string): value is PublicationJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const journal = value as Partial<PublicationJournal> & Record<string, unknown>;
  const allowedKeys = [
    'schemaVersion',
    'phase',
    'publicationId',
    'activeBasename',
    'stageBasename',
    'stagedBuildId',
    'oldBuildId',
    'oldAcceptancePresent',
    'candidateAcceptanceSha256',
    'oldAcceptanceSha256',
  ];
  const keys = Object.keys(journal);
  if (keys.length !== allowedKeys.length || keys.some((key) => !allowedKeys.includes(key))) return false;
  const basename = path.basename(activeRoot);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const buildId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
  const checksum = /^[0-9a-f]{64}$/;
  const stagePrefix = `.${basename}-staging-`;
  const safeStage = typeof journal.stageBasename === 'string'
    && path.basename(journal.stageBasename) === journal.stageBasename
    && journal.stageBasename.startsWith(stagePrefix)
    && /^[a-zA-Z0-9._-]+$/.test(journal.stageBasename);
  return journal.schemaVersion === 1
    && journal.phase === 'prepared'
    && typeof journal.publicationId === 'string'
    && uuid.test(journal.publicationId)
    && journal.activeBasename === basename
    && path.basename(journal.activeBasename) === journal.activeBasename
    && safeStage
    && typeof journal.stagedBuildId === 'string'
    && buildId.test(journal.stagedBuildId)
    && (journal.oldBuildId === null
      || (typeof journal.oldBuildId === 'string' && buildId.test(journal.oldBuildId)))
    && typeof journal.oldAcceptancePresent === 'boolean'
    && typeof journal.candidateAcceptanceSha256 === 'string'
    && checksum.test(journal.candidateAcceptanceSha256)
    && (journal.oldAcceptancePresent
      ? typeof journal.oldAcceptanceSha256 === 'string' && checksum.test(journal.oldAcceptanceSha256)
      : journal.oldAcceptanceSha256 === null);
}

async function readPublicationJournal(activeRoot: string): Promise<PublicationJournal | null> {
  const file = publicationJournalPath(activeRoot);
  let bytes: Buffer;
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Market-data publication journal must be a regular sibling file');
    }
    bytes = await fsp.readFile(file);
  } catch (error) {
    if (isMissingFile(error)) return null;
    if (error instanceof Error && /publication journal/i.test(error.message)) throw error;
    throw new Error(
      `Invalid market-data publication journal: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Invalid market-data publication journal JSON');
  }
  if (!validPublicationJournal(parsed, activeRoot)) {
    throw new Error('Invalid market-data publication journal fields');
  }
  return parsed;
}

function validateAcceptanceForBundle(
  acceptance: BacktestAcceptance,
  bundle: MarketDataBundle,
): void {
  assertCurrentMarketDataIndexPolicy(bundle.manifest);
  if (acceptance.estimatorPolicyVersion !== ESTIMATOR_POLICY_VERSION
      || acceptance.policyId !== ACTIVE_ESTIMATOR_POLICY.id) {
    throw new Error('Backtest acceptance does not match the active estimator policy');
  }
  if (acceptance.transactionArtifactSha256 !== transactionArtifactChecksum(bundle.manifest)) {
    throw new Error('Backtest acceptance transaction artifact checksum does not match the staged build');
  }
  const latest = latestEligibleTransactionDate(bundle.transactions);
  if (!latest || acceptance.latestEligibleTransactionDate !== latest
      || acceptance.evaluatedThrough < latest) {
    throw new Error('Backtest acceptance must cover the complete staged transaction index');
  }
  if (!validBacktestAcceptance(acceptance)) {
    throw new Error('Refusing to publish a non-passing backtest acceptance');
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readOptionalFile(ops: PublicationFileOps, file: string): Promise<Buffer | null> {
  try {
    return await ops.readFile(file);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function acceptanceFromBytes(bytes: Buffer): BacktestAcceptance | null {
  try {
    return JSON.parse(bytes.toString('utf8')) as BacktestAcceptance;
  } catch {
    return null;
  }
}

async function validatedAcceptanceFile(
  ops: PublicationFileOps,
  file: string,
  bundle: MarketDataBundle,
  expectedSha256: string | null,
): Promise<{ acceptance: BacktestAcceptance; bytes: Buffer } | null> {
  const bytes = await readOptionalFile(ops, file);
  if (!bytes || (expectedSha256 !== null && sha256Bytes(bytes) !== expectedSha256)) return null;
  const acceptance = acceptanceFromBytes(bytes);
  if (!acceptance) return null;
  try {
    validateAcceptanceForBundle(acceptance, bundle);
  } catch {
    return null;
  }
  return { acceptance, bytes };
}

async function tryValidatedBuild(
  root: string,
  expectedBuildId: string,
  options: PublishOptions,
  mode: BuildValidationMode = 'current',
): Promise<MarketDataBundle | null> {
  try {
    const bundle = await validateBuild(root, options, mode);
    return bundle.manifest.buildId === expectedBuildId ? bundle : null;
  } catch {
    return null;
  }
}

async function renameAndSync(
  ops: PublicationFileOps,
  from: string,
  to: string,
  parent: string,
): Promise<void> {
  await ops.rename(from, to);
  await syncDirectory(parent);
}

async function cleanupPublication(paths: PublicationPaths, ops: PublicationFileOps): Promise<void> {
  const targets: Array<[string, { recursive?: boolean; force?: boolean }]> = [
    [paths.stageRoot, { recursive: true, force: true }],
    [paths.backupRoot, { recursive: true, force: false }],
    [paths.acceptanceCandidate, { force: true }],
    [paths.acceptanceBackup, { force: true }],
  ];
  for (const [target, options] of targets) {
    try { await ops.rm(target, options); } catch { /* committed pair remains authoritative */ }
  }
  try { await ops.rm(paths.journal, { force: true }); } catch { /* next locked entry retries recovery */ }
  try { await syncDirectory(paths.parent); } catch { /* pair was already validated */ }
}

async function loadCommittedNewPair(
  paths: PublicationPaths,
  journal: PublicationJournal,
  options: PublishOptions,
  ops: PublicationFileOps,
): Promise<MarketDataBundle | null> {
  let active = await tryValidatedBuild(paths.activeRoot, journal.stagedBuildId, options);
  if (!active && journal.oldBuildId === null) {
    const staged = await tryValidatedBuild(paths.stageRoot, journal.stagedBuildId, options);
    const candidate = staged && await validatedAcceptanceFile(
      ops,
      paths.acceptanceCandidate,
      staged,
      journal.candidateAcceptanceSha256,
    );
    if (staged && candidate) {
      await renameAndSync(ops, paths.stageRoot, paths.activeRoot, paths.parent);
      active = await tryValidatedBuild(paths.activeRoot, journal.stagedBuildId, options);
    }
  }
  if (!active) return null;

  let activeAcceptance = await validatedAcceptanceFile(
    ops,
    paths.acceptanceTarget,
    active,
    journal.candidateAcceptanceSha256,
  );
  if (!activeAcceptance) {
    const candidate = await validatedAcceptanceFile(
      ops,
      paths.acceptanceCandidate,
      active,
      journal.candidateAcceptanceSha256,
    );
    if (!candidate) return null;
    await renameAndSync(ops, paths.acceptanceCandidate, paths.acceptanceTarget, paths.parent);
    activeAcceptance = await validatedAcceptanceFile(
      ops,
      paths.acceptanceTarget,
      active,
      journal.candidateAcceptanceSha256,
    );
  }
  if (!activeAcceptance) return null;
  const loaded = await loadMarketData(paths.activeRoot, options);
  return loaded
    && loaded.manifest.buildId === journal.stagedBuildId
    && loaded.backtestAcceptance
    && marketDataBacktestAccepted(loaded)
    ? loaded
    : null;
}

async function restoreOldPair(
  paths: PublicationPaths,
  journal: PublicationJournal,
  options: PublishOptions,
  ops: PublicationFileOps,
): Promise<MarketDataBundle | null> {
  if (journal.oldBuildId === null) {
    const active = await tryValidatedBuild(paths.activeRoot, journal.stagedBuildId, options);
    if (active) await ops.rm(paths.activeRoot, { recursive: true, force: true });
    await ops.rm(paths.acceptanceTarget, { force: true });
    await syncDirectory(paths.parent);
    return null;
  }

  let old = await tryValidatedBuild(
    paths.activeRoot,
    journal.oldBuildId,
    options,
    'restorable',
  );
  if (!old) {
    const backup = await tryValidatedBuild(
      paths.backupRoot,
      journal.oldBuildId,
      options,
      'restorable',
    );
    if (!backup) throw new Error('Publication journal has no validated old build to restore');
    if (fs.existsSync(paths.activeRoot)) {
      const activeManifest = readManifest(paths.activeRoot);
      if (activeManifest?.buildId !== journal.stagedBuildId) {
        throw new Error('Publication journal refuses to replace an unrelated active build');
      }
      await ops.rm(paths.activeRoot, { recursive: true, force: true });
      await syncDirectory(paths.parent);
    }
    await renameAndSync(ops, paths.backupRoot, paths.activeRoot, paths.parent);
    old = await tryValidatedBuild(
      paths.activeRoot,
      journal.oldBuildId,
      options,
      'restorable',
    );
    if (!old) throw new Error('Restored old market-data build failed validation');
  }

  if (journal.oldAcceptancePresent) {
    let restored = await validatedAcceptanceFile(
      ops,
      paths.acceptanceTarget,
      old,
      journal.oldAcceptanceSha256,
    );
    if (!restored) {
      const backup = await validatedAcceptanceFile(
        ops,
        paths.acceptanceBackup,
        old,
        journal.oldAcceptanceSha256,
      );
      if (!backup) throw new Error('Publication journal has no validated old acceptance to restore');
      await renameAndSync(ops, paths.acceptanceBackup, paths.acceptanceTarget, paths.parent);
      restored = await validatedAcceptanceFile(
        ops,
        paths.acceptanceTarget,
        old,
        journal.oldAcceptanceSha256,
      );
    }
    if (!restored) throw new Error('Restored old market-data acceptance failed validation');
  } else {
    await ops.rm(paths.acceptanceTarget, { force: true });
    await syncDirectory(paths.parent);
  }

  const loaded = await loadMarketData(paths.activeRoot, options);
  if (!loaded && !journal.oldAcceptancePresent
      && !marketDataManifestHasCurrentPolicyProvenance(old.manifest)) {
    return null;
  }
  if (!loaded || loaded.manifest.buildId !== journal.oldBuildId
      || (journal.oldAcceptancePresent
        && (!loaded.backtestAcceptance || !marketDataBacktestAccepted(loaded)))) {
    throw new Error('Restored old market-data pair failed validation');
  }
  return loaded;
}

async function recoverPublication(
  activeRoot: string,
  journal: PublicationJournal,
  options: PublishOptions,
  ops: PublicationFileOps,
  preference: 'restart' | 'old',
): Promise<MarketDataBundle | null> {
  const paths = publicationPaths(activeRoot, journal);
  if (preference === 'restart') {
    const committed = await loadCommittedNewPair(paths, journal, options, ops);
    if (committed) {
      await cleanupPublication(paths, ops);
      return committed;
    }
  }
  const restored = await restoreOldPair(paths, journal, options, ops);
  await cleanupPublication(paths, ops);
  return restored;
}

/**
 * Completes or rolls back an interrupted accepted-build publication. Callers
 * must hold the market-data refresh lock for the active root.
 */
export async function recoverInterruptedMarketDataPublication(
  activeRoot: string,
  options: PublishOptions = {},
): Promise<MarketDataBundle | null> {
  const journal = await readPublicationJournal(activeRoot);
  if (!journal) return null;
  return recoverPublication(activeRoot, journal, options, publicationFileOps, 'restart');
}

async function publishAcceptedBuild(
  activeRoot: string,
  stageRoot: string,
  acceptance: BacktestAcceptance,
  options: PublishOptions,
  ops: PublicationFileOps,
): Promise<MarketDataBundle> {
  const invalidStage = stagingPathError(activeRoot, stageRoot);
  if (invalidStage) throw invalidStage;
  const interrupted = await readPublicationJournal(activeRoot);
  if (interrupted) await recoverPublication(activeRoot, interrupted, options, ops, 'restart');
  const staged = await validateBuild(stageRoot, options);
  validateAcceptanceForBundle(acceptance, staged);

  const parent = path.dirname(activeRoot);
  const basename = path.basename(activeRoot);
  const publicationId = randomUUID();
  const acceptanceTarget = backtestAcceptancePath(activeRoot);
  let oldBuild: MarketDataBundle | null = null;
  if (fs.existsSync(activeRoot)) {
    oldBuild = await validateBuild(activeRoot, options, 'restorable');
  }
  const oldAcceptanceBytes = await readOptionalFile(ops, acceptanceTarget);
  const matchingOldAcceptance = oldBuild && oldAcceptanceBytes
    ? await validatedAcceptanceFile(ops, acceptanceTarget, oldBuild, null)
    : null;
  const candidateBytes = Buffer.from(`${stableJson(acceptance)}\n`);
  const journal: PublicationJournal = {
    schemaVersion: 1,
    phase: 'prepared',
    publicationId,
    activeBasename: basename,
    stageBasename: path.basename(stageRoot),
    stagedBuildId: staged.manifest.buildId,
    oldBuildId: oldBuild?.manifest.buildId ?? null,
    oldAcceptancePresent: matchingOldAcceptance !== null,
    candidateAcceptanceSha256: sha256Bytes(candidateBytes),
    oldAcceptanceSha256: matchingOldAcceptance ? sha256Bytes(matchingOldAcceptance.bytes) : null,
  };
  const paths = publicationPaths(activeRoot, journal);
  for (const target of [
    paths.journal,
    paths.backupRoot,
    paths.acceptanceCandidate,
    paths.acceptanceBackup,
  ]) {
    if (fs.existsSync(target)) throw new Error(`Refusing to overwrite market-data publication recovery path: ${target}`);
  }
  let journalPrepared = false;
  let published!: MarketDataBundle;

  try {
    await writeDurableUnique(paths.acceptanceCandidate, candidateBytes);
    if (matchingOldAcceptance) {
      await writeDurableUnique(paths.acceptanceBackup, matchingOldAcceptance.bytes);
    }
    await writeDurableJournal(paths.journal, journal);
    journalPrepared = true;
    try {
      await renameAndSync(ops, activeRoot, paths.backupRoot, parent);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await renameAndSync(ops, stageRoot, activeRoot, parent);
    await renameAndSync(ops, paths.acceptanceCandidate, acceptanceTarget, parent);

    const loaded = await loadMarketData(activeRoot, options);
    if (!loaded
        || loaded.manifest.buildId !== staged.manifest.buildId
        || !loaded.backtestAcceptance
        || !marketDataBacktestAccepted(loaded)) {
      throw new Error('Published market-data build and acceptance pair failed validation');
    }
    published = loaded;
  } catch (publicationError) {
    try {
      if (journalPrepared) {
        await recoverPublication(activeRoot, journal, options, ops, 'old');
      } else {
        await cleanupPublication(paths, ops);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [publicationError, rollbackError],
        `Market-data publication failed and rollback failed: ${
          publicationError instanceof Error ? publicationError.message : String(publicationError)
        }`,
      );
    }
    throw publicationError;
  }

  // Pair validation is the commit point. Cleanup failure leaves the validated
  // new pair authoritative and is retried from the durable journal if needed.
  await cleanupPublication(paths, ops);
  return published;
}

/**
 * Publishes a staged build and its checksum-/policy-bound acceptance as one
 * recoverable final-state transition.
 */
export async function publishStagedBuildWithAcceptance(
  root: string,
  stage: string,
  acceptance: BacktestAcceptance,
  options: PublishOptions = {},
): Promise<MarketDataBundle> {
  return publishAcceptedBuild(root, stage, acceptance, options, {
    ...publicationFileOps,
    ...options.publicationFileOps,
  });
}
