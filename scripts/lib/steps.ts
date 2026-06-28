import * as fs from 'node:fs';
import { collectListings } from './extract.ts';
import { loadEnv, defaultDeps } from './http.ts';
import type { Logger } from './journal.ts';
import { type RunContext } from './profiles.ts';
import type { StepOutput } from './run.ts';
import { loadExits } from './mrt.ts';
import { enrichOffline } from './enrich-offline.ts';
import { finalizeWalk } from './walk.ts';
import { routeWalkDistances } from './routing.ts';
import { loadCache, saveCache, cacheKey } from './route-cache.ts';
import type { EnrichResult, EnrichedListing, FetchResult } from './types.ts';
import { runDir, listingsPath, enrichedPath } from './runpaths.ts';

const MRT_CSV = 'data/taipei_mrt_exits.csv';
const ORS_DELAY_MS = 1600;        // ORS free tier ~40 req/min
const ORS_RETRY_WAIT_MS = 65_000; // wait out the per-minute window once
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  const offline = input.listings.map((l) => enrichOffline(l, exits));
  const enriched: EnrichedListing[] = [];
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

  const withinWalkCount = enriched.filter((l) => l.withinWalk === true).length;
  const manualReviewCount = enriched.filter((l) => l.withinWalk === null).length;
  const hardExcludedCount = enriched.filter((l) => l.hardExclusion.excluded).length;
  const outOfRegionCount = enriched.filter((l) => l.regionGate === 'out-of-region').length;
  const inRegionTooFarCount = enriched.filter((l) => l.regionGate === 'in-region-too-far').length;
  const result: EnrichResult = {
    from: range.from, to: range.to, enrichedAt: new Date().toISOString(), count: enriched.length,
    withinWalkCount, manualReviewCount, hardExcludedCount,
    outOfRegionCount, inRegionTooFarCount, listings: enriched,
  };

  fs.mkdirSync(runDir(profile.id, range.label), { recursive: true });
  saveCache(cache);
  const outPath = enrichedPath(profile.id, range.label);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  logger.event('info', 'enrich.summary',
    `enriched ${enriched.length}: ${withinWalkCount} within-walk, ${manualReviewCount} manual-review, ` +
      `${hardExcludedCount} hard-excluded, ${outOfRegionCount} out-of-region, ${inRegionTooFarCount} too-far ` +
      `(ORS ${apiCalls}, cache ${cacheHits}, errors ${routeErrors})`,
    { count: enriched.length, withinWalk: withinWalkCount, manualReview: manualReviewCount,
      hardExcluded: hardExcludedCount, outOfRegion: outOfRegionCount, inRegionTooFar: inRegionTooFarCount,
      orsCalls: apiCalls, cacheHits, routeErrors });
  return {
    summary: { withinWalk: withinWalkCount, manualReview: manualReviewCount,
      hardExcluded: hardExcludedCount, orsCalls: apiCalls, cacheHits, routeErrors },
    artifacts: [outPath],
  };
}

export async function fetchStep(ctx: RunContext, logger: Logger): Promise<StepOutput> {
  const { profile, range } = ctx;
  loadEnv();
  const filters = profile.fetch;
  const { listings, dropped, duplicates } = await collectListings(range, defaultDeps(filters), logger);
  const result: FetchResult = {
    from: range.from,
    to: range.to,
    fetchedAt: new Date().toISOString(),
    count: listings.length,
    listings,
  };
  fs.mkdirSync(runDir(profile.id, range.label), { recursive: true });
  const outPath = listingsPath(profile.id, range.label);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  return { summary: { listings: listings.length, historyDropped: dropped, duplicates }, artifacts: [outPath] };
}
