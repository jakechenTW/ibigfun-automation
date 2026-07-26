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
    officialStatus: 'reliable',
    officialUnavailableReasons: [],
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

test('accepts an external unit value when official valuation is unavailable', () => {
  const unavailableReview = {
    schemaVersion: 1,
    reviews: [{
      listingId: 53199423,
      source: '好時價',
      sourceUrl: 'https://example.invalid/unavailable-review',
      checkedAt: '2026-07-26T02:00:00.000Z',
      externalUnitPriceWan: 91,
      externalTotalPriceWan: null,
      officialStatus: 'unavailable',
      officialUnavailableReasons: ['market-data-unavailable'],
      officialMedianWan: null,
      officialP25Wan: null,
      officialP75Wan: null,
      differencePercent: null,
      accepted: true,
      rationale: '官方行情不可用；外部單價僅供人工候選覆核，不升為推薦',
      resultingBucket: 'near-threshold',
    }],
  };
  const validated = validateValuationReview(unavailableReview);
  assert.equal(validated.reviews[0]?.externalTotalPriceWan, null);
  assert.equal(validated.reviews[0]?.officialStatus, 'unavailable');
});

test('accepts a documented unsuccessful external lookup without pretending it returned prices', () => {
  const noResultReview = {
    ...completeReview,
    reviews: [{
      ...completeReview.reviews[0],
      externalUnitPriceWan: null,
      externalTotalPriceWan: null,
      accepted: false,
      rationale: '來源查無逐址估值；維持官方分桶，不採納外部結果',
      differencePercent: null,
    }],
  };
  assert.doesNotThrow(() => validateValuationReview(noResultReview));
});

test('rejects accepting an external review that returned no valuation evidence', () => {
  const emptyAcceptedReview = {
    ...completeReview,
    reviews: [{
      ...completeReview.reviews[0],
      externalUnitPriceWan: null,
      externalTotalPriceWan: null,
      differencePercent: null,
      accepted: true,
    }],
  };
  assert.throws(() => validateValuationReview(emptyAcceptedReview), /cannot be accepted without an external price/);
});

test('rejects a numeric difference without both unit-price inputs', () => {
  const invalidDifference = {
    ...completeReview,
    reviews: [{ ...completeReview.reviews[0], officialMedianWan: null }],
  };
  assert.throws(() => validateValuationReview(invalidDifference), /differencePercent/);
});

test('rejects recommending from officially unavailable evidence', () => {
  const unavailableRecommendation = {
    schemaVersion: 1,
    reviews: [{
      listingId: 53199424,
      source: '好時價',
      sourceUrl: 'https://example.invalid/unavailable-recommendation',
      checkedAt: '2026-07-26T03:00:00.000Z',
      externalUnitPriceWan: 91,
      officialStatus: 'unavailable',
      officialUnavailableReasons: ['market-data-unavailable'],
      accepted: true,
      rationale: '官方行情不可用，外部結果只能保留人工候選',
      resultingBucket: 'recommended',
    }],
  };
  assert.throws(() => validateValuationReview(unavailableRecommendation), /cannot result in recommended/);
});
