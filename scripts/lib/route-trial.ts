import type { Coordinate } from './coords.ts';
import { enrichOffline, type OfflineEnriched } from './enrich-offline.ts';
import type { MrtExit } from './mrt.ts';
import type { RunRange } from './range.ts';
import { cacheKey } from './route-cache.ts';
import type { EnrichResult, EnrichedListing, FetchResult, Listing } from './types.ts';
import { pickWalk } from './walk.ts';

export interface RouteTrialRequest {
  schemaVersion: 1;
  profileId: string;
  rangeLabel: string;
  listingIndexes: number[];
}

export interface RouteTrialWalk {
  status: 'reliable' | 'unavailable';
  stationZh: string | null;
  exitId: string | null;
  distanceM: number | null;
  minutes: number | null;
}

export interface RouteTrialSelection {
  listingIndex: number;
  listingId: number | null;
  original: Listing;
  enriched: EnrichedListing;
  offline: OfflineEnriched;
  routeKey: string | null;
}

export interface RouteTrialComparison {
  listingIndex: number;
  listingId: number | null;
  ors: RouteTrialWalk;
  valhalla: RouteTrialWalk;
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isCoordinate(value: unknown): value is Coordinate | null {
  return value === null || (isRecord(value)
    && typeof value.lat === 'number' && Number.isFinite(value.lat)
    && typeof value.lng === 'number' && Number.isFinite(value.lng));
}

function isListingHistory(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => isRecord(entry)
    && typeof entry.date === 'string'
    && typeof entry.source === 'string'
    && isNullableString(entry.price)
    && typeof entry.active === 'boolean');
}

function isListing(value: unknown): value is Listing {
  if (!isRecord(value)) return false;
  const buildingType = value.buildingType;
  return typeof value.title === 'string'
    && isNullableString(value.url)
    && isNullableString(value.addressOrArea)
    && isNullableString(value.nearbyStation)
    && isCoordinate(value.coordinate)
    && isNullableString(value.publishedDate)
    && isNullableString(value.totalPrice)
    && isNullableString(value.totalPing)
    && isNullableString(value.unitPrice)
    && isNullableString(value.floor)
    && isNullableString(value.totalFloors)
    && isNullableString(value.typeLayout)
    && isNullableString(value.age)
    && isNullableString(value.parking)
    && isNullableString(value.realPriceUrl)
    && isListingHistory(value.listingHistory)
    && isNullableFiniteNumber(value.id)
    && isNullableString(value.source)
    && isNullableString(value.sourceLink)
    && isNullableFiniteNumber(value.room)
    && isNullableFiniteNumber(value.livingRoom)
    && isNullableFiniteNumber(value.bathroom)
    && isNullableString(value.queryHouseType)
    && (buildingType === null || buildingType === 'apartment' || buildingType === 'midrise' || buildingType === 'highrise');
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFetchResult(value: unknown): value is FetchResult {
  return isRecord(value)
    && typeof value.from === 'string'
    && typeof value.to === 'string'
    && typeof value.fetchedAt === 'string'
    && Number.isFinite(Date.parse(value.fetchedAt))
    && isNonNegativeSafeInteger(value.count)
    && Array.isArray(value.listings)
    && value.count === value.listings.length
    && value.listings.every(isListing);
}

function isEnrichResult(value: unknown): value is EnrichResult {
  if (!isRecord(value)
    || typeof value.from !== 'string'
    || typeof value.to !== 'string'
    || typeof value.enrichedAt !== 'string'
    || !Number.isFinite(Date.parse(value.enrichedAt))
    || !isNonNegativeSafeInteger(value.count)
    || !Array.isArray(value.listings)
    || value.count !== value.listings.length
    || !value.listings.every(isListing)) return false;
  return [
    value.withinWalkCount, value.manualReviewCount, value.hardExcludedCount,
    value.tenureEligible, value.tenureExpired, value.tenureReview,
    value.outOfRegionCount, value.inRegionTooFarCount, value.marketReliable,
    value.marketReview, value.marketUnavailable, value.marketDataStale,
  ].every(isNonNegativeSafeInteger);
}

function sameCoordinate(a: Coordinate | null, b: Coordinate | null): boolean {
  return a === null
    ? b === null
    : b !== null && a.lat === b.lat && a.lng === b.lng;
}

function sameIdentity(fetched: Listing, enriched: EnrichedListing): boolean {
  return fetched.id === enriched.id
    && fetched.title === enriched.title
    && fetched.url === enriched.url
    && sameCoordinate(fetched.coordinate, enriched.coordinate);
}

function validateRequest(
  request: unknown,
  profileId: string,
  range: RunRange,
  listingCount: number,
): RouteTrialRequest {
  if (!isRecord(request)
    || request.schemaVersion !== 1
    || request.profileId !== profileId
    || request.rangeLabel !== range.label
    || !Array.isArray(request.listingIndexes)
    || request.listingIndexes.length > 25) {
    throw new Error('invalid route trial request binding');
  }
  const seen = new Set<number>();
  for (const index of request.listingIndexes) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= listingCount || seen.has(index)) {
      throw new Error('invalid route trial listing indexes');
    }
    seen.add(index);
  }
  return request as unknown as RouteTrialRequest;
}

function validateResults(
  range: RunRange,
  fetched: unknown,
  enriched: unknown,
): { fetched: FetchResult; enriched: EnrichResult } {
  if (!isFetchResult(fetched) || !isEnrichResult(enriched)
    || fetched.from !== range.from || fetched.to !== range.to
    || enriched.from !== range.from || enriched.to !== range.to
    || fetched.count !== enriched.count) {
    throw new Error('invalid route trial result binding');
  }
  for (let index = 0; index < fetched.listings.length; index += 1) {
    if (!sameIdentity(fetched.listings[index], enriched.listings[index])) {
      throw new Error('route trial listing identity drift');
    }
  }
  return { fetched, enriched };
}

export function selectRouteTrialListings(
  request: unknown,
  profileId: string,
  range: RunRange,
  fetched: unknown,
  enriched: unknown,
  exits: MrtExit[],
): RouteTrialSelection[] {
  const results = validateResults(range, fetched, enriched);
  const validatedRequest = validateRequest(request, profileId, range, results.fetched.count);
  return validatedRequest.listingIndexes.map((listingIndex) => {
    const original = results.fetched.listings[listingIndex];
    const offline = enrichOffline(original, exits);
    const routeKey = original.coordinate !== null
      && offline.candidates.length > 0
      && offline.coordConsistent !== false
      ? cacheKey(original.coordinate, offline.candidates)
      : null;
    return {
      listingIndex,
      listingId: original.id,
      original,
      enriched: results.enriched.listings[listingIndex],
      offline,
      routeKey,
    };
  });
}

export function unavailableTrialWalk(): RouteTrialWalk {
  return { status: 'unavailable', stationZh: null, exitId: null, distanceM: null, minutes: null };
}

function trialWalk(
  stationZh: string,
  exitId: string,
  distanceM: number,
): RouteTrialWalk {
  return {
    status: 'reliable',
    stationZh,
    exitId,
    distanceM: Math.round(distanceM),
    minutes: Math.round(distanceM / 80),
  };
}

export function reliableOrsTrialWalk(listing: EnrichedListing): RouteTrialWalk {
  const { walk, reliability } = listing;
  if (!walk || reliability.routeOk !== true || reliability.coordConsistent === false) {
    return unavailableTrialWalk();
  }
  return trialWalk(walk.stationZh, walk.exitId, walk.distanceM);
}

export function valhallaTrialWalk(
  selection: RouteTrialSelection,
  distances: (number | null)[] | null,
): RouteTrialWalk {
  if (selection.routeKey === null) return unavailableTrialWalk();
  const picked = pickWalk(selection.offline.candidates, distances);
  if (picked.routeOk !== true || picked.walk === null) return unavailableTrialWalk();
  return trialWalk(picked.walk.stationZh, picked.walk.exitId, picked.walk.distanceM);
}

function providerLabel(name: 'ORS' | 'Valhalla', walk: RouteTrialWalk): string {
  if (walk.status === 'unavailable') return name === 'ORS' ? 'ORS 待確認' : 'Valhalla 暫無（試行）';
  const exit = walk.exitId ? ` ${walk.exitId}號出口` : '';
  const trial = name === 'Valhalla' ? '（試行）' : '';
  return `${name} ${walk.stationZh}${exit}・${walk.minutes}分${trial}`;
}

export function formatDualRouteWalkLine(
  comparison: RouteTrialComparison,
  coordinate: Coordinate | null,
): string {
  if (coordinate === null) return '🚶 無位置資訊';
  return `🚶 ${providerLabel('ORS', comparison.ors)}｜${providerLabel('Valhalla', comparison.valhalla)}・[地圖](https://www.google.com/maps?q=${coordinate.lat},${coordinate.lng})`;
}
