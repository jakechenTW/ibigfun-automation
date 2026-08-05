import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateValuationReview, validateValuationReviewAgainstEnriched } from './valuation-review.ts';

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
    resultingBucket: 'candidate',
  }],
};

test('uses candidate vocabulary and rejects the retired near-threshold bucket', () => {
  const retiredBucketReview = {
    ...completeReview,
    reviews: [{ ...completeReview.reviews[0], resultingBucket: 'near-threshold' }],
  };

  assert.doesNotThrow(() => validateValuationReview(completeReview));
  assert.throws(() => validateValuationReview(retiredBucketReview), /resultingBucket/);
});

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
      resultingBucket: 'candidate',
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

const authoritativeEnriched = {
  listings: [{
    id: 53199422,
    marketEstimate: {
      status: 'reliable',
      unavailableReasons: [],
      marketUnitPriceMedian: 88,
      marketUnitPriceP25: 82,
      marketUnitPriceP75: 95,
    },
  }],
};

test('binds a valid external review to authoritative enriched market evidence', () => {
  const review = validateValuationReview(completeReview);
  assert.doesNotThrow(() => validateValuationReviewAgainstEnriched(review, authoritativeEnriched));
});

test('rejects review listing IDs missing from or duplicated in enriched listings', () => {
  const review = validateValuationReview(completeReview);
  assert.throws(() => validateValuationReviewAgainstEnriched(review, { listings: [] }), /listingId 53199422.*exactly one/);
  assert.throws(() => validateValuationReviewAgainstEnriched(review, {
    listings: [...authoritativeEnriched.listings, ...authoritativeEnriched.listings],
  }), /listingId 53199422.*exactly one/);
});

test('rejects duplicate review entries for one listing ID', () => {
  const review = validateValuationReview({
    ...completeReview,
    reviews: [completeReview.reviews[0], { ...completeReview.reviews[0] }],
  });
  assert.throws(() => validateValuationReviewAgainstEnriched(review, authoritativeEnriched), /duplicate review listingId/);
});

test('rejects fabricated official status or unavailable reasons', () => {
  const statusMismatch = validateValuationReview({
    ...completeReview,
    reviews: [{
      ...completeReview.reviews[0],
      officialStatus: 'review',
      officialUnavailableReasons: ['insufficient-comparables'],
    }],
  });
  assert.throws(() => validateValuationReviewAgainstEnriched(statusMismatch, authoritativeEnriched), /officialStatus/);

  const reasonsMismatch = validateValuationReview({
    ...completeReview,
    reviews: [{
      ...completeReview.reviews[0],
      officialStatus: 'review',
      officialUnavailableReasons: ['fabricated'],
    }],
  });
  assert.throws(() => validateValuationReviewAgainstEnriched(reasonsMismatch, {
    listings: [{
      id: 53199422,
      marketEstimate: {
        status: 'review',
        unavailableReasons: ['insufficient-comparables'],
        marketUnitPriceMedian: 88,
        marketUnitPriceP25: 82,
        marketUnitPriceP75: 95,
      },
    }],
  }), /officialUnavailableReasons/);
});

test('rejects fabricated official interval values including null mismatches', () => {
  const numericMismatches = [
    { field: 'officialMedianWan', value: 89, differencePercent: 3.37 },
    { field: 'officialP25Wan', value: 83, differencePercent: 4.55 },
    { field: 'officialP75Wan', value: 96, differencePercent: 4.55 },
  ] as const;
  for (const { field, value, differencePercent } of numericMismatches) {
    const mismatch = validateValuationReview({
      ...completeReview,
      reviews: [{ ...completeReview.reviews[0], [field]: value, differencePercent }],
    });
    assert.throws(
      () => validateValuationReviewAgainstEnriched(mismatch, authoritativeEnriched),
      new RegExp(field),
    );
  }

  const reviewAuthority = {
    listings: [{
      id: 53199422,
      marketEstimate: {
        status: 'review',
        unavailableReasons: ['insufficient-comparables'],
        marketUnitPriceMedian: 88,
        marketUnitPriceP25: 82,
        marketUnitPriceP75: 95,
      },
    }],
  };
  for (const field of ['officialMedianWan', 'officialP25Wan', 'officialP75Wan'] as const) {
    const nullMismatch = validateValuationReview({
      schemaVersion: 1,
      reviews: [{
        ...completeReview.reviews[0],
        officialStatus: 'review',
        officialUnavailableReasons: ['insufficient-comparables'],
        [field]: null,
        differencePercent: field === 'officialMedianWan' ? null : 4.55,
        resultingBucket: 'candidate',
      }],
    });
    assert.throws(
      () => validateValuationReviewAgainstEnriched(nullMismatch, reviewAuthority),
      new RegExp(field),
    );
  }
});

test('recomputes external-versus-official difference within a 0.01 point tolerance', () => {
  const validRounded = validateValuationReview(completeReview);
  assert.doesNotThrow(() => validateValuationReviewAgainstEnriched(validRounded, authoritativeEnriched));

  const fabricatedDifference = validateValuationReview({
    ...completeReview,
    reviews: [{ ...completeReview.reviews[0], differencePercent: 4.57 }],
  });
  assert.throws(() => validateValuationReviewAgainstEnriched(fabricatedDifference, authoritativeEnriched), /differencePercent/);
});
