import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectListings } from './extract.ts';
import { loadEnv } from './http.ts';
import type { Logger } from './journal.ts';
import type { StepOutput } from './run.ts';
import { loadExits } from './mrt.ts';
import { enrichOffline } from './enrich-offline.ts';
import { finalizeWalk } from './walk.ts';
import { routeWalkDistances } from './routing.ts';
import { loadCache, saveCache, cacheKey } from './route-cache.ts';
import type { EnrichResult, EnrichedListing, FetchResult } from './types.ts';

const MRT_CSV = 'data/taipei_mrt_exits.csv';
const ORS_DELAY_MS = 1600;        // ORS free tier ~40 req/min
const ORS_RETRY_WAIT_MS = 65_000; // wait out the per-minute window once
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function enrichStep(date: string, logger: Logger): Promise<StepOutput> {
  const inPath = path.join('state', `listings-${date}.json`);
  if (!fs.existsSync(inPath)) {
    throw new Error(`${inPath} not found. Run the fetch step for ${date} first.`);
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
    enriched.push(finalizeWalk(o, routed, date));
  }

  const withinWalkCount = enriched.filter((l) => l.withinWalk === true).length;
  const manualReviewCount = enriched.filter((l) => l.withinWalk === null).length;
  const hardExcludedCount = enriched.filter((l) => l.hardExclusion.excluded).length;
  const result: EnrichResult = {
    targetDate: date, enrichedAt: new Date().toISOString(), count: enriched.length,
    withinWalkCount, manualReviewCount, hardExcludedCount, listings: enriched,
  };

  fs.mkdirSync('state', { recursive: true });
  saveCache(cache);
  const outPath = path.join('state', `enriched-${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  logger.event('info', 'enrich.summary',
    `enriched ${enriched.length}: ${withinWalkCount} within-walk, ${manualReviewCount} manual-review, ` +
      `${hardExcludedCount} hard-excluded (ORS ${apiCalls}, cache ${cacheHits}, errors ${routeErrors})`,
    { count: enriched.length, withinWalk: withinWalkCount, manualReview: manualReviewCount,
      hardExcluded: hardExcludedCount, orsCalls: apiCalls, cacheHits, routeErrors });
  return {
    summary: { withinWalk: withinWalkCount, manualReview: manualReviewCount,
      hardExcluded: hardExcludedCount, orsCalls: apiCalls, cacheHits, routeErrors },
    artifacts: [outPath],
  };
}

export async function fetchStep(date: string, logger: Logger): Promise<StepOutput> {
  loadEnv();
  const { listings, dropped } = await collectListings(date, undefined, logger);
  const result: FetchResult = {
    targetDate: date,
    fetchedAt: new Date().toISOString(),
    count: listings.length,
    listings,
  };
  fs.mkdirSync('state', { recursive: true });
  const outPath = path.join('state', `listings-${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  return { summary: { listings: listings.length, historyDropped: dropped }, artifacts: [outPath] };
}
