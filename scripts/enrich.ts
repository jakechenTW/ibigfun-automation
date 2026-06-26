/**
 * Deterministic enrichment of scraped listings for the daily report.
 *
 * Reads state/listings-<date>.json (scraper output) and adds the fields the
 * data fully determines: parsed numbers, nearest MRT exit + distance, monthly
 * mortgage payment, and objective hard-exclusion flags. Writes
 * state/enriched-<date>.json and stdout.
 *
 * Estimation (market price, rent) and the recommend/exclude judgment are NOT
 * done here — they stay with the agent (docs/reporting-rules.md).
 *
 * Usage:
 *   npm run enrich -- --date 2026-06-26
 *   npm run enrich                       # defaults to previous Taipei day
 *
 * Exit codes: 0 ok · 1 unexpected error · 2 bad input (missing/invalid file or date).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { previousTaipeiDay, isValidDateString } from './lib/date.ts';
import { loadExits } from './lib/mrt.ts';
import { enrichListing } from './lib/enrich-core.ts';
import type { FetchResult, EnrichResult } from './lib/types.ts';

const MRT_CSV = 'data/taipei_mrt_exits.csv';

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

function main(): void {
  const targetDate = resolveTargetDate(process.argv.slice(2));

  const inPath = path.join('state', `listings-${targetDate}.json`);
  if (!fs.existsSync(inPath)) {
    fail(`${inPath} not found. Run "npm run fetch -- --date ${targetDate}" first.`);
  }

  const input = JSON.parse(fs.readFileSync(inPath, 'utf8')) as FetchResult;
  const exits = loadExits(MRT_CSV);

  const listings = input.listings.map((l) => enrichListing(l, exits));
  const hardExcludedCount = listings.filter((l) => l.hardExclusion.excluded).length;
  const result: EnrichResult = {
    targetDate,
    enrichedAt: new Date().toISOString(),
    count: listings.length,
    hardExcludedCount,
    listings,
  };

  fs.mkdirSync('state', { recursive: true });
  const outPath = path.join('state', `enriched-${targetDate}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.error(
    `Enriched ${listings.length} listings (${hardExcludedCount} hard-excluded, ` +
      `${exits.length} MRT exits) -> ${outPath}`,
  );
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
