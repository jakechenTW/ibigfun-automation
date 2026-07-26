import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateValuationReview } from './valuation-review.ts';

const completeReview = {
  schemaVersion: 1,
  reviews: [{
    listingId: 53199422,
    source: '好時價',
    sourceUrl: 'https://example.invalid/valuation',
    checkedAt: '2026-07-26T01:00:00.000Z',
    externalUnitPriceWan: 92,
    externalTotalPriceWan: 1600,
    officialMedianWan: 88,
    officialP25Wan: 82,
    officialP75Wan: 95,
    differencePercent: 4.55,
    accepted: true,
    rationale: '門牌與型態一致，作為邊界覆核',
    resultingBucket: 'near-threshold',
  }],
};

test('accepts complete external valuation evidence', () => {
  assert.doesNotThrow(() => validateValuationReview(completeReview));
});

test('rejects silent override without source URL or rationale', () => {
  const invalidReview = {
    ...completeReview,
    reviews: [{ ...completeReview.reviews[0], sourceUrl: '', rationale: '' }],
  };
  assert.throws(() => validateValuationReview(invalidReview), /sourceUrl/);
});

test('rejects a non-ISO check timestamp', () => {
  const invalidReview = {
    ...completeReview,
    reviews: [{ ...completeReview.reviews[0], checkedAt: 'yesterday' }],
  };
  assert.throws(() => validateValuationReview(invalidReview), /checkedAt/);
});

test('rejects an impossible ISO calendar date', () => {
  const invalidReview = {
    ...completeReview,
    reviews: [{ ...completeReview.reviews[0], checkedAt: '2026-02-30T01:00:00.000Z' }],
  };
  assert.throws(() => validateValuationReview(invalidReview), /checkedAt/);
});

test('rejects a non-finite official valuation field', () => {
  const invalidReview = {
    ...completeReview,
    reviews: [{ ...completeReview.reviews[0], officialP25Wan: Number.NaN }],
  };
  assert.throws(() => validateValuationReview(invalidReview), /officialP25Wan/);
});

test('rejects an empty external valuation review file', () => {
  assert.throws(() => validateValuationReview({ schemaVersion: 1, reviews: [] }), /at least one review/);
});
