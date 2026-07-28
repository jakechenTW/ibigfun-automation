import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTIVE_ESTIMATOR_POLICY,
  estimatorPolicyById,
} from './config.ts';
import {
  type MarketDataCommandDependencies,
  parseMarketDataArgs,
  runMarketDataCommand,
  shouldPersistBacktestAcceptance,
} from '../../market-data.ts';
import { backtestTransactions, type BacktestReport } from './backtest.ts';
import type { BacktestAcceptance, MarketDataBundle, TransactionIndex } from './types.ts';

function passingBacktestReport(index: TransactionIndex): BacktestReport {
  const report = backtestTransactions(index, { asOf: '2026-07-25' });
  const metric = (values: Partial<BacktestReport['overall']> = {}): BacktestReport['overall'] => ({
    caseCount: 25,
    estimatedCount: 20,
    estimateCoverage: 0.8,
    medianApe: 0.08,
    p75Ape: 0.16,
    bias: 0,
    intervalCoverage: 0.5,
    ...values,
  });
  return {
    ...report,
    latestEligibleTransactionDate: '2025-12-01',
    overall: metric(),
    byStatus: {
      reliable: metric(),
      review: metric({
        caseCount: 0, estimatedCount: 0, estimateCoverage: 0,
        medianApe: null, p75Ape: null,
      }),
      unavailable: metric({
        caseCount: 0, estimatedCount: 0, estimateCoverage: 0,
        medianApe: null, p75Ape: null,
      }),
    },
    byConfidence: {
      ...report.byConfidence,
      high: metric({ medianApe: 0.08 }),
      medium: metric({ medianApe: 0.10 }),
    },
  };
}

function deterministicLock(): <T>(root: string, operation: () => Promise<T>) => Promise<T> {
  let held = false;
  const waiters: Array<() => void> = [];
  return async <T>(_root: string, operation: () => Promise<T>): Promise<T> => {
    if (held) await new Promise<void>((resolve) => waiters.push(resolve));
    held = true;
    try {
      return await operation();
    } finally {
      held = false;
      waiters.shift()?.();
    }
  };
}

test('backtest CLI accepts each explicit estimator policy', () => {
  for (const policy of ['baseline', '48-month', '1000-meter'] as const) {
    const parsed = parseMarketDataArgs(['backtest', '--city', 'taipei', '--policy', policy]);
    assert.equal(parsed.command, 'backtest');
    assert.equal(parsed.policyId, policy);
    assert.equal(estimatorPolicyById(policy).id, policy);
  }
});

test('candidate CLI accepts each explicit diagnostic estimator policy', () => {
  for (const policy of ['baseline', '48-month', '1000-meter'] as const) {
    const parsed = parseMarketDataArgs(['candidate', '--city', 'taipei', '--policy', policy]);
    assert.equal(parsed.command, 'candidate');
    assert.equal(parsed.policyId, policy);
  }
});

test('candidate CLI evaluates 48-month policy diagnostically without requesting publication', async () => {
  const emptyIndex: TransactionIndex = {
    schemaVersion: 2,
    datasetVersion: 'fixture',
    builtAt: '2026-07-25T00:00:00.000Z',
    cells: {},
  };
  let requestedPublish: boolean | null = null;
  let requestedPolicy: string | null = null;
  const exitCode = await runMarketDataCommand(
    ['candidate', '--city', 'taipei', '--policy', '48-month'],
    new Date('2026-07-25T00:00:00.000Z'),
    {
      candidateEvaluator: async (options) => {
        requestedPublish = options.publish;
        requestedPolicy = options.policy.id;
        return {
          report: backtestTransactions(emptyIndex, { asOf: options.asOf, policy: options.policy }),
          gate: { passed: true, complete: true, reasons: [] },
          acceptance: null,
          diagnostics: {
            rawRows: 0, reliableEligible: 0, reviewOnly: 0, excluded: 0, excludedByReason: {},
          },
        };
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(requestedPolicy, '48-month');
  assert.equal(requestedPublish, false);
});

test('backtest CLI rejects unknown and duplicate policy flags', () => {
  assert.throws(
    () => parseMarketDataArgs(['backtest', '--city', 'taipei', '--policy', 'future']),
    /unsupported policy/,
  );
  assert.throws(
    () => parseMarketDataArgs([
      'backtest', '--city', 'taipei', '--policy', 'baseline', '--policy=48-month',
    ]),
    /--policy may be supplied only once/,
  );
});

test('update rejects the diagnostic policy selector', () => {
  assert.throws(
    () => parseMarketDataArgs(['update', '--city', 'taipei', '--policy', 'baseline']),
    /--policy is supported only by candidate or backtest/,
  );
});

test('backtest policy defaults to the active policy', () => {
  const parsed = parseMarketDataArgs(['backtest', '--city', 'taipei']);
  assert.equal(parsed.command, 'backtest');
  assert.equal(parsed.policyId, ACTIVE_ESTIMATOR_POLICY.id);
});

test('CLI parsing rejects unsupported cities and invalid dates before any market-data operation', () => {
  assert.throws(() => parseMarketDataArgs(['backtest', '--city', 'invalid']), /supported city: taipei/);
  assert.throws(() => parseMarketDataArgs(['backtest', '--city', 'taipei', '--as-of', '2026-02-30']), /valid YYYY-MM-DD/);
  assert.throws(() => parseMarketDataArgs(['update', '--city', 'taipei', '--as-of', '2026-07-25']), /only by backtest/);
});

test('implicit CLI dates use the Taipei calendar at the 00:00–07:59 window and a quarter boundary', () => {
  const taipeiEarlyMorning = new Date('2026-06-30T17:30:00.000Z');
  const taipeiLateMorning = new Date('2026-06-30T23:59:00.000Z');

  assert.equal(parseMarketDataArgs(['backtest', '--city', 'taipei'], taipeiEarlyMorning).asOf, '2026-07-01');
  assert.equal(parseMarketDataArgs(['backtest', '--city', 'taipei'], taipeiLateMorning).asOf, '2026-07-01');
  assert.equal(parseMarketDataArgs(['update', '--city', 'taipei'], taipeiEarlyMorning).asOf, '2026-07-01');
});

test('non-active diagnostic policy cannot persist canonical acceptance', () => {
  const emptyIndex: TransactionIndex = {
    schemaVersion: 2,
    datasetVersion: 'fixture',
    builtAt: '2026-07-25T00:00:00.000Z',
    cells: {},
  };
  const diagnostic = backtestTransactions(emptyIndex, {
    asOf: '2026-07-25',
    policy: estimatorPolicyById('48-month'),
  });
  const passingDiagnostic = {
    ...diagnostic,
    latestEligibleTransactionDate: '2026-07-25',
    overall: {
      caseCount: 25, estimatedCount: 20, estimateCoverage: 0.8,
      medianApe: 0.08, p75Ape: 0.16, bias: 0, intervalCoverage: 0.5,
    },
    byStatus: {
      reliable: {
        caseCount: 20, estimatedCount: 20, estimateCoverage: 1,
        medianApe: 0.08, p75Ape: 0.16, bias: 0, intervalCoverage: 0.5,
      },
      review: {
        caseCount: 5, estimatedCount: 0, estimateCoverage: 0,
        medianApe: null, p75Ape: null, bias: null, intervalCoverage: null,
      },
      unavailable: {
        caseCount: 0, estimatedCount: 0, estimateCoverage: 0,
        medianApe: null, p75Ape: null, bias: null, intervalCoverage: null,
      },
    },
    byConfidence: {
      ...diagnostic.byConfidence,
      high: {
        caseCount: 20, estimatedCount: 20, estimateCoverage: 1,
        medianApe: 0.08, p75Ape: 0.16, bias: 0, intervalCoverage: 0.5,
      },
      medium: {
        caseCount: 20, estimatedCount: 20, estimateCoverage: 1,
        medianApe: 0.10, p75Ape: 0.18, bias: 0, intervalCoverage: 0.5,
      },
    },
  };

  assert.equal(shouldPersistBacktestAcceptance(passingDiagnostic, false), false);
});

test('backtest acceptance writer cannot race a locked update into a stale final pair', async () => {
  const emptyIndex: TransactionIndex = {
    schemaVersion: 2,
    datasetVersion: 'old-transactions',
    builtAt: '2026-07-25T00:00:00.000Z',
    cells: {},
  };
  const oldBundle: MarketDataBundle = {
    manifest: {
      schemaVersion: 2,
      buildId: 'old-build',
      builtAt: '2026-07-25T00:00:00.000Z',
      doorplates: {
        sourceUrl: 'https://example.test/doorplates.csv',
        publishedAt: null,
        checkedAt: '2026-07-25T00:00:00.000Z',
        sha256: 'old-doorplates',
        recordCount: 0,
      },
      transactions: {
        sourceUrls: ['https://example.test/transactions.zip'],
        publishedAt: null,
        checkedAt: '2026-07-25T00:00:00.000Z',
        sha256: 'old-transactions',
        recordCount: 0,
        normalization: {
          rawRows: 0,
          reliableEligible: 0,
          reviewOnly: 0,
          excluded: 0,
          excludedByReason: {},
        },
      },
      lastFailure: null,
      artifacts: {
        'transactions-index.json': { sha256: 'old-checksum', bytes: 1 },
      },
    },
    doorplates: {
      schemaVersion: 2,
      datasetVersion: 'old-doorplates',
      byCanonicalAddress: {},
      byRoad: {},
      cells: {},
    },
    transactions: emptyIndex,
  };
  const queueLock = deterministicLock();
  let criticalSectionDepth = 0;
  const lock = async <T>(root: string, operation: () => Promise<T>): Promise<T> =>
    queueLock(root, async () => {
      criticalSectionDepth += 1;
      try {
        return await operation();
      } finally {
        criticalSectionDepth -= 1;
      }
    });
  let finalPair = { buildChecksum: 'old-checksum', acceptanceChecksum: 'old-checksum' };
  let releaseWriter!: () => void;
  let writerReached!: () => void;
  const writerCanFinish = new Promise<void>((resolve) => { releaseWriter = resolve; });
  const writerStarted = new Promise<void>((resolve) => { writerReached = resolve; });
  let recoveryRan = false;

  const backtestRun = runMarketDataCommand(
    ['backtest', '--city', 'taipei'],
    new Date('2026-07-26T01:00:00.000Z'),
    {
      backtest: {
        lock,
        recover: async () => {
          assert.equal(criticalSectionDepth, 1);
          recoveryRan = true;
        },
        load: async () => {
          assert.equal(criticalSectionDepth, 1);
          assert.equal(recoveryRan, true);
          return oldBundle;
        },
        evaluate: () => {
          assert.equal(criticalSectionDepth, 1);
          return passingBacktestReport(emptyIndex);
        },
        persistAcceptance: async (_root: string, acceptance: BacktestAcceptance) => {
          assert.equal(criticalSectionDepth, 1);
          writerReached();
          await writerCanFinish;
          finalPair = {
            ...finalPair,
            acceptanceChecksum: acceptance.transactionArtifactSha256,
          };
        },
      } as unknown as NonNullable<MarketDataCommandDependencies['backtest']>,
    },
  );
  await writerStarted;

  const updatePublication = lock('ignored-by-test-lock', async () => {
    finalPair = { buildChecksum: 'new-checksum', acceptanceChecksum: 'new-checksum' };
  });
  releaseWriter();
  await Promise.all([backtestRun, updatePublication]);

  assert.deepEqual(finalPair, {
    buildChecksum: 'new-checksum',
    acceptanceChecksum: 'new-checksum',
  });
  assert.equal(recoveryRan, true);
});
