import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNotificationStatusAllowsMarketData, validateReportEvidence } from './report-notify.ts';

const freshEnrichment = {
  tenureEligible: 1,
  tenureExpired: 0,
  tenureReview: 0,
  marketReliable: 1,
  marketReview: 0,
  marketUnavailable: 0,
  marketDataStale: 0,
  listings: [{
    tenureGate: 'eligible',
    marketEstimate: { status: 'reliable', sourceFreshness: { transactionStale: false, doorplateStale: false } },
  }],
};

test('all report statuses reject legacy enrichment without tenureGate', () => {
  const legacy = {
    ...freshEnrichment,
    listings: [{ marketEstimate: freshEnrichment.listings[0].marketEstimate }],
  };
  for (const status of ['ok', 'warn', 'fail'] as const) {
    assert.throws(() => validateReportEvidence(status, legacy), /rerun enrich.*tenureGate/);
  }
});

test('tenure summary counts must match listing gates', () => {
  assert.throws(
    () => validateReportEvidence('warn', { ...freshEnrichment, tenureExpired: 1 }),
    /tenure summary counts must match listings/,
  );
});

test('rejects ok notification status when enrichment summary reports stale official data', () => {
  assert.throws(
    () => assertNotificationStatusAllowsMarketData('ok', {
      ...freshEnrichment,
      marketDataStale: 1,
      listings: [{
        tenureGate: 'eligible',
        marketEstimate: { status: 'reliable', sourceFreshness: { transactionStale: true, doorplateStale: false } },
      }],
    }),
    /--status-notify warn/,
  );
});

test('rejects ok notification status when a listing has a stale official source', () => {
  assert.throws(
    () => assertNotificationStatusAllowsMarketData('ok', {
      ...freshEnrichment,
      listings: [{
        tenureGate: 'eligible',
        marketEstimate: { status: 'reliable', sourceFreshness: { transactionStale: true, doorplateStale: false } },
      }],
    }),
    /market summary counts must match listings/,
  );
});

test('allows warn status for stale data and ok status for fresh data', () => {
  assert.doesNotThrow(() => assertNotificationStatusAllowsMarketData('warn', { ...freshEnrichment, marketDataStale: 1 }));
  assert.doesNotThrow(() => assertNotificationStatusAllowsMarketData('ok', freshEnrichment));
});

test('rejects ok notification status when the enriched artifact is missing', () => {
  assert.throws(() => assertNotificationStatusAllowsMarketData('ok', undefined), /enriched artifact is required/);
});

test('rejects ok notification status when the enriched artifact is malformed', () => {
  assert.throws(() => assertNotificationStatusAllowsMarketData('ok', { marketDataStale: 0 }), /valid enriched artifact/);
});

test('allows ok when fresh market review evidence is internally consistent', () => {
  assert.doesNotThrow(() => assertNotificationStatusAllowsMarketData('ok', {
    ...freshEnrichment,
    marketReliable: 0,
    marketReview: 1,
    listings: [{
      tenureGate: 'eligible',
      marketEstimate: { status: 'review', sourceFreshness: { transactionStale: false, doorplateStale: false } },
    }],
  }));
});

test('allows ok when fresh unavailable market evidence is internally consistent', () => {
  assert.doesNotThrow(() => assertNotificationStatusAllowsMarketData('ok', {
    ...freshEnrichment,
    marketReliable: 0,
    marketUnavailable: 1,
    listings: [{
      tenureGate: 'eligible',
      marketEstimate: { status: 'unavailable', sourceFreshness: { transactionStale: false, doorplateStale: false } },
    }],
  }));
});

test('fails closed when market summary counts disagree with listings', () => {
  assert.throws(
    () => assertNotificationStatusAllowsMarketData('ok', { ...freshEnrichment, marketReview: 1 }),
    /market summary counts must match listings/,
  );
});

test('warn and fail statuses do not validate incomplete market evidence', () => {
  assert.doesNotThrow(() => assertNotificationStatusAllowsMarketData('warn', undefined));
  assert.doesNotThrow(() => assertNotificationStatusAllowsMarketData('fail', { malformed: true }));
});

test('warn status cannot bypass valuation review binding', () => {
  const enriched = {
    tenureEligible: 1,
    tenureExpired: 0,
    tenureReview: 0,
    marketReliable: 0,
    marketReview: 1,
    marketUnavailable: 0,
    marketDataStale: 0,
    listings: [{
      id: 53199422,
      tenureGate: 'eligible',
      marketEstimate: {
        status: 'review',
        unavailableReasons: ['insufficient-comparables'],
        marketUnitPriceMedian: 88,
        marketUnitPriceP25: 82,
        marketUnitPriceP75: 95,
        sourceFreshness: { transactionStale: false, doorplateStale: false },
      },
    }],
  };
  const fabricatedReview = {
    schemaVersion: 1,
    reviews: [{
      listingId: 53199422,
      source: '好時價',
      sourceUrl: 'https://example.invalid/warn-bypass',
      checkedAt: '2026-07-26T04:00:00.000Z',
      externalUnitPriceWan: 92,
      externalTotalPriceWan: null,
      officialStatus: 'review',
      officialUnavailableReasons: ['fabricated-reason'],
      officialMedianWan: 88,
      officialP25Wan: 82,
      officialP75Wan: 95,
      differencePercent: 4.55,
      accepted: true,
      rationale: '測試 warn 不可繞過官方證據綁定',
      resultingBucket: 'candidate',
    }],
  };
  assert.throws(() => validateReportEvidence('warn', enriched, fabricatedReview), /officialUnavailableReasons/);
});
