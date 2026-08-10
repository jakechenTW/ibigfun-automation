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
import { routeValhallaWalkDistances } from './valhalla-routing.ts';

export interface RouteBenchmarkOptions {
  rootDir: string;
  profileId: string;
  range: RunRange;
  limit: number;
  valhallaBaseUrl: string;
  requestDelayMs: number;
}

export interface RouteBenchmarkDeps {
  route: typeof routeValhallaWalkDistances;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  progress: (message: string) => void;
}

export interface RouteBenchmarkArtifact {
  schemaVersion: 1;
  benchmarkedAt: string;
  profileId: string;
  range: RunRange;
  inputDates: string[];
  valhallaBaseUrl: string;
  summary: BenchmarkSummary;
  comparisons: BenchmarkComparison[];
}

export function parseBenchmarkLimit(argv: string[]): number {
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
  const limit = Number(raw);
  if (raw === undefined || raw.startsWith('--') || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
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
    || typeof parsed.from !== 'string'
    || typeof parsed.to !== 'string'
    || typeof parsed.fetchedAt !== 'string'
    || !Number.isSafeInteger(parsed.count)
    || !Array.isArray(parsed.listings)
    || parsed.listings.some((listing) => !isRecord(listing))) {
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

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runRouteBenchmark(
  options: RouteBenchmarkOptions,
  deps: Partial<RouteBenchmarkDeps> = {},
): Promise<{ artifactPath: string; artifact: RouteBenchmarkArtifact }> {
  const route = deps.route ?? routeValhallaWalkDistances;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const progress = deps.progress ?? (() => {});
  const dates = inclusiveDates(options.range.from, options.range.to);
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
        { baseUrl: options.valhallaBaseUrl },
      );
      comparisons.push(compareBenchmarkCase(benchmarkCase, distances));
    } catch (error) {
      comparisons.push(failedBenchmarkCase(benchmarkCase, safeError(error)));
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
    valhallaBaseUrl: options.valhallaBaseUrl,
    summary: summarizeBenchmark(selection, comparisons),
    comparisons,
  };
  const artifactPath = benchmarkArtifactPath(
    options.rootDir,
    options.profileId,
    options.range.label,
    benchmarkTime,
  );
  const tmpPath = `${artifactPath}.tmp`;
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(artifact, null, 2)}\n`);
    fs.renameSync(tmpPath, artifactPath);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Preserve the original persistence failure.
    }
    throw error;
  }
  return { artifactPath, artifact };
}
