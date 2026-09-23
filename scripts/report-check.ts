import { readFileSync } from 'node:fs';
import { validateNotificationCounts, validateNotificationReport } from './lib/report-format.ts';

// Read-only preflight: never marks a pipeline step or sends a notification.
try {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('usage: npm run report:check -- <report.md> <enriched.json>');
  const report = readFileSync(args[0], 'utf8');
  const enriched = JSON.parse(readFileSync(args[1], 'utf8'));
  if (!Array.isArray(enriched?.listings)) throw new Error('enriched.json requires a listings array');
  validateNotificationReport(report);
  validateNotificationCounts(report, enriched.listings.length);
  console.log('Report format and counts passed. No notification sent.');
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Invalid enriched JSON.' : (error as Error).message);
  process.exitCode = 1;
}
