import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideParkingImputation,
  decideParkingFamily,
  decideScenarioCohort,
} from './acceptance-policy.ts';

test('shared scenario policy keeps sparse cohorts diagnostic and rejects inaccurate full cohorts', () => {
  assert.deepEqual(decideScenarioCohort({
    scoredCases: 19,
    medianApe: 0.05,
    p75Ape: 0.10,
    bias: 0,
    intervalCoverage: 0.8,
  }), {
    status: 'diagnostic-only',
    reasons: ['insufficient-use-cohort-cases'],
  });
  assert.deepEqual(decideScenarioCohort({
    scoredCases: 20,
    medianApe: 0.13,
    p75Ape: 0.21,
    bias: 0,
    intervalCoverage: 0.8,
  }), {
    status: 'failed',
    reasons: ['median-ape-target-missed', 'p75-ape-target-missed'],
  });
});

test('shared scenario policy rejects catastrophic absolute bias and interval coverage', () => {
  assert.deepEqual(decideScenarioCohort({
    scoredCases: 20,
    medianApe: 0.08,
    p75Ape: 0.16,
    bias: 0.99,
    intervalCoverage: 0,
  }), {
    status: 'failed',
    reasons: ['absolute-bias-target-missed', 'interval-coverage-target-missed'],
  });
});

test('masked parking policy fails sparse families closed and rejects poor component calibration', () => {
  const passing = {
    caseCount: 25,
    estimatedCount: 20,
    estimateCoverage: 0.8,
    priceMedianApe: 0.10,
    priceP75Ape: 0.20,
    areaMedianApe: 0.08,
    areaP75Ape: 0.16,
    priceIntervalCoverage: 0.50,
    areaIntervalCoverage: 0.50,
  };
  assert.deepEqual(decideParkingFamily(passing), { status: 'accepted', reasons: [] });
  assert.deepEqual(decideParkingFamily({ ...passing, caseCount: 19, estimatedCount: 19, estimateCoverage: 1 }), {
    status: 'diagnostic-only',
    reasons: ['insufficient-masked-parking-cases'],
  });
  assert.deepEqual(decideParkingFamily({
    ...passing,
    priceMedianApe: 0.90,
    priceP75Ape: 1.20,
    areaMedianApe: 0.80,
    areaP75Ape: 1,
    priceIntervalCoverage: 0,
    areaIntervalCoverage: 0,
  }), {
    status: 'failed',
    reasons: [
      'parking-price-median-ape-target-missed',
      'parking-price-p75-ape-target-missed',
      'parking-area-median-ape-target-missed',
      'parking-area-p75-ape-target-missed',
      'parking-price-interval-coverage-target-missed',
      'parking-area-interval-coverage-target-missed',
    ],
  });
});

test('shared parking policy requires strict coverage improvement within every regression bound', () => {
  const passing = {
    directCoverage: 0.70,
    imputedCoverage: 0.71,
    directMedianApe: 0.10,
    imputedMedianApe: 0.11,
    directP75Ape: 0.18,
    imputedP75Ape: 0.19,
    biasRegression: 0.01,
    intervalCoverageRegression: 0.05,
  };

  const families = {
    flat: { status: 'accepted' as const },
    mechanical: { status: 'accepted' as const },
  };
  assert.equal(decideParkingImputation(passing, families), true);
  assert.equal(decideParkingImputation({ ...passing, imputedCoverage: 0.70 }, families), false);
  assert.equal(decideParkingImputation({ ...passing, biasRegression: 0.011 }, families), false);
  assert.equal(decideParkingImputation({ ...passing, intervalCoverageRegression: 0.051 }, families), false);
  assert.equal(decideParkingImputation(passing, {
    ...families,
    mechanical: { status: 'diagnostic-only' },
  }), false);
});
