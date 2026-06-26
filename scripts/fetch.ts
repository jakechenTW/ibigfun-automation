/**
 * iBigFun daily listing scraper.
 *
 * Usage:
 *   npm run fetch -- --date 2026-06-26   # explicit target date
 *   npm run fetch                        # defaults to previous Taipei day
 *
 * Writes state/listings-<date>.json (git-ignored) and prints the JSON to
 * stdout. Fetch + normalize only — MRT distance, estimation, and evaluation
 * stay with the report step (see AGENTS.md / docs/reporting-rules.md).
 *
 * Exit codes: 0 ok · 1 unexpected error · 2 blocked (login gate / bad input,
 * needs a human).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { previousTaipeiDay, isValidDateString } from './lib/date.ts';
import { SELECTORS_VERIFIED } from './lib/config.ts';
import { loadEnv, createSession } from './lib/session.ts';
import { BlockedError } from './lib/errors.ts';
import { collectListings } from './lib/extract.ts';
import type { FetchResult } from './lib/types.ts';

/** Parse `--date YYYY-MM-DD` (or `--date=...`); default = previous Taipei day. */
function resolveTargetDate(argv: string[]): string {
  const idx = argv.findIndex((a) => a === '--date' || a.startsWith('--date='));
  if (idx === -1) return previousTaipeiDay(new Date());

  const raw = argv[idx].includes('=')
    ? argv[idx].split('=').slice(1).join('=')
    : argv[idx + 1];
  if (!raw || !isValidDateString(raw)) {
    throw new BlockedError(`Invalid --date "${raw ?? ''}"; expected YYYY-MM-DD.`);
  }
  return raw;
}

async function main(): Promise<void> {
  const targetDate = resolveTargetDate(process.argv.slice(2));

  if (!SELECTORS_VERIFIED) {
    console.error(
      '⚠️  Selectors in scripts/lib/config.ts are UNVERIFIED best-guesses and ' +
        'may not match the live iBigFun DOM. If results look empty or wrong, ' +
        'confirm the selectors against the authenticated page, then set ' +
        'SELECTORS_VERIFIED = true. See docs/fetching.md.',
    );
  }

  loadEnv();
  const { browser, context, page } = await createSession();
  try {
    const listings = await collectListings(page, context, targetDate);
    const result: FetchResult = {
      targetDate,
      fetchedAt: new Date().toISOString(),
      count: listings.length,
      listings,
    };

    fs.mkdirSync('state', { recursive: true });
    const outPath = path.join('state', `listings-${targetDate}.json`);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.error(`Wrote ${listings.length} listings to ${outPath}`);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  if (err instanceof BlockedError) {
    console.error(`BLOCKED: ${err.message}`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
