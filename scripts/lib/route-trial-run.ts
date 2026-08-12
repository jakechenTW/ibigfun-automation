import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadExits, type MrtExit } from './mrt.ts';
import type { RunRange } from './range.ts';
import {
  reliableOrsTrialWalk,
  selectRouteTrialListings,
  unavailableTrialWalk,
  valhallaTrialWalk,
  type RouteTrialComparison,
  type RouteTrialSelection,
} from './route-trial.ts';
import {
  enrichedPath,
  listingsPath,
  routeTrialRequestPath,
  routeTrialResultPath,
} from './runpaths.ts';
import {
  getValhallaTrialCacheEntry,
  loadValhallaTrialCache,
  putValhallaTrialCacheEntry,
  saveValhallaTrialCacheAtomic,
  trialEndpointKey,
  type ValhallaTrialCache,
} from './valhalla-trial-cache.ts';
import {
  normalizeValhallaBaseUrl,
  routeValhallaWalkDistances,
  safeValhallaErrorMessage,
  valhallaEndpointIdentifier,
} from './valhalla-routing.ts';

const REQUEST_ERROR = 'Valhalla trial request is missing or invalid';
const LISTINGS_ERROR = 'Valhalla trial listings input is missing or invalid';
const ENRICHED_ERROR = 'Valhalla trial enriched input is missing or invalid';
const MRT_ERROR = 'Valhalla trial MRT input is missing or invalid';
const CACHE_ERROR = 'Valhalla trial cache is invalid';
const MIN_REQUEST_DELAY_MS = 1000;
export const ROUTE_TRIAL_PERSISTENCE_ERROR = 'Valhalla trial result persistence failed';

export interface RouteTrialOptions {
  rootDir: string;
  profileId: string;
  range: RunRange;
  valhallaBaseUrl: string;
  requestDelayMs: number;
}

export interface RouteTrialSummary {
  requested: number;
  completed: number;
  cacheHits: number;
  apiCalls: number;
  unavailable: number;
}

export interface RouteTrialArtifact {
  schemaVersion: 1;
  profileId: string;
  rangeLabel: string;
  generatedAt: string;
  valhallaEndpoint: string;
  comparisons: RouteTrialComparison[];
  summary: RouteTrialSummary;
}

export interface RouteTrialDeps {
  route: typeof routeValhallaWalkDistances;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  progress: (message: string) => void;
  saveCache: typeof saveValhallaTrialCacheAtomic;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

function readJson(file: string, safeMessage: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    throw new Error(safeMessage);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function enrichmentFields(): Record<string, unknown> {
  return {
    totalPriceWan: null,
    totalPriceNtd: null,
    totalPingNum: null,
    unitPriceWan: null,
    ageNum: null,
    monthlyMortgage: null,
    district: null,
    walk: null,
    withinWalk: null,
    regionGate: 'review',
    reliability: {
      coordPresent: false,
      coordConsistent: null,
      routeOk: null,
      ratio: null,
      reason: null,
    },
    signals: { auctionKeyword: false },
    hardExclusion: { excluded: false, reasons: [] },
    tenure: {
      firstListedDate: null,
      daysOnMarket: null,
      recordCount: 0,
      sourceCount: 0,
      priceTrend: 'unknown',
      firstPrice: null,
      latestPrice: null,
    },
    tenureGate: 'review',
    marketEstimate: {
      status: 'unavailable',
      confidence: 'low',
      subjectOwnershipEvidence: 'unspecified',
      subjectLocationEvidence: null,
      marketUnitPriceMedian: null,
      marketUnitPriceP25: null,
      marketUnitPriceP75: null,
      selectedStage: null,
      sourceFreshness: {
        transactionCheckedAt: null,
        doorplateCheckedAt: null,
        transactionStale: false,
        doorplateStale: false,
      },
      unavailableReasons: [],
      comparables: [],
      excludedCandidates: [],
    },
    marketScenarios: {
      registeredUse: { value: 'unknown', source: 'unknown', detail: null },
      parkingFamily: 'unknown',
      parkingCountAssumption: null,
      sourceFreshness: {
        transactionCheckedAt: null,
        doorplateCheckedAt: null,
        transactionStale: false,
        doorplateStale: false,
      },
      scenarios: [],
      reasons: [],
    },
  };
}

function probeRequest(profileId: string, range: RunRange): Record<string, unknown> {
  return { schemaVersion: 1, profileId, rangeLabel: range.label, listingIndexes: [] };
}

function hasOutOfRangeListingCoordinate(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.listings)) return false;
  return value.listings.some((item) => {
    if (!isRecord(item) || !isRecord(item.coordinate)) return false;
    const { lat, lng } = item.coordinate;
    return typeof lat === 'number'
      && Number.isFinite(lat)
      && typeof lng === 'number'
      && Number.isFinite(lng)
      && (lat < -90 || lat > 90 || lng < -180 || lng > 180);
  });
}

function assertListingsInput(
  fetched: unknown,
  profileId: string,
  range: RunRange,
  exits: MrtExit[],
): void {
  if (hasOutOfRangeListingCoordinate(fetched)) throw new Error(LISTINGS_ERROR);
  const record = isRecord(fetched) ? fetched : {};
  const sourceListings = Array.isArray(record.listings) ? record.listings : [];
  const syntheticEnriched = {
    from: record.from,
    to: record.to,
    enrichedAt: '2000-01-01T00:00:00.000Z',
    count: record.count,
    withinWalkCount: 0,
    manualReviewCount: 0,
    hardExcludedCount: 0,
    tenureEligible: 0,
    tenureExpired: 0,
    tenureReview: 0,
    outOfRegionCount: 0,
    inRegionTooFarCount: 0,
    marketReliable: 0,
    marketReview: 0,
    marketUnavailable: 0,
    marketDataStale: 0,
    listings: sourceListings.map((item) => ({
      ...(isRecord(item) ? item : {}),
      ...enrichmentFields(),
    })),
  };
  try {
    selectRouteTrialListings(
      probeRequest(profileId, range),
      profileId,
      range,
      fetched,
      syntheticEnriched,
      exits,
    );
  } catch {
    throw new Error(LISTINGS_ERROR);
  }
}

function assertEnrichedInput(
  enriched: unknown,
  profileId: string,
  range: RunRange,
  exits: MrtExit[],
): void {
  if (hasOutOfRangeListingCoordinate(enriched)) throw new Error(ENRICHED_ERROR);
  const record = isRecord(enriched) ? enriched : {};
  const syntheticFetched = {
    from: record.from,
    to: record.to,
    fetchedAt: '2000-01-01T00:00:00.000Z',
    count: record.count,
    listings: record.listings,
  };
  try {
    selectRouteTrialListings(
      probeRequest(profileId, range),
      profileId,
      range,
      syntheticFetched,
      enriched,
      exits,
    );
  } catch {
    throw new Error(ENRICHED_ERROR);
  }
}

function loadMrtInput(file: string): MrtExit[] {
  try {
    const contents = fs.readFileSync(file, 'utf8');
    const rows = contents.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim() !== '');
    if (rows[0] !== 'station_id,line,name_zh,exit_id,latitude,longitude' || rows.length < 2) {
      throw new Error(MRT_ERROR);
    }
    const validNumber = (raw: string, minimum: number, maximum: number): boolean => {
      if (raw.trim() !== raw || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return false;
      const value = Number(raw);
      return Number.isFinite(value) && value >= minimum && value <= maximum;
    };
    if (rows.slice(1).some((row) => {
      const fields = row.split(',');
      if (fields.length !== 6) return true;
      const [stationId, line, nameZh, _exitId, latitude, longitude] = fields;
      return stationId === '' || line === '' || nameZh === ''
        || !validNumber(latitude, -90, 90)
        || !validNumber(longitude, -180, 180);
    })) throw new Error(MRT_ERROR);
    const exits = loadExits(file);
    if (exits.length !== rows.length - 1) {
      throw new Error(MRT_ERROR);
    }
    return exits;
  } catch {
    throw new Error(MRT_ERROR);
  }
}

function loadCacheInput(rootDir: string): ValhallaTrialCache {
  try {
    return loadValhallaTrialCache(rootDir);
  } catch {
    throw new Error(CACHE_ERROR);
  }
}

function persistArtifact(file: string, artifact: RouteTrialArtifact): void {
  const temporaryPath = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let published = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, file);
    published = true;
  } catch {
    throw new Error(ROUTE_TRIAL_PERSISTENCE_ERROR);
  } finally {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      if (!published) throw new Error(ROUTE_TRIAL_PERSISTENCE_ERROR);
    }
  }
}

function comparison(
  selection: RouteTrialSelection,
  distances: (number | null)[] | null,
  error: string | null,
): RouteTrialComparison {
  return {
    listingIndex: selection.listingIndex,
    listingId: selection.listingId,
    ors: reliableOrsTrialWalk(selection.enriched),
    valhalla: valhallaTrialWalk(selection, distances),
    error,
  };
}

export async function runRouteTrial(
  options: RouteTrialOptions,
  deps: Partial<RouteTrialDeps> = {},
): Promise<{ artifactPath: string; artifact: RouteTrialArtifact }> {
  const route = deps.route ?? routeValhallaWalkDistances;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const progress = deps.progress ?? (() => {});
  const saveCache = deps.saveCache ?? saveValhallaTrialCacheAtomic;
  const normalizedBaseUrl = normalizeValhallaBaseUrl(options.valhallaBaseUrl);
  const requestDelayMs = Number.isFinite(options.requestDelayMs)
    ? Math.max(options.requestDelayMs, MIN_REQUEST_DELAY_MS)
    : MIN_REQUEST_DELAY_MS;
  const runPath = (relative: string): string => path.join(options.rootDir, relative);

  const request = readJson(
    runPath(routeTrialRequestPath(options.profileId, options.range.label)),
    REQUEST_ERROR,
  );
  const fetched = readJson(
    runPath(listingsPath(options.profileId, options.range.label)),
    LISTINGS_ERROR,
  );
  const enriched = readJson(
    runPath(enrichedPath(options.profileId, options.range.label)),
    ENRICHED_ERROR,
  );
  const exits = loadMrtInput(path.join(options.rootDir, 'data', 'taipei_mrt_exits.csv'));
  assertListingsInput(fetched, options.profileId, options.range, exits);
  assertEnrichedInput(enriched, options.profileId, options.range, exits);

  let selections: RouteTrialSelection[];
  try {
    selections = selectRouteTrialListings(
      request,
      options.profileId,
      options.range,
      fetched,
      enriched,
      exits,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'invalid route trial request binding'
      || message === 'invalid route trial listing indexes') {
      throw new Error(REQUEST_ERROR);
    }
    throw new Error(ENRICHED_ERROR);
  }
  const cache = loadCacheInput(options.rootDir);
  const endpointKey = trialEndpointKey(normalizedBaseUrl);
  const uniqueSelections = new Map<string, RouteTrialSelection>();
  for (const selection of selections) {
    if (selection.routeKey !== null && !uniqueSelections.has(selection.routeKey)) {
      uniqueSelections.set(selection.routeKey, selection);
    }
  }

  const routeResults = new Map<
    string,
    { distances: (number | null)[] | null; error: string | null }
  >();
  const misses: Array<[string, RouteTrialSelection]> = [];
  let cacheHits = 0;
  for (const [routeKey, selection] of uniqueSelections) {
    const distances = getValhallaTrialCacheEntry(
      cache,
      endpointKey,
      routeKey,
      selection.offline.candidates.length,
    );
    if (distances === null) {
      misses.push([routeKey, selection]);
    } else {
      cacheHits += 1;
      routeResults.set(routeKey, { distances, error: null });
    }
  }

  for (let index = 0; index < misses.length; index += 1) {
    const [routeKey, selection] = misses[index];
    if (index > 0) await sleep(requestDelayMs);
    let distances: (number | null)[];
    try {
      distances = await route(
        selection.original.coordinate!,
        selection.offline.candidates.map(({ exit }) => ({ lat: exit.lat, lng: exit.lng })),
        { baseUrl: normalizedBaseUrl },
      );
      if (distances.length !== selection.offline.candidates.length
        || distances.some((distance) => distance !== null
          && (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0))) {
        throw new Error('Valhalla matrix invalid matrix shape');
      }
    } catch (error) {
      routeResults.set(routeKey, {
        distances: null,
        error: safeValhallaErrorMessage(error),
      });
      progress(`Valhalla trial ${index + 1}/${misses.length}`);
      continue;
    }
    putValhallaTrialCacheEntry(cache, endpointKey, routeKey, distances, now().toISOString());
    saveCache(options.rootDir, cache);
    routeResults.set(routeKey, { distances, error: null });
    progress(`Valhalla trial ${index + 1}/${misses.length}`);
  }

  const comparisons = selections.map((selection) => {
    const result = selection.routeKey === null
      ? { distances: null, error: null }
      : routeResults.get(selection.routeKey) ?? { distances: null, error: null };
    return comparison(selection, result.distances, result.error);
  });

  const artifact: RouteTrialArtifact = {
    schemaVersion: 1,
    profileId: options.profileId,
    rangeLabel: options.range.label,
    generatedAt: now().toISOString(),
    valhallaEndpoint: valhallaEndpointIdentifier(normalizedBaseUrl),
    comparisons,
    summary: {
      requested: comparisons.length,
      completed: comparisons.filter((item) => item.valhalla.status === 'reliable').length,
      cacheHits,
      apiCalls: misses.length,
      unavailable: comparisons.filter((item) => item.valhalla.status === 'unavailable').length,
    },
  };

  const artifactPath = runPath(routeTrialResultPath(options.profileId, options.range.label));
  persistArtifact(artifactPath, artifact);
  return { artifactPath, artifact };
}
