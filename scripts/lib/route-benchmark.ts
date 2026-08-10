import { enrichOffline } from './enrich-offline.ts';
import type { LatLng } from './geo.ts';
import type { MrtExit, NearestExit } from './mrt.ts';
import { cacheKey, type RouteCache } from './route-cache.ts';
import type { FetchResult } from './types.ts';
import { pickWalk, type WalkPick } from './walk.ts';

export type BenchmarkSkipReason =
  | 'no-coordinate'
  | 'coordinate-conflict'
  | 'no-candidates'
  | 'ors-cache-miss'
  | 'ors-cache-shape';

export interface DatedFetchResult {
  date: string;
  result: FetchResult;
}

export interface BenchmarkCase {
  date: string;
  listingId: number | null;
  routeKey: string;
  origin: LatLng;
  candidates: NearestExit[];
  orsDistances: (number | null)[];
}

export interface CaseSelection {
  scanned: number;
  eligibleBeforeLimit: number;
  duplicateRouteKeys: number;
  skipped: Record<BenchmarkSkipReason, number>;
  cases: BenchmarkCase[];
}

const emptySkipped = (): Record<BenchmarkSkipReason, number> => ({
  'no-coordinate': 0,
  'coordinate-conflict': 0,
  'no-candidates': 0,
  'ors-cache-miss': 0,
  'ors-cache-shape': 0,
});

export function selectBenchmarkCases(
  runs: DatedFetchResult[],
  exits: MrtExit[],
  routeCache: RouteCache,
  limit: number,
): CaseSelection {
  const skipped = emptySkipped();
  const eligible: BenchmarkCase[] = [];
  let scanned = 0;

  for (const run of runs) {
    for (const listing of run.result.listings) {
      scanned += 1;
      const enriched = enrichOffline(listing, exits);
      if (!listing.coordinate) {
        skipped['no-coordinate'] += 1;
        continue;
      }
      if (enriched.coordConsistent === false) {
        skipped['coordinate-conflict'] += 1;
        continue;
      }
      if (enriched.candidates.length === 0) {
        skipped['no-candidates'] += 1;
        continue;
      }

      const routeKey = cacheKey(listing.coordinate, enriched.candidates);
      const orsDistances = routeCache[routeKey];
      if (!orsDistances) {
        skipped['ors-cache-miss'] += 1;
        continue;
      }
      if (orsDistances.length !== enriched.candidates.length) {
        skipped['ors-cache-shape'] += 1;
        continue;
      }
      eligible.push({
        date: run.date,
        listingId: listing.id,
        routeKey,
        origin: { ...listing.coordinate },
        candidates: enriched.candidates,
        orsDistances: [...orsDistances],
      });
    }
  }

  eligible.sort((a, b) =>
    a.date.localeCompare(b.date)
    || (a.listingId === null ? 1 : b.listingId === null ? -1 : a.listingId - b.listingId)
    || a.routeKey.localeCompare(b.routeKey));
  const seenRouteKeys = new Set<string>();
  const unique = eligible.filter((benchmarkCase) => {
    if (seenRouteKeys.has(benchmarkCase.routeKey)) return false;
    seenRouteKeys.add(benchmarkCase.routeKey);
    return true;
  });

  return {
    scanned,
    eligibleBeforeLimit: unique.length,
    duplicateRouteKeys: eligible.length - unique.length,
    skipped,
    cases: unique.slice(0, limit),
  };
}

export type WalkTransition =
  | 'true->true' | 'true->false' | 'true->null'
  | 'false->true' | 'false->false' | 'false->null'
  | 'null->true' | 'null->false' | 'null->null';

export interface BenchmarkComparison {
  benchmarkCase: BenchmarkCase;
  valhallaDistances: (number | null)[] | null;
  error: string | null;
  ors: WalkPick;
  valhalla: WalkPick;
  transition: WalkTransition;
  nearestExitAgreement: boolean | null;
  boundaryCase: boolean;
  sameExitDeltaM: number | null;
  sameExitDeltaPercent: number | null;
}

export interface BenchmarkSummary {
  scanned: number;
  selected: number;
  eligibleBeforeLimit: number;
  duplicateRouteKeys: number;
  skipped: Record<BenchmarkSkipReason, number>;
  completed: number;
  failed: number;
  orsUsable: number;
  valhallaUsable: number;
  orsPlausible: number;
  valhallaPlausible: number;
  nearestExitAgreement: number;
  nearestExitCompared: number;
  withinWalkAgreement: number;
  withinWalkCompared: number;
  transitions: Record<WalkTransition, number>;
  boundaryCases: number;
  sameExitDeltaCount: number;
  sameExitMeanAbsoluteDeltaM: number | null;
  sameExitMeanAbsoluteDeltaPercent: number | null;
}

const transitionFor = (ors: WalkPick, valhalla: WalkPick): WalkTransition =>
  `${String(ors.withinWalk)}->${String(valhalla.withinWalk)}` as WalkTransition;

function selectedCandidateIndex(
  routed: (number | null)[] | null,
  candidateCount: number,
): number | null {
  if (routed === null) return null;
  let best: { index: number; distanceM: number } | null = null;
  for (let index = 0; index < candidateCount; index += 1) {
    const distanceM = routed[index];
    if (distanceM !== null && distanceM !== undefined && (!best || distanceM < best.distanceM)) {
      best = { index, distanceM };
    }
  }
  return best?.index ?? null;
}

function sameExit(
  ors: WalkPick,
  valhalla: WalkPick,
  orsDistances: (number | null)[],
  valhallaDistances: (number | null)[] | null,
  candidateCount: number,
): boolean {
  if (ors.walk === null || valhalla.walk === null) return false;
  const orsIndex = selectedCandidateIndex(orsDistances, candidateCount);
  const valhallaIndex = selectedCandidateIndex(valhallaDistances, candidateCount);
  return orsIndex !== null && orsIndex === valhallaIndex;
}

function isBoundary(pick: WalkPick): boolean {
  const distance = pick.walk?.distanceM;
  return distance !== undefined && distance >= 700 && distance <= 900;
}

function comparisonFor(
  benchmarkCase: BenchmarkCase,
  valhallaDistances: (number | null)[] | null,
  error: string | null,
): BenchmarkComparison {
  const ors = pickWalk(benchmarkCase.candidates, benchmarkCase.orsDistances);
  const valhalla = pickWalk(benchmarkCase.candidates, valhallaDistances);
  const exitsMatch = sameExit(
    ors,
    valhalla,
    benchmarkCase.orsDistances,
    valhallaDistances,
    benchmarkCase.candidates.length,
  );
  const sameExitDeltaM = exitsMatch && ors.walk && valhalla.walk
    ? valhalla.walk.distanceM - ors.walk.distanceM
    : null;
  const sameExitDeltaPercent = sameExitDeltaM !== null && ors.walk && ors.walk.distanceM !== 0
    ? Math.round((sameExitDeltaM / ors.walk.distanceM) * 10_000) / 100
    : null;

  return {
    benchmarkCase,
    valhallaDistances: valhallaDistances === null ? null : [...valhallaDistances],
    error,
    ors,
    valhalla,
    transition: transitionFor(ors, valhalla),
    nearestExitAgreement: ors.walk !== null && valhalla.walk !== null ? exitsMatch : null,
    boundaryCase: isBoundary(ors) || isBoundary(valhalla),
    sameExitDeltaM,
    sameExitDeltaPercent,
  };
}

export function compareBenchmarkCase(
  benchmarkCase: BenchmarkCase,
  valhallaDistances: (number | null)[],
): BenchmarkComparison {
  return comparisonFor(benchmarkCase, valhallaDistances, null);
}

export function failedBenchmarkCase(
  benchmarkCase: BenchmarkCase,
  error: string,
): BenchmarkComparison {
  return comparisonFor(benchmarkCase, null, error);
}

const emptyTransitions = (): Record<WalkTransition, number> => ({
  'true->true': 0,
  'true->false': 0,
  'true->null': 0,
  'false->true': 0,
  'false->false': 0,
  'false->null': 0,
  'null->true': 0,
  'null->false': 0,
  'null->null': 0,
});

function meanAbsolute(values: number[]): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;
  return Math.round(mean * 100) / 100;
}

export function summarizeBenchmark(
  selection: CaseSelection,
  comparisons: BenchmarkComparison[],
): BenchmarkSummary {
  const transitions = emptyTransitions();
  let completed = 0;
  let failed = 0;
  let orsUsable = 0;
  let valhallaUsable = 0;
  let orsPlausible = 0;
  let valhallaPlausible = 0;
  let nearestExitAgreement = 0;
  let nearestExitCompared = 0;
  let withinWalkAgreement = 0;
  let withinWalkCompared = 0;
  let boundaryCases = 0;
  const sameExitDeltas: number[] = [];
  const sameExitDeltaPercents: number[] = [];

  for (const comparison of comparisons) {
    if (comparison.error === null) completed += 1;
    else failed += 1;
    if (comparison.benchmarkCase.orsDistances.some((distance) => distance !== null)) orsUsable += 1;
    if (comparison.valhallaDistances?.some((distance) => distance !== null)) valhallaUsable += 1;
    if (comparison.ors.routeOk === true) orsPlausible += 1;
    if (comparison.valhalla.routeOk === true) valhallaPlausible += 1;
    if (comparison.nearestExitAgreement !== null) {
      nearestExitCompared += 1;
      if (comparison.nearestExitAgreement) nearestExitAgreement += 1;
    }
    if (comparison.ors.withinWalk !== null && comparison.valhalla.withinWalk !== null) {
      withinWalkCompared += 1;
      if (comparison.ors.withinWalk === comparison.valhalla.withinWalk) withinWalkAgreement += 1;
    }
    transitions[comparison.transition] += 1;
    if (comparison.boundaryCase) boundaryCases += 1;
    if (comparison.sameExitDeltaM !== null) sameExitDeltas.push(comparison.sameExitDeltaM);
    if (comparison.sameExitDeltaPercent !== null) sameExitDeltaPercents.push(comparison.sameExitDeltaPercent);
  }

  return {
    scanned: selection.scanned,
    selected: selection.cases.length,
    eligibleBeforeLimit: selection.eligibleBeforeLimit,
    duplicateRouteKeys: selection.duplicateRouteKeys,
    skipped: { ...selection.skipped },
    completed,
    failed,
    orsUsable,
    valhallaUsable,
    orsPlausible,
    valhallaPlausible,
    nearestExitAgreement,
    nearestExitCompared,
    withinWalkAgreement,
    withinWalkCompared,
    transitions,
    boundaryCases,
    sameExitDeltaCount: sameExitDeltas.length,
    sameExitMeanAbsoluteDeltaM: meanAbsolute(sameExitDeltas),
    sameExitMeanAbsoluteDeltaPercent: meanAbsolute(sameExitDeltaPercents),
  };
}
