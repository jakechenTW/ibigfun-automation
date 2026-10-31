import type { OfflineEnriched } from './enrich-offline.ts';
import type { Logger } from './journal.ts';
import { cacheKey, loadCache, saveCache } from './route-cache.ts';
import { isRetryableOrsLimitError, routeWalkDistances, withOrsLimitRetry } from './routing.ts';
import { pickWalk } from './walk.ts';
import {
  DEFAULT_VALHALLA_URL, normalizeValhallaBaseUrl,
  routeValhallaWalkDistances, safeValhallaErrorMessage,
} from './valhalla-routing.ts';
import {
  getValhallaTrialCacheEntry, loadValhallaTrialCache, putValhallaTrialCacheEntry,
  saveValhallaTrialCacheAtomic, trialEndpointKey,
} from './valhalla-trial-cache.ts';
import type { EnrichedListing } from './types.ts';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One run's sequential router; a reliable passing route short-circuits the OR rule. */
export function createWalkRouter(
  options: { apiKey?: string; baseUrl?: string; sleep?: (ms: number) => Promise<void> },
  logger: Logger,
) {
  const sleep = options.sleep ?? delay;
  const baseUrl = normalizeValhallaBaseUrl(options.baseUrl ?? (process.env.VALHALLA_URL || DEFAULT_VALHALLA_URL));
  const endpointKey = trialEndpointKey(baseUrl);
  const cache = loadCache();
  // Keep endpoint-scoped Valhalla distances separate from ORS, shared with comparisons.
  const valhallaCache = loadValhallaTrialCache(process.cwd());
  let orsBlocked = false;
  const stats = { apiCalls: 0, cacheHits: 0, routeErrors: 0 };

  async function route(o: Pick<OfflineEnriched, 'coordinate' | 'candidates' | 'coordConsistent'>) {
    let orsDistances: (number | null)[] | null = null;
    let valhallaDistances: (number | null)[] | null = null;
    const evidence: NonNullable<EnrichedListing['routing']> = {
      selectedProvider: null, ors: pickWalk(o.candidates, null), valhalla: null,
    };
    if (!o.coordinate || !o.candidates.length || o.coordConsistent === false) {
      return { distances: null, evidence };
    }
    const origin = o.coordinate;
    const key = cacheKey(origin, o.candidates);
    const dests = o.candidates.map(({ exit }) => ({ lat: exit.lat, lng: exit.lng }));
    if (cache[key]) {
      orsDistances = cache[key];
      stats.cacheHits++;
    } else if (options.apiKey && !orsBlocked) {
      try {
        orsDistances = await withOrsLimitRetry(
          () => routeWalkDistances(origin, dests, options.apiKey!), sleep,
          () => logger.event('warn', 'ors.rate-limited', 'ORS limit reached; waiting 60s then retrying once'),
        );
      } catch (error) {
        orsBlocked = isRetryableOrsLimitError(error);
        stats.routeErrors++;
        logger.event('error', 'route.error', `ORS route failed: ${(error as Error).message}`);
      }
      if (orsDistances !== null) {
        cache[key] = orsDistances;
        saveCache(cache);
        stats.apiCalls++;
        await sleep(1600);
      }
    }
    evidence.ors = pickWalk(o.candidates, orsDistances);
    if (evidence.ors.withinWalk !== true) {
      valhallaDistances = getValhallaTrialCacheEntry(valhallaCache, endpointKey, key, dests.length);
      if (valhallaDistances === null) {
        try {
          valhallaDistances = await routeValhallaWalkDistances(origin, dests, { baseUrl, sleep });
        } catch (error) {
          stats.routeErrors++;
          logger.event('warn', 'valhalla.route-error', safeValhallaErrorMessage(error));
        }
        // Pace all attempts, including failures, against the public endpoint.
        await sleep(1000);
        if (valhallaDistances !== null) {
          putValhallaTrialCacheEntry(valhallaCache, endpointKey, key, valhallaDistances, new Date().toISOString());
          saveValhallaTrialCacheAtomic(process.cwd(), valhallaCache);
        }
      }
      evidence.valhalla = pickWalk(o.candidates, valhallaDistances);
    }
    if (evidence.valhalla?.withinWalk === true
      || (evidence.ors.routeOk !== true && evidence.valhalla?.routeOk === true)) {
      evidence.selectedProvider = 'valhalla';
      return { distances: valhallaDistances, evidence };
    }
    if (evidence.ors.routeOk === true) evidence.selectedProvider = 'ors';
    return { distances: orsDistances, evidence };
  }
  return { route, stats };
}
