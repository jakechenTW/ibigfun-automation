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
import { resolveRange, rangeFlags, type RunRange } from './lib/range.ts';
import { consoleLogger } from './lib/journal.ts';
import { enrichStep } from './lib/steps.ts';

function fail(message: string): never {
  console.error(`BAD INPUT: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  let range: RunRange;
  try {
    range = resolveRange(process.argv.slice(2), new Date());
  } catch (e) {
    fail((e as Error).message);
  }
  const inPath = `state/listings-${range.label}.json`;
  if (!fs.existsSync(inPath)) {
    fail(`${inPath} not found. Run "npm run fetch -- ${rangeFlags(range)}" first.`);
  }
  const { artifacts } = await enrichStep(range, consoleLogger('enrich'));
  console.error(`Wrote enriched listings to ${artifacts![0]}`);
  process.stdout.write(fs.readFileSync(artifacts![0], 'utf8'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
