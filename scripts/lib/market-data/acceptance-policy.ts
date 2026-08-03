import { PARKING_BACKTEST_GATE, SCENARIO_BACKTEST_GATE } from './config.ts';
import type {
  ParkingFamilyAcceptance,
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
    if (Math.abs(cohort.bias) > SCENARIO_BACKTEST_GATE.maximumAbsoluteBias) {
      reasons.push('absolute-bias-target-missed');
    }
    if (cohort.intervalCoverage < SCENARIO_BACKTEST_GATE.minimumIntervalCoverage) {
      reasons.push('interval-coverage-target-missed');
    }
  }
  return {
    status: cohort.scoredCases < SCENARIO_BACKTEST_GATE.minimumUseCohortCases
      ? 'diagnostic-only'
      : reasons.length === 0 ? 'accepted' : 'failed',
    reasons,
  };
}

type ParkingFamilyDecisionInput = Omit<ParkingFamilyAcceptance, 'status' | 'reasons'>;

export function decideParkingFamily(
  metrics: ParkingFamilyDecisionInput,
): Pick<ParkingFamilyAcceptance, 'status' | 'reasons'> {
  const reasons: string[] = [];
  if (metrics.caseCount < PARKING_BACKTEST_GATE.minimumMaskedCases) {
    reasons.push('insufficient-masked-parking-cases');
  }
  const complete = metrics.estimatedCount > 0
    && metrics.priceMedianApe !== null
    && metrics.priceP75Ape !== null
    && metrics.areaMedianApe !== null
    && metrics.areaP75Ape !== null
    && metrics.priceIntervalCoverage !== null
    && metrics.areaIntervalCoverage !== null;
  if (!complete) {
    reasons.push('incomplete-masked-parking-metrics');
  } else {
    if (metrics.estimateCoverage < PARKING_BACKTEST_GATE.minimumEstimateCoverage) {
      reasons.push('parking-estimate-coverage-target-missed');
    }
    if (metrics.priceMedianApe! > PARKING_BACKTEST_GATE.priceMedianApeMax) {
      reasons.push('parking-price-median-ape-target-missed');
    }
    if (metrics.priceP75Ape! > PARKING_BACKTEST_GATE.priceP75ApeMax) {
      reasons.push('parking-price-p75-ape-target-missed');
    }
    if (metrics.areaMedianApe! > PARKING_BACKTEST_GATE.areaMedianApeMax) {
      reasons.push('parking-area-median-ape-target-missed');
    }
    if (metrics.areaP75Ape! > PARKING_BACKTEST_GATE.areaP75ApeMax) {
      reasons.push('parking-area-p75-ape-target-missed');
    }
    if (metrics.priceIntervalCoverage! < PARKING_BACKTEST_GATE.minimumPriceIntervalCoverage) {
      reasons.push('parking-price-interval-coverage-target-missed');
    }
    if (metrics.areaIntervalCoverage! < PARKING_BACKTEST_GATE.minimumAreaIntervalCoverage) {
      reasons.push('parking-area-interval-coverage-target-missed');
    }
  }
  return {
    status: metrics.caseCount < PARKING_BACKTEST_GATE.minimumMaskedCases
      ? 'diagnostic-only'
      : reasons.length === 0 ? 'accepted' : 'failed',
    reasons,
  };
}

export function decideParkingImputation(
  comparison: ScenarioBacktestAcceptance['parkingComparison'],
  families: Record<'flat' | 'mechanical', Pick<ParkingFamilyAcceptance, 'status'>>,
): boolean {
  return families.flat.status === 'accepted'
    && families.mechanical.status === 'accepted'
    && comparison.imputedCoverage > comparison.directCoverage
    && comparison.imputedMedianApe !== null
    && comparison.imputedMedianApe <= SCENARIO_BACKTEST_GATE.medianApeMax
    && comparison.imputedP75Ape !== null
    && comparison.imputedP75Ape <= SCENARIO_BACKTEST_GATE.p75ApeMax
    && comparison.biasRegression !== null
    && comparison.biasRegression <= SCENARIO_BACKTEST_GATE.maximumAbsoluteBiasRegression + Number.EPSILON
    && comparison.intervalCoverageRegression !== null
    && comparison.intervalCoverageRegression <= SCENARIO_BACKTEST_GATE.maximumIntervalCoverageRegression + Number.EPSILON;
}
