import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectListings } from './extract.ts';
import { loadEnv } from './http.ts';
import type { Logger } from './journal.ts';
import type { StepOutput } from './run.ts';
import type { FetchResult } from './types.ts';

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
