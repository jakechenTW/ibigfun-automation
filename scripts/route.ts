/**
 * One-off walking-distance helper for agent triage of unreliable listings.
 *
 * Given a (re-located) coordinate, returns the nearest MRT exit by walking
 * distance — the same deterministic routing the enrich step uses. During triage
 * the agent re-locates a listing from its text address / shown station, runs
 * this to get a trustworthy walking distance, and decides withinWalk from a
 * real number rather than guessing. See docs/reporting-rules.md (Triage).
 *
 * Usage:
 *   npm run route -- --lat 25.0272 --lng 121.5109
 *
 * Needs ORS_API_KEY in .env. Results share state/route-cache.json with enrich.
 * Exit codes: 0 ok · 2 bad input / missing key.
 */
import { loadExits, kNearestExits } from './lib/mrt.ts';
import { CANDIDATE_EXITS } from './lib/enrich-offline.ts';
import { pickWalk } from './lib/walk.ts';
import { routeWalkDistances } from './lib/routing.ts';
import { loadCache, saveCache, cacheKey } from './lib/route-cache.ts';
import type { LatLng } from './lib/geo.ts';

const MRT_CSV = 'data/taipei_mrt_exits.csv';

function fail(message: string): never {
  console.error(`BAD INPUT: ${message}`);
  process.exit(2);
}

function numArg(argv: string[], name: string): number {
  const idx = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx === -1) fail(`missing ${name}`);
  const raw = argv[idx].includes('=') ? argv[idx].split('=')[1] : argv[idx + 1];
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`${name} must be a number, got "${raw ?? ''}"`);
  return n;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const coord: LatLng = { lat: numArg(argv, '--lat'), lng: numArg(argv, '--lng') };

  try {
    process.loadEnvFile('.env');
  } catch {
    /* vars may already be exported */
  }
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) fail('ORS_API_KEY not set in .env');

  const exits = loadExits(MRT_CSV);
  const candidates = kNearestExits(coord, exits, CANDIDATE_EXITS);

  const cache = loadCache();
  const key = cacheKey(coord, candidates);
  let routed = cache[key] ?? null;
  if (!routed) {
    routed = await routeWalkDistances(
      coord,
      candidates.map((c) => ({ lat: c.exit.lat, lng: c.exit.lng })),
      apiKey,
    );
    cache[key] = routed;
    saveCache(cache);
  }

  const pick = pickWalk(candidates, routed);
  const output = {
    coordinate: coord,
    candidates: candidates.map((c, i) => ({
      stationZh: c.exit.nameZh,
      exitId: c.exit.exitId,
      line: c.exit.line,
      straightM: Math.round(c.distanceM),
      walkM: routed![i],
    })),
    walk: pick.walk,
    withinWalk: pick.withinWalk,
    routeOk: pick.routeOk,
    ratio: pick.ratio,
    reason: pick.reason,
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
