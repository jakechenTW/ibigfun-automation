import { SCENARIO_BACKTEST_GATE } from './config.ts';
import type {
  ScenarioBacktestAcceptance,
  ScenarioCohortAcceptance,
} from './types.ts';

type ScenarioCohortDecisionInput = Pick<
  ScenarioCohortAcceptance,
  'scoredCases' | 'medianApe' | 'p75Ape' | 'bias' | 'intervalCoverage'
>;

export function decideScenarioCohort(
  cohort: ScenarioCohortDecisionInput,
): Pick<ScenarioCohortAcceptance, 'status' | 'reasons'> {
  const reasons: string[] = [];
  if (cohort.scoredCases < SCENARIO_BACKTEST_GATE.minimumUseCohortCases) {
    reasons.push('insufficient-use-cohort-cases');
  }
  if (cohort.medianApe === null || cohort.p75Ape === null
    || cohort.bias === null || cohort.intervalCoverage === null) {
    reasons.push('incomplete-use-cohort-metrics');
  } else {
    if (cohort.medianApe > SCENARIO_BACKTEST_GATE.medianApeMax) {
      reasons.push('median-ape-target-missed');
    }
    if (cohort.p75Ape > SCENARIO_BACKTEST_GATE.p75ApeMax) {
      reasons.push('p75-ape-target-missed');
    }
  }
  return {
    status: cohort.scoredCases < SCENARIO_BACKTEST_GATE.minimumUseCohortCases
      ? 'diagnostic-only'
      : reasons.length === 0 ? 'accepted' : 'failed',
    reasons,
  };
}

export function decideParkingImputation(
  comparison: ScenarioBacktestAcceptance['parkingComparison'],
): boolean {
  return comparison.imputedCoverage > comparison.directCoverage
    && comparison.imputedMedianApe !== null
    && comparison.imputedMedianApe <= SCENARIO_BACKTEST_GATE.medianApeMax
    && comparison.imputedP75Ape !== null
    && comparison.imputedP75Ape <= SCENARIO_BACKTEST_GATE.p75ApeMax
    && comparison.biasRegression !== null
    && comparison.biasRegression <= SCENARIO_BACKTEST_GATE.maximumAbsoluteBiasRegression + Number.EPSILON
    && comparison.intervalCoverageRegression !== null
    && comparison.intervalCoverageRegression <= SCENARIO_BACKTEST_GATE.maximumIntervalCoverageRegression + Number.EPSILON;
}
