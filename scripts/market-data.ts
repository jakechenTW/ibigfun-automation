/**
 * Operator CLI for the local Taipei market-data build and its offline backtest.
 * Backtesting reads only the active validated build; it never refreshes sources.
 */
import { pathToFileURL } from 'node:url';
import { isValidDateString, taipeiDateString } from './lib/date.ts';
import { backtestTransactions, type BacktestReport } from './lib/market-data/backtest.ts';
import { MARKET_DATA_ROOT } from './lib/market-data/config.ts';
import { loadMarketData, marketDataFreshness } from './lib/market-data/store.ts';
import { ensureTaipeiMarketData } from './lib/market-data/update.ts';

const SUPPORTED_CITY = 'taipei';
const MEDIAN_APE_TARGET = 0.12;
const P75_APE_TARGET = 0.20;

export class CliInputError extends Error {}

export type MarketDataCommand =
  | { command: 'update'; city: typeof SUPPORTED_CITY; asOf: string }
  | { command: 'backtest'; city: typeof SUPPORTED_CITY; asOf: string; noGate: boolean };

function readFlagValue(args: readonly string[], index: number, flag: string): [string, number] {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new CliInputError(`${flag} requires a value`);
  return [value, index + 1];
}

/** Strictly parses the small public CLI surface before any filesystem or network work. */
export function parseMarketDataArgs(args: readonly string[], now: Date = new Date()): MarketDataCommand {
  const command = args[0];
  if (command !== 'update' && command !== 'backtest') {
    throw new CliInputError('usage: market-data <update|backtest> --city taipei [--as-of YYYY-MM-DD] [--no-gate]');
  }

  let city: string | undefined;
  let asOf: string | undefined;
  let noGate = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--city') {
      if (city !== undefined) throw new CliInputError('--city may be supplied only once');
      [city, index] = readFlagValue(args, index, '--city');
    } else if (argument.startsWith('--city=')) {
      if (city !== undefined) throw new CliInputError('--city may be supplied only once');
      city = argument.slice('--city='.length);
    } else if (argument === '--as-of') {
      if (command !== 'backtest') throw new CliInputError('--as-of is supported only by backtest');
      if (asOf !== undefined) throw new CliInputError('--as-of may be supplied only once');
      [asOf, index] = readFlagValue(args, index, '--as-of');
    } else if (argument.startsWith('--as-of=')) {
      if (command !== 'backtest') throw new CliInputError('--as-of is supported only by backtest');
      if (asOf !== undefined) throw new CliInputError('--as-of may be supplied only once');
      asOf = argument.slice('--as-of='.length);
    } else if (argument === '--no-gate') {
      if (command !== 'backtest') throw new CliInputError('--no-gate is supported only by backtest');
      if (noGate) throw new CliInputError('--no-gate may be supplied only once');
      noGate = true;
    } else {
      throw new CliInputError(`unsupported argument: ${argument}`);
    }
  }

  if (city !== SUPPORTED_CITY) {
    throw new CliInputError(`unsupported city: ${city ?? '(missing)'}; supported city: ${SUPPORTED_CITY}`);
  }
  const resolvedAsOf = asOf ?? taipeiDateString(now);
  if (!isValidDateString(resolvedAsOf)) throw new CliInputError('--as-of must be a valid YYYY-MM-DD date');
  if (command === 'update') return { command, city, asOf: resolvedAsOf };
  return { command, city, asOf: resolvedAsOf, noGate };
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function completed(report: BacktestReport): boolean {
  return report.overall.caseCount > 0 && report.overall.medianApe !== null && report.overall.p75Ape !== null;
}

/** Returns the post-report quality-gate exit status without changing local state. */
export function backtestExitCode(report: BacktestReport, noGate: boolean): number {
  if (noGate || !completed(report)) return 0;
  return report.overall.medianApe! > MEDIAN_APE_TARGET || report.overall.p75Ape! > P75_APE_TARGET ? 1 : 0;
}

export function marketUpdateExitCode(status: 'updated' | 'not-modified' | 'last-known-good' | undefined): number {
  return status === 'last-known-good' ? 3 : 0;
}

async function update(asOf: string): Promise<number> {
  const bundle = await ensureTaipeiMarketData({ asOf });
  if (!bundle) throw new Error('No validated Taipei market-data build is available after update');
  if (bundle.refresh?.status === 'last-known-good') {
    process.stderr.write(`WARN: refresh failed; retained last-known-good build ${bundle.manifest.buildId}: ${bundle.refresh.failure ?? 'unknown failure'}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    buildId: bundle.manifest.buildId,
    refresh: bundle.refresh ?? { status: 'updated' },
    sourceDates: {
      doorplates: { publishedAt: bundle.manifest.doorplates.publishedAt, checkedAt: bundle.manifest.doorplates.checkedAt },
      transactions: { publishedAt: bundle.manifest.transactions.publishedAt, checkedAt: bundle.manifest.transactions.checkedAt },
    },
    counts: {
      doorplates: bundle.manifest.doorplates.recordCount,
      transactions: bundle.manifest.transactions.recordCount,
    },
    freshness: marketDataFreshness(bundle.manifest, asOf),
  }, null, 2)}\n`);
  return marketUpdateExitCode(bundle.refresh?.status);
}

async function backtest(command: Extract<MarketDataCommand, { command: 'backtest' }>): Promise<number> {
  // Deliberately load-only: a backtest must not refresh, publish, or otherwise mutate the active build.
  const bundle = await loadMarketData(MARKET_DATA_ROOT);
  if (!bundle) throw new Error(`No validated Taipei market-data build at ${MARKET_DATA_ROOT}; run update first`);
  const report = backtestTransactions(bundle.transactions, { asOf: command.asOf });
  const exitCode = backtestExitCode(report, command.noGate);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(
    `backtest cases=${report.overall.caseCount} coverage=${percent(report.overall.estimateCoverage)} ` +
    `medianAPE=${percent(report.overall.medianApe)} p75APE=${percent(report.overall.p75Ape)} ` +
    `gate=${command.noGate ? 'disabled' : exitCode === 1 ? 'failed' : completed(report) ? 'passed' : 'not-evaluated'}\n`,
  );
  return exitCode;
}

export async function runMarketDataCommand(args: readonly string[], now: Date = new Date()): Promise<number> {
  const command = parseMarketDataArgs(args, now);
  if (command.command === 'update') {
    return update(command.asOf);
  }
  return backtest(command);
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runMarketDataCommand(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${error instanceof CliInputError ? 'BAD INPUT' : 'ERROR'}: ${message}\n`);
    process.exitCode = error instanceof CliInputError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
