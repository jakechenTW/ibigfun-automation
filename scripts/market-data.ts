/**
 * Operator CLI for the local Taipei market-data build and its offline backtest.
 * Backtesting reads only the active validated build; it never refreshes sources.
 */
import { pathToFileURL } from 'node:url';
import { isValidDateString, taipeiDateString } from './lib/date.ts';
import {
  backtestAcceptance,
  backtestTransactions,
  evaluateBacktestGate,
  type BacktestReport,
} from './lib/market-data/backtest.ts';
import {
  ACTIVE_ESTIMATOR_POLICY,
  estimatorPolicyById,
  MARKET_DATA_ROOT,
  type PolicyId,
} from './lib/market-data/config.ts';
import {
  assertCurrentMarketDataIndexPolicy,
  loadMarketData,
  marketDataFreshness,
  readManifest,
  recoverInterruptedMarketDataPublication,
  transactionArtifactChecksum,
  writeBacktestAcceptance,
} from './lib/market-data/store.ts';
import {
  ensureTaipeiMarketData,
  evaluateTaipeiMarketDataCandidate,
  type CandidateEvaluation,
  type EvaluateTaipeiMarketDataCandidateOptions,
  withMarketDataLock,
} from './lib/market-data/update.ts';

const SUPPORTED_CITY = 'taipei';
export class CliInputError extends Error {}

export type MarketDataCommand =
  | { command: 'update'; city: typeof SUPPORTED_CITY; asOf: string }
  | { command: 'candidate'; city: typeof SUPPORTED_CITY; asOf: string; policyId: PolicyId }
  | { command: 'backtest'; city: typeof SUPPORTED_CITY; asOf: string; noGate: boolean; policyId: PolicyId };

export interface MarketDataCommandDependencies {
  candidateEvaluator?: (
    options: EvaluateTaipeiMarketDataCandidateOptions,
  ) => Promise<CandidateEvaluation>;
  /** Narrow test seam for deterministic backtest/update lock sequencing. */
  backtest?: {
    root?: string;
    lock?: typeof withMarketDataLock;
    recover?: typeof recoverInterruptedMarketDataPublication;
    load?: typeof loadMarketData;
    readManifest?: typeof readManifest;
    evaluate?: typeof backtestTransactions;
    persistAcceptance?: typeof writeBacktestAcceptance;
  };
}

function readFlagValue(args: readonly string[], index: number, flag: string): [string, number] {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new CliInputError(`${flag} requires a value`);
  return [value, index + 1];
}

/** Strictly parses the small public CLI surface before any filesystem or network work. */
export function parseMarketDataArgs(args: readonly string[], now: Date = new Date()): MarketDataCommand {
  const command = args[0];
  if (command !== 'update' && command !== 'candidate' && command !== 'backtest') {
    throw new CliInputError(
      'usage: market-data <update|candidate|backtest> --city taipei [--as-of YYYY-MM-DD] [--no-gate] [--policy <baseline|48-month|1000-meter>]',
    );
  }

  let city: string | undefined;
  let asOf: string | undefined;
  let noGate = false;
  let policyId: PolicyId | undefined;
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
    } else if (argument === '--policy' || argument.startsWith('--policy=')) {
      if (command === 'update') throw new CliInputError('--policy is supported only by candidate or backtest');
      if (policyId !== undefined) throw new CliInputError('--policy may be supplied only once');
      const value = argument === '--policy'
        ? readFlagValue(args, index, '--policy')
        : [argument.slice('--policy='.length), index] as const;
      const selected = value[0];
      index = value[1];
      if (selected !== 'baseline' && selected !== '48-month' && selected !== '1000-meter') {
        throw new CliInputError(`unsupported policy: ${selected}`);
      }
      policyId = selected;
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
  if (command === 'candidate') return { command, city, asOf: resolvedAsOf, policyId: policyId ?? ACTIVE_ESTIMATOR_POLICY.id };
  return { command, city, asOf: resolvedAsOf, noGate, policyId: policyId ?? ACTIVE_ESTIMATOR_POLICY.id };
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/** Returns the post-report quality-gate exit status without changing local state. */
export function backtestExitCode(report: BacktestReport, noGate: boolean): number {
  return noGate || evaluateBacktestGate(report).passed ? 0 : 1;
}

export function shouldPersistBacktestAcceptance(report: BacktestReport, noGate: boolean): boolean {
  return !noGate
    && report.policyId === ACTIVE_ESTIMATOR_POLICY.id
    && evaluateBacktestGate(report).passed;
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

async function backtest(
  command: Extract<MarketDataCommand, { command: 'backtest' }>,
  now: Date,
  dependencies: NonNullable<MarketDataCommandDependencies['backtest']> = {},
): Promise<number> {
  const root = dependencies.root ?? MARKET_DATA_ROOT;
  const lock = dependencies.lock ?? withMarketDataLock;
  const result = await lock(root, async () => {
    // Read-only diagnostic backtests still share the refresh lock but never persist.
    await (dependencies.recover ?? recoverInterruptedMarketDataPublication)(root);
    const bundle = await (dependencies.load ?? loadMarketData)(root);
    if (!bundle) {
      const manifest = (dependencies.readManifest ?? readManifest)(root);
      if (manifest) assertCurrentMarketDataIndexPolicy(manifest);
      throw new Error(`No validated Taipei market-data build at ${root}; run update first`);
    }
    assertCurrentMarketDataIndexPolicy(bundle.manifest);
    const policy = estimatorPolicyById(command.policyId);
    const report = (dependencies.evaluate ?? backtestTransactions)(
      bundle.transactions,
      { asOf: command.asOf, policy },
    );
    const gate = evaluateBacktestGate(report);
    const exitCode = backtestExitCode(report, command.noGate);
    if (shouldPersistBacktestAcceptance(report, command.noGate)) {
      const checksum = transactionArtifactChecksum(bundle.manifest);
      if (!checksum) throw new Error('Active build lacks transactions-index.json checksum');
      await (dependencies.persistAcceptance ?? writeBacktestAcceptance)(
        root,
        backtestAcceptance(report, checksum, now.toISOString()),
      );
    }
    return { report, gate, exitCode };
  });
  const { report, gate, exitCode } = result;
  process.stdout.write(`${JSON.stringify({ ...report, acceptanceGate: gate }, null, 2)}\n`);
  process.stderr.write(
    `backtest cases=${report.overall.caseCount} coverage=${percent(report.overall.estimateCoverage)} ` +
    `policy=${report.policyId} medianAPE=${percent(report.byStatus.reliable.medianApe)} ` +
    `p75APE=${percent(report.byStatus.reliable.p75Ape)} ` +
    `gate=${command.noGate ? 'disabled' : gate.passed ? 'passed' : `failed(${gate.reasons.join(',')})`}\n`,
  );
  return exitCode;
}

async function candidate(
  command: Extract<MarketDataCommand, { command: 'candidate' }>,
  evaluator: NonNullable<MarketDataCommandDependencies['candidateEvaluator']>,
): Promise<number> {
  const evaluation = await evaluator({
    asOf: command.asOf,
    policy: estimatorPolicyById(command.policyId),
    publish: false,
  });
  process.stdout.write(`${JSON.stringify({
    diagnostics: evaluation.diagnostics,
    report: evaluation.report,
    acceptanceGate: evaluation.gate,
  }, null, 2)}\n`);
  process.stderr.write(
    `candidate rows=${evaluation.diagnostics.rawRows} reliable=${evaluation.diagnostics.reliableEligible} ` +
    `review=${evaluation.diagnostics.reviewOnly} excluded=${evaluation.diagnostics.excluded} ` +
    `policy=${evaluation.report.policyId} gate=${evaluation.gate.passed ? 'passed' : `failed(${evaluation.gate.reasons.join(',')})`}\n`,
  );
  return evaluation.gate.passed ? 0 : 1;
}

export async function runMarketDataCommand(
  args: readonly string[],
  now: Date = new Date(),
  dependencies: MarketDataCommandDependencies = {},
): Promise<number> {
  const command = parseMarketDataArgs(args, now);
  if (command.command === 'update') {
    return update(command.asOf);
  }
  if (command.command === 'candidate') {
    return candidate(command, dependencies.candidateEvaluator ?? evaluateTaipeiMarketDataCandidate);
  }
  return backtest(command, now, dependencies.backtest);
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
