/**
 * Deterministic enrichment of scraped listings for the daily report.
 *
 * Reads state/listings-<date>.json and adds: parsed numbers, monthly mortgage,
 * nearest MRT exit by **walking distance** (OpenRouteService foot routing over
 * OSM data, cheap haversine pre-filter to pick candidate exits), a reliability
 * gate, an objective hard-exclusion flag (>10-min walk when reliable), and an
 * advisory auction-keyword signal for the agent. Writes
 * state/enriched-<date>.json and stdout.
 *
 * Estimation (market price, rent) and the recommend/exclude judgment stay with
 * the agent (docs/reporting-rules.md).
 *
 * Usage:
 *   npm run enrich -- --date 2026-06-26
 *   npm run enrich                       # previous Taipei day
 *
 * Needs ORS_API_KEY in .env for live routing. Without it, listings fall back to
 * "routing unavailable" (manual review), never silently excluded. Routing
 * results are cached in state/route-cache.json so re-runs are reproducible.
 *
 * Exit codes: 0 ok · 1 unexpected error · 2 bad input (missing/invalid file or date).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { previousTaipeiDay, isValidDateString } from './lib/date.ts';
import { loadExits } from './lib/mrt.ts';
import { enrichOffline } from './lib/enrich-offline.ts';
import { finalizeWalk } from './lib/walk.ts';
import { routeWalkDistances } from './lib/routing.ts';
import { loadCache, saveCache, cacheKey } from './lib/route-cache.ts';
import type { FetchResult, EnrichResult, EnrichedListing } from './lib/types.ts';

const MRT_CSV = 'data/taipei_mrt_exits.csv';
const ORS_DELAY_MS = 1600; // ORS free tier caps matrix at 40 req/min (~1.5s apart)
const ORS_RETRY_WAIT_MS = 65_000; // on 429, wait out the per-minute window once

function fail(message: string): never {
  console.error(`BAD INPUT: ${message}`);
  process.exit(2);
}

function resolveTargetDate(argv: string[]): string {
  const idx = argv.findIndex((a) => a === '--date' || a.startsWith('--date='));
  if (idx === -1) return previousTaipeiDay(new Date());
  const raw = argv[idx].includes('=')
    ? argv[idx].split('=').slice(1).join('=')
    : argv[idx + 1];
  if (!raw || !isValidDateString(raw)) fail(`invalid --date "${raw ?? ''}"; expected YYYY-MM-DD.`);
  return raw;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const targetDate = resolveTargetDate(process.argv.slice(2));

  const inPath = path.join('state', `listings-${targetDate}.json`);
  if (!fs.existsSync(inPath)) {
    fail(`${inPath} not found. Run "npm run fetch -- --date ${targetDate}" first.`);
  }

  try {
    process.loadEnvFile('.env');
  } catch {
    /* vars may already be exported */
  }
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) {
    console.error(
      'WARNING: ORS_API_KEY not set — walking distances cannot be computed; ' +
        'affected listings are marked for manual review (not excluded).',
    );
  }

  const input = JSON.parse(fs.readFileSync(inPath, 'utf8')) as FetchResult;
  const exits = loadExits(MRT_CSV);
  const cache = loadCache();

  const offline = input.listings.map((l) => enrichOffline(l, exits));
  const enriched: EnrichedListing[] = [];
  let apiCalls = 0;
  let cacheHits = 0;
  let routeErrors = 0;

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
            // On a rate-limit hit, wait out the per-minute window and retry once.
            if ((err as Error).message.includes('429')) {
              console.error('  rate-limited; waiting 65s then retrying…');
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
          console.error(`  route error (${o.district ?? '?'}): ${(err as Error).message}`);
          routed = null;
        }
      }
    }
    enriched.push(finalizeWalk(o, routed));
  }

  const withinWalkCount = enriched.filter((l) => l.withinWalk === true).length;
  const manualReviewCount = enriched.filter((l) => l.withinWalk === null).length;
  const hardExcludedCount = enriched.filter((l) => l.hardExclusion.excluded).length;
  const result: EnrichResult = {
    targetDate,
    enrichedAt: new Date().toISOString(),
    count: enriched.length,
    withinWalkCount,
    manualReviewCount,
    hardExcludedCount,
    listings: enriched,
  };

  fs.mkdirSync('state', { recursive: true });
  saveCache(cache);
  const outPath = path.join('state', `enriched-${targetDate}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.error(
    `Enriched ${enriched.length}: ${withinWalkCount} within-walk, ` +
      `${manualReviewCount} manual-review, ${hardExcludedCount} hard-excluded ` +
      `(ORS calls ${apiCalls}, cache hits ${cacheHits}, errors ${routeErrors}) -> ${outPath}`,
  );
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
