import * as fs from 'node:fs';
import { collectListingVariants } from './extract.ts';
import { loadEnv, defaultDeps } from './http.ts';
import type { Logger } from './journal.ts';
import { type RunContext } from './profiles.ts';
import type { StepOutput } from './run.ts';
import { loadExits } from './mrt.ts';
import { enrichOffline } from './enrich-offline.ts';
import { finalizeWalk } from './walk.ts';
import { routeWalkDistances } from './routing.ts';
import { loadCache, saveCache, cacheKey } from './route-cache.ts';
import type { EnrichResult, EnrichedListing, PreMarketEnrichedListing, FetchResult } from './types.ts';
import { runDir, listingsPath, enrichedPath, effectiveProfilePath } from './runpaths.ts';
import { estimateMarket } from './market-data/estimator.ts';
import { locateAddress, nearestDoorplate } from './market-data/doorplates.ts';
import { normalizeTaiwanAddress } from './market-data/address.ts';
import { floorGroup } from './market-data/property.ts';
import { marketDataFreshness } from './market-data/store.ts';
import { ensureTaipeiMarketData } from './market-data/update.ts';
import type {
  MarketDataBundle,
  MarketEstimate,
  SourceFreshness,
  SubjectLocationEvidence,
  SubjectOwnershipEvidence,
} from './market-data/types.ts';
import { haversineMeters } from './geo.ts';

const MRT_CSV = 'data/taipei_mrt_exits.csv';
const ORS_DELAY_MS = 1600;        // ORS free tier ~40 req/min
const ORS_RETRY_WAIT_MS = 65_000; // wait out the per-minute window once
const LISTING_LOCATION_TOLERANCE_M = 300;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NO_ACTIVE_MARKET_FRESHNESS: SourceFreshness = {
  transactionCheckedAt: null,
  doorplateCheckedAt: null,
  transactionStale: false,
  doorplateStale: false,
};

function unavailableMarketEstimate(
  freshness: SourceFreshness,
  unavailableReasons: string[],
  status: 'review' | 'unavailable' = 'unavailable',
  subjectOwnershipEvidence: SubjectOwnershipEvidence = 'unspecified',
  subjectLocationEvidence: SubjectLocationEvidence | null = null,
): MarketEstimate {
  return {
    status,
    confidence: 'low',
    subjectOwnershipEvidence,
    subjectLocationEvidence,
    marketUnitPriceMedian: null,
    marketUnitPriceP25: null,
    marketUnitPriceP75: null,
    askingPremiumMedian: null,
    askingPremiumConservative: null,
    selectedStage: null,
    sourceFreshness: freshness,
    unavailableReasons,
    comparables: [],
    excludedCandidates: [],
  };
}

function reverseAddressConflicts(input: string, matchedAddress: string | null): boolean {
  if (!matchedAddress) return false;
  const expected = normalizeTaiwanAddress(input);
  const actual = normalizeTaiwanAddress(matchedAddress);
  const fields = ['city', 'district', 'road', 'section', 'lane', 'alley'] as const;
  return fields.some((field) => expected[field] !== null && actual[field] !== null && expected[field] !== actual[field]);
}

function validateListingLocation(
  listing: PreMarketEnrichedListing & { coordinate: NonNullable<PreMarketEnrichedListing['coordinate']> },
  bundle: MarketDataBundle,
): SubjectLocationEvidence {
  const input = listing.addressOrArea ?? '';
  const address = locateAddress(bundle.doorplates, input);
  const reverse = nearestDoorplate(bundle.doorplates, listing.coordinate);
  const distance = address.coordinate ? haversineMeters(listing.coordinate, address.coordinate) : null;
  const beyondUncertainty = distance === null
    ? null
    : Math.max(0, distance - (address.uncertaintyMeters ?? 0));

  if (beyondUncertainty !== null && beyondUncertainty > LISTING_LOCATION_TOLERANCE_M) {
    return {
      verdict: 'conflict',
      address,
      nearestDoorplate: reverse,
      addressDistanceMeters: distance,
      distanceBeyondUncertaintyMeters: beyondUncertainty,
      thresholdMeters: LISTING_LOCATION_TOLERANCE_M,
      reasons: ['listing-coordinate-address-conflict'],
    };
  }

  if (address.method === 'exact-doorplate') {
    return {
      verdict: 'matched',
      address,
      nearestDoorplate: reverse,
      addressDistanceMeters: distance,
      distanceBeyondUncertaintyMeters: beyondUncertainty,
      thresholdMeters: LISTING_LOCATION_TOLERANCE_M,
      reasons: [],
    };
  }

  if (address.method === 'address-range') {
    return {
      verdict: 'uncertain',
      address,
      nearestDoorplate: reverse,
      addressDistanceMeters: distance,
      distanceBeyondUncertaintyMeters: beyondUncertainty,
      thresholdMeters: LISTING_LOCATION_TOLERANCE_M,
      reasons: ['listing-address-range-uncertain'],
    };
  }

  if (reverse.method !== 'unresolved' && reverseAddressConflicts(input, reverse.matchedAddress)) {
    return {
      verdict: 'conflict',
      address,
      nearestDoorplate: reverse,
      addressDistanceMeters: null,
      distanceBeyondUncertaintyMeters: null,
      thresholdMeters: LISTING_LOCATION_TOLERANCE_M,
      reasons: ['listing-coordinate-address-conflict'],
    };
  }

  return {
    verdict: 'uncertain',
    address,
    nearestDoorplate: reverse,
    addressDistanceMeters: null,
    distanceBeyondUncertaintyMeters: null,
    thresholdMeters: LISTING_LOCATION_TOLERANCE_M,
    reasons: ['listing-address-location-unresolved'],
  };
}

function attachLocationEvidence(
  estimate: MarketEstimate,
  evidence: SubjectLocationEvidence,
): MarketEstimate {
  if (evidence.verdict !== 'uncertain') return { ...estimate, subjectLocationEvidence: evidence };
  return {
    ...estimate,
    status: estimate.status === 'unavailable' ? 'unavailable' : 'review',
    confidence: 'low',
    subjectLocationEvidence: evidence,
    unavailableReasons: [...new Set([...estimate.unavailableReasons, ...evidence.reasons])],
  };
}

function listingOwnership(title: string): { ownership: 'freehold' | 'non-freehold'; evidence: SubjectOwnershipEvidence } {
  if (/(?:地上權|使用權|區分地上權)/u.test(title)) {
    return { ownership: 'non-freehold', evidence: 'title-explicit-non-freehold' };
  }
  return { ownership: 'freehold', evidence: 'profile-default-freehold' };
}

function integerField(value: string | null): number | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Adds an estimate from one already-loaded local market-data bundle. This is
 * intentionally pure so routing behaviour and offline valuation stay separate.
 */
export function attachMarketEstimates(
  listings: PreMarketEnrichedListing[],
  bundle: MarketDataBundle | null,
  asOf: string,
): EnrichedListing[] {
  const freshness = bundle ? marketDataFreshness(bundle.manifest, asOf) : NO_ACTIVE_MARKET_FRESHNESS;
  return listings.map((listing) => {
    const ownership = listingOwnership(listing.title);
    if (!bundle) {
      return { ...listing, marketEstimate: unavailableMarketEstimate(freshness, ['market-data-unavailable'], 'unavailable', ownership.evidence) };
    }
    if (!listing.coordinate) {
      return { ...listing, marketEstimate: unavailableMarketEstimate(freshness, ['listing-coordinate-unavailable'], 'unavailable', ownership.evidence) };
    }
    if (listing.reliability.coordConsistent === false) {
      return { ...listing, marketEstimate: unavailableMarketEstimate(freshness, ['listing-coordinate-unreliable'], 'unavailable', ownership.evidence) };
    }
    const locationEvidence = validateListingLocation(
      listing as PreMarketEnrichedListing & { coordinate: NonNullable<PreMarketEnrichedListing['coordinate']> },
      bundle,
    );
    if (locationEvidence.verdict === 'conflict') {
      return {
        ...listing,
        marketEstimate: unavailableMarketEstimate(
          freshness,
          locationEvidence.reasons,
          'unavailable',
          ownership.evidence,
          locationEvidence,
        ),
      };
    }
    if (!listing.buildingType) {
      return { ...listing, marketEstimate: unavailableMarketEstimate(freshness, ['listing-building-type-unavailable'], 'unavailable', ownership.evidence, locationEvidence) };
    }
    if (listing.parking !== '無車位') {
      return { ...listing, marketEstimate: unavailableMarketEstimate(freshness, ['listing-parking-not-separable'], 'review', ownership.evidence, locationEvidence) };
    }
    const floor = integerField(listing.floor);
    const totalFloors = integerField(listing.totalFloors);
    if (floor == null || totalFloors == null) {
      return { ...listing, marketEstimate: unavailableMarketEstimate(freshness, ['listing-floor-group-unavailable'], 'unavailable', ownership.evidence, locationEvidence) };
    }
    const subjectFloorGroup = floorGroup(listing.buildingType, floor, totalFloors);
    if (!subjectFloorGroup) {
      return { ...listing, marketEstimate: unavailableMarketEstimate(freshness, ['listing-floor-group-unavailable'], 'unavailable', ownership.evidence, locationEvidence) };
    }

    return {
      ...listing,
      marketEstimate: attachLocationEvidence(estimateMarket({
        listingId: listing.id,
        coordinate: listing.coordinate,
        district: listing.district ?? '',
        ownership: ownership.ownership,
        ownershipEvidence: ownership.evidence,
        buildingType: listing.buildingType,
        buildingAreaPing: listing.totalPingNum ?? Number.NaN,
        askingUnitPriceWan: listing.unitPriceWan ?? Number.NaN,
        floor,
        totalFloors,
        floorGroup: subjectFloorGroup,
        ageYears: listing.ageNum,
        parkingSeparable: true,
      }, bundle.transactions, freshness, asOf), locationEvidence),
    };
  });
}

export async function enrichStep(ctx: RunContext, logger: Logger): Promise<StepOutput> {
  const { profile, range } = ctx;
  const inPath = listingsPath(profile.id, range.label);
  if (!fs.existsSync(inPath)) {
    throw new Error(`${inPath} not found. Run the fetch step for ${range.label} first.`);
  }
  try { process.loadEnvFile('.env'); } catch { /* vars may already be exported */ }
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) {
    logger.event('warn', 'ors.missing-key',
      'ORS_API_KEY not set — walking distances unavailable; affected listings marked manual-review');
  }

  const input = JSON.parse(fs.readFileSync(inPath, 'utf8')) as FetchResult;
  const exits = loadExits(MRT_CSV);
  const cache = loadCache();
  const marketBundle = await ensureTaipeiMarketData({ asOf: range.to, logger });
  if (marketBundle) {
    const freshness = marketDataFreshness(marketBundle.manifest, range.to);
    logger.event('info', 'market-data.ready', 'using validated Taipei market-data build', {
      buildId: marketBundle.manifest.buildId,
      transactionStale: freshness.transactionStale,
      doorplateStale: freshness.doorplateStale,
    });
  } else {
    logger.event('warn', 'market-data.unavailable', 'no validated Taipei market-data build; estimates will be unavailable');
  }

  const offline = input.listings.map((l) => enrichOffline(l, exits));
  const enriched: PreMarketEnrichedListing[] = [];
  let apiCalls = 0, cacheHits = 0, routeErrors = 0;

  for (const o of offline) {
    let routed: (number | null)[] | null = null;
    const needsRoute = o.candidates.length > 0 && o.coordConsistent !== false;
    if (needsRoute) {
      const key = cacheKey(o.coordinate!, o.candidates);
      if (cache[key]) {
        routed = cache[key];
        cacheHits++;
      } else if (apiKey) {
        const dests = o.candidates.map((c) => ({ lat: c.exit.lat, lng: c.exit.lng }));
        try {
          try {
            routed = await routeWalkDistances(o.coordinate!, dests, apiKey);
          } catch (err) {
            if ((err as Error).message.includes('429')) {
              logger.event('warn', 'ors.rate-limited', 'rate-limited; waiting 65s then retrying once');
              await delay(ORS_RETRY_WAIT_MS);
              routed = await routeWalkDistances(o.coordinate!, dests, apiKey);
            } else {
              throw err;
            }
          }
          cache[key] = routed;
          apiCalls++;
          await delay(ORS_DELAY_MS);
        } catch (err) {
          routeErrors++;
          logger.event('error', 'route.error',
            `route error (${o.district ?? '?'}): ${(err as Error).message}`,
            { district: o.district, reason: (err as Error).message });
          routed = null;
        }
      }
    }
    enriched.push(finalizeWalk(o, routed, range.to));
  }

  const valued = attachMarketEstimates(enriched, marketBundle, range.to);
  const withinWalkCount = valued.filter((l) => l.withinWalk === true).length;
  const manualReviewCount = valued.filter((l) => l.withinWalk === null).length;
  const hardExcludedCount = valued.filter((l) => l.hardExclusion.excluded).length;
  const outOfRegionCount = valued.filter((l) => l.regionGate === 'out-of-region').length;
  const inRegionTooFarCount = valued.filter((l) => l.regionGate === 'in-region-too-far').length;
  const marketReliable = valued.filter((l) => l.marketEstimate.status === 'reliable').length;
  const marketReview = valued.filter((l) => l.marketEstimate.status === 'review').length;
  const marketUnavailable = valued.filter((l) => l.marketEstimate.status === 'unavailable').length;
  const marketDataStale = valued.filter((l) =>
    l.marketEstimate.sourceFreshness.transactionStale || l.marketEstimate.sourceFreshness.doorplateStale,
  ).length;
  const result: EnrichResult = {
    from: range.from, to: range.to, enrichedAt: new Date().toISOString(), count: enriched.length,
    withinWalkCount, manualReviewCount, hardExcludedCount,
    outOfRegionCount, inRegionTooFarCount,
    marketReliable, marketReview, marketUnavailable, marketDataStale,
    listings: valued,
  };

  fs.mkdirSync(runDir(profile.id, range.label), { recursive: true });
  saveCache(cache);
  const outPath = enrichedPath(profile.id, range.label);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  logger.event('info', 'enrich.summary',
    `enriched ${enriched.length}: ${withinWalkCount} within-walk, ${manualReviewCount} manual-review, ` +
      `${hardExcludedCount} hard-excluded, ${outOfRegionCount} out-of-region, ${inRegionTooFarCount} too-far ` +
      `(${marketReliable} market-reliable, ${marketReview} market-review, ${marketUnavailable} market-unavailable, ` +
      `${marketDataStale} market-stale; ORS ${apiCalls}, cache ${cacheHits}, errors ${routeErrors})`,
    { count: enriched.length, withinWalk: withinWalkCount, manualReview: manualReviewCount,
      hardExcluded: hardExcludedCount, outOfRegion: outOfRegionCount, inRegionTooFar: inRegionTooFarCount,
      marketReliable, marketReview, marketUnavailable, marketDataStale,
      orsCalls: apiCalls, cacheHits, routeErrors });
  return {
    summary: { withinWalk: withinWalkCount, manualReview: manualReviewCount,
      hardExcluded: hardExcludedCount, marketReliable, marketReview, marketUnavailable, marketDataStale,
      orsCalls: apiCalls, cacheHits, routeErrors },
    artifacts: [outPath],
  };
}

export async function fetchStep(ctx: RunContext, logger: Logger): Promise<StepOutput> {
  const { profile, range } = ctx;
  loadEnv();
  const { listings, dropped, duplicates, provenanceConflicts } = await collectListingVariants(
    range, profile.fetch, defaultDeps, logger,
  );
  const result: FetchResult = {
    from: range.from,
    to: range.to,
    fetchedAt: new Date().toISOString(),
    count: listings.length,
    listings,
  };
  fs.mkdirSync(runDir(profile.id, range.label), { recursive: true });
  fs.writeFileSync(
    effectiveProfilePath(profile.id, range.label),
    JSON.stringify({ displayName: profile.displayName, fetch: profile.fetch }, null, 2),
  );
  const outPath = listingsPath(profile.id, range.label);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  return { summary: { listings: listings.length, historyDropped: dropped, duplicates, provenanceConflicts }, artifacts: [outPath] };
}
