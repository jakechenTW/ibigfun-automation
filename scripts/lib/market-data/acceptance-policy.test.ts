import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideParkingImputation,
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

  assert.equal(decideParkingImputation(passing), true);
  assert.equal(decideParkingImputation({ ...passing, imputedCoverage: 0.70 }), false);
  assert.equal(decideParkingImputation({ ...passing, biasRegression: 0.011 }), false);
  assert.equal(decideParkingImputation({ ...passing, intervalCoverageRegression: 0.051 }), false);
});
