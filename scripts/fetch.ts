/**
 * iBigFun daily listing scraper.
 *
 * Usage:
 *   npm run fetch -- --date 2026-06-26   # explicit target date
 *   npm run fetch                        # defaults to previous Taipei day
 *
 * Writes state/runs/<label>/listings.json (git-ignored) and prints the JSON to
 * stdout. Fetch + normalize only — MRT distance, estimation, and evaluation
 * stay with the report step (see AGENTS.md / docs/reporting-rules.md).
 *
 * Exit codes: 0 ok · 1 unexpected error · 2 blocked (login gate / bad input,
 * needs a human).
 */
import * as fs from 'node:fs';
import { resolveRange, type RunRange } from './lib/range.ts';
import { BlockedError } from './lib/errors.ts';
import { consoleLogger } from './lib/journal.ts';
import { fetchStep } from './lib/steps.ts';

/** Resolve --date / --from/--to; map a bad range to a BlockedError (exit 2). */
function resolveRangeOrThrow(argv: string[]): RunRange {
  try {
    return resolveRange(argv, new Date());
  } catch (e) {
    throw new BlockedError((e as Error).message);
  }
}

async function main(): Promise<void> {
  const range = resolveRangeOrThrow(process.argv.slice(2));
  const { artifacts } = await fetchStep(range, consoleLogger('fetch'));
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
