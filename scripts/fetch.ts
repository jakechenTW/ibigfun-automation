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
import { previousTaipeiDay, isValidDateString } from './lib/date.ts';
import { BlockedError } from './lib/errors.ts';
import { consoleLogger } from './lib/journal.ts';
import { fetchStep } from './lib/steps.ts';

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
  const { artifacts } = await fetchStep(targetDate, consoleLogger('fetch'));
  console.error(`Wrote listings to ${artifacts![0]}`);
  process.stdout.write(fs.readFileSync(artifacts![0], 'utf8'));
}

main().catch((err) => {
  if (err instanceof BlockedError) {
    console.error(`BLOCKED: ${err.message}`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
