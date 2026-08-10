import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadExits } from './mrt.ts';
import type { RunRange } from './range.ts';
import {
  compareBenchmarkCase,
  failedBenchmarkCase,
  selectBenchmarkCases,
  summarizeBenchmark,
  type BenchmarkComparison,
  type BenchmarkSummary,
} from './route-benchmark.ts';
import { CACHE_PATH, type RouteCache } from './route-cache.ts';
import type { FetchResult } from './types.ts';
import {
  normalizeValhallaBaseUrl,
  routeValhallaWalkDistances,
  safeValhallaErrorMessage,
  valhallaEndpointIdentifier,
} from './valhalla-routing.ts';

export interface RouteBenchmarkOptions {
  rootDir: string;
  profileId: string;
  range: RunRange;
  limit: number;
  valhallaBaseUrl: string;
  requestDelayMs: number;
}

export interface RouteBenchmarkDeps {
  preflight: (directory: string) => void;
  route: typeof routeValhallaWalkDistances;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  progress: (message: string) => void;
  publish: (tmpPath: string, desiredPath: string) => string;
  removeTemporary: (tmpPath: string) => void;
}

export interface ArtifactPreflightFs {
  writeExclusive(file: string): void;
  link(source: string, target: string): void;
  remove(file: string): void;
}

export const ARTIFACT_PREFLIGHT_ERROR =
  'route benchmark artifact filesystem does not support atomic no-clobber publication';
export const ARTIFACT_CLEANUP_ERROR =
  'route benchmark published artifact but could not remove sensitive temporary data';

export interface RouteBenchmarkArtifact {
  schemaVersion: 1;
  benchmarkedAt: string;
  profileId: string;
  range: RunRange;
  inputDates: string[];
  valhallaEndpoint: string;
  summary: BenchmarkSummary;
  comparisons: BenchmarkComparison[];
}

export function parseBenchmarkLimit(argv: string[]): number {
  const allowed = new Set(['--profile', '--date', '--from', '--to', '--limit']);
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    if (!allowed.has(name)) {
      throw new Error('unknown argument; expected --profile, --date or --from/--to, and optional --limit.');
    }
    if (seen.has(name)) throw new Error(`${name} may be specified only once.`);
    seen.add(name);
    if (equals !== -1) {
      if (token.slice(equals + 1) === '') throw new Error(`${name} requires a value.`);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    index += 1;
  }

  const occurrences = argv.filter((argument) =>
    argument === '--limit' || argument.startsWith('--limit='));
  if (occurrences.length === 0) return 25;
  if (occurrences.length !== 1) {
    throw new Error('--limit may be specified only once.');
  }

  const index = argv.indexOf(occurrences[0]);
  const raw = occurrences[0] === '--limit'
    ? argv[index + 1]
    : occurrences[0].slice('--limit='.length);
  if (raw === undefined || !/^[0-9]+$/.test(raw)) {
    throw new Error(`invalid --limit "${raw ?? ''}"; expected decimal integer digits from 1 through 200.`);
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error(`invalid --limit "${raw ?? ''}"; expected an integer from 1 through 200.`);
  }
  return limit;
}

export function inclusiveDates(from: string, to: string): string[] {
  const dates: string[] = [];
  const end = Date.parse(`${to}T00:00:00.000Z`);
  for (let timestamp = Date.parse(`${from}T00:00:00.000Z`); timestamp <= end; timestamp += 86_400_000) {
    dates.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return dates;
}

export function benchmarkArtifactPath(
  rootDir: string,
  profileId: string,
  label: string,
  now: Date,
): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, '');
  return path.join(
    rootDir,
    'state',
    'route-benchmarks',
    profileId,
    label,
    `valhalla-${timestamp}.json`,
  );
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isBenchmarkListing(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const coordinate = value.coordinate;
  const validCoordinate = coordinate === null
    || (isRecord(coordinate)
      && typeof coordinate.lat === 'number'
      && Number.isFinite(coordinate.lat)
      && typeof coordinate.lng === 'number'
      && Number.isFinite(coordinate.lng));
  return typeof value.title === 'string'
    && isNullableString(value.addressOrArea)
    && isNullableString(value.totalPrice)
    && isNullableString(value.totalPing)
    && isNullableString(value.unitPrice)
    && isNullableString(value.age)
    && (value.id === null || (typeof value.id === 'number' && Number.isFinite(value.id)))
    && validCoordinate;
}

function readFetchResult(file: string, date: string): FetchResult {
  if (!fs.existsSync(file)) {
    throw new Error(`missing listing input for ${date}: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`listing input for ${date} is not valid JSON: ${file}`);
  }
  if (!isRecord(parsed)
    || parsed.from !== date
    || parsed.to !== date
    || typeof parsed.fetchedAt !== 'string'
    || !Number.isFinite(Date.parse(parsed.fetchedAt))
    || typeof parsed.count !== 'number'
    || !Number.isSafeInteger(parsed.count)
    || parsed.count < 0
    || !Array.isArray(parsed.listings)
    || parsed.count !== parsed.listings.length
    || parsed.listings.some((listing) => !isBenchmarkListing(listing))) {
    throw new Error(`listing input for ${date} has invalid FetchResult shape: ${file}`);
  }
  return parsed as unknown as FetchResult;
}

function readRouteCache(file: string): RouteCache {
  if (!fs.existsSync(file)) {
    throw new Error(`missing route cache input: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`route cache input is not valid JSON: ${file}`);
  }
  const valid = isRecord(parsed) && Object.values(parsed).every((distances) =>
    Array.isArray(distances)
    && distances.every((distance) => distance === null
      || (typeof distance === 'number' && Number.isFinite(distance) && distance >= 0)));
  if (!valid) {
    throw new Error(`route cache input has invalid shape: ${file}`);
  }
  return parsed as RouteCache;
}

let temporaryArtifactSequence = 0;

const defaultArtifactPreflightFs: ArtifactPreflightFs = {
  writeExclusive: (file) => fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 }),
  link: (source, target) => fs.linkSync(source, target),
  remove: (file) => fs.rmSync(file, { force: true }),
};

function uniqueProbePath(directory: string, kind: 'source' | 'target'): string {
  const sequence = temporaryArtifactSequence;
  temporaryArtifactSequence += 1;
  return path.join(directory, `.atomic-publish-probe-${process.pid}-${sequence}-${kind}`);
}

export function preflightHardLinkPublication(
  directory: string,
  operations: ArtifactPreflightFs = defaultArtifactPreflightFs,
): void {
  const probeSource = uniqueProbePath(directory, 'source');
  const probeTarget = uniqueProbePath(directory, 'target');
  let failure: unknown = null;
  try {
    fs.mkdirSync(directory, { recursive: true });
    operations.writeExclusive(probeSource);
    operations.link(probeSource, probeTarget);
  } catch {
    failure = new Error(ARTIFACT_PREFLIGHT_ERROR);
  } finally {
    try {
      operations.remove(probeTarget);
    } catch {
      failure = new Error(ARTIFACT_PREFLIGHT_ERROR);
    }
    try {
      operations.remove(probeSource);
    } catch {
      failure = new Error(ARTIFACT_PREFLIGHT_ERROR);
    }
  }
  if (failure) throw failure;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function writeUniqueTemporarySibling(artifactPath: string, contents: string): string {
  for (;;) {
    const sequence = temporaryArtifactSequence;
    temporaryArtifactSequence += 1;
    const tmpPath = `${artifactPath}.tmp-${process.pid}-${sequence}`;
    try {
      fs.writeFileSync(tmpPath, contents, { flag: 'wx' });
      return tmpPath;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue;
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // Preserve the original write failure.
      }
      throw error;
    }
  }
}

function collisionPath(desiredPath: string, collisionIndex: number): string {
  return collisionIndex === 0
    ? desiredPath
    : desiredPath.replace(/\.json$/, `-${collisionIndex}.json`);
}

function publishNoClobber(tmpPath: string, desiredPath: string): string {
  for (let collisionIndex = 0;; collisionIndex += 1) {
    const candidatePath = collisionPath(desiredPath, collisionIndex);
    try {
      fs.linkSync(tmpPath, candidatePath);
      return candidatePath;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue;
      throw error;
    }
  }
}

export async function runRouteBenchmark(
  options: RouteBenchmarkOptions,
  deps: Partial<RouteBenchmarkDeps> = {},
): Promise<{ artifactPath: string; artifact: RouteBenchmarkArtifact }> {
  const route = deps.route ?? routeValhallaWalkDistances;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const progress = deps.progress ?? (() => {});
  const publish = deps.publish ?? publishNoClobber;
  const removeTemporary = deps.removeTemporary ?? ((tmpPath) => fs.rmSync(tmpPath));
  const preflight = deps.preflight ?? preflightHardLinkPublication;
  const valhallaBaseUrl = normalizeValhallaBaseUrl(options.valhallaBaseUrl);
  const valhallaEndpoint = valhallaEndpointIdentifier(valhallaBaseUrl);
  const dates = inclusiveDates(options.range.from, options.range.to);
  const artifactDirectory = path.join(
    options.rootDir,
    'state',
    'route-benchmarks',
    options.profileId,
    options.range.label,
  );
  try {
    preflight(artifactDirectory);
  } catch {
    throw new Error(ARTIFACT_PREFLIGHT_ERROR);
  }
  const runs = dates.map((date) => ({
    date,
    result: readFetchResult(
      path.join(options.rootDir, 'state', 'runs', options.profileId, date, 'listings.json'),
      date,
    ),
  }));
  const exitsFile = path.join(options.rootDir, 'data', 'taipei_mrt_exits.csv');
  if (!fs.existsSync(exitsFile)) {
    throw new Error(`missing MRT exits input: ${exitsFile}`);
  }
  const exits = loadExits(exitsFile);
  const routeCache = readRouteCache(path.join(options.rootDir, CACHE_PATH));
  const selection = selectBenchmarkCases(runs, exits, routeCache, options.limit);
  const comparisons: BenchmarkComparison[] = [];

  for (let i = 0; i < selection.cases.length; i += 1) {
    const benchmarkCase = selection.cases[i];
    try {
      const distances = await route(
        benchmarkCase.origin,
        benchmarkCase.candidates.map(({ exit }) => ({ lat: exit.lat, lng: exit.lng })),
        { baseUrl: valhallaBaseUrl },
      );
      comparisons.push(compareBenchmarkCase(benchmarkCase, distances));
    } catch (error) {
      comparisons.push(failedBenchmarkCase(benchmarkCase, safeValhallaErrorMessage(error)));
    }
    progress(`Valhalla benchmark ${i + 1}/${selection.cases.length}`);
    if (i + 1 < selection.cases.length) await sleep(options.requestDelayMs);
  }

  const benchmarkTime = now();
  const artifact: RouteBenchmarkArtifact = {
    schemaVersion: 1,
    benchmarkedAt: benchmarkTime.toISOString(),
    profileId: options.profileId,
    range: { ...options.range },
    inputDates: dates,
    valhallaEndpoint,
    summary: summarizeBenchmark(selection, comparisons),
    comparisons,
  };
  const desiredArtifactPath = benchmarkArtifactPath(
    options.rootDir,
    options.profileId,
    options.range.label,
    benchmarkTime,
  );
  const tmpPath = writeUniqueTemporarySibling(
    desiredArtifactPath,
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  let publishedPath: string | undefined;
  let publicationError: unknown;
  let publicationFailed = false;
  try {
    publishedPath = publish(tmpPath, desiredArtifactPath);
  } catch (error) {
    publicationFailed = true;
    publicationError = error;
  }

  let cleanupFailed = false;
  try {
    removeTemporary(tmpPath);
  } catch {
    cleanupFailed = true;
  }

  if (publicationFailed) throw publicationError;
  if (cleanupFailed) throw new Error(ARTIFACT_CLEANUP_ERROR);
  return { artifactPath: publishedPath!, artifact };
}
