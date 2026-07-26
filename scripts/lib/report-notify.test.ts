import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNotificationStatusAllowsMarketData } from './report-notify.ts';

const freshEnrichment = {
  marketReliable: 1,
  marketReview: 0,
  marketUnavailable: 0,
  marketDataStale: 0,
  listings: [{ marketEstimate: { status: 'reliable', sourceFreshness: { transactionStale: false, doorplateStale: false } } }],
};

test('rejects ok notification status when enrichment summary reports stale official data', () => {
  assert.throws(
    () => assertNotificationStatusAllowsMarketData('ok', {
      ...freshEnrichment,
      marketDataStale: 1,
      listings: [{ marketEstimate: { status: 'reliable', sourceFreshness: { transactionStale: true, doorplateStale: false } } }],
    }),
    /--status-notify warn/,
  );
});

test('rejects ok notification status when a listing has a stale official source', () => {
  assert.throws(
    () => assertNotificationStatusAllowsMarketData('ok', {
      ...freshEnrichment,
      listings: [{ marketEstimate: { status: 'reliable', sourceFreshness: { transactionStale: true, doorplateStale: false } } }],
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

test('rejects ok notification status when any listing needs market review', () => {
  assert.throws(() => assertNotificationStatusAllowsMarketData('ok', {
    ...freshEnrichment,
    marketReliable: 0,
    marketReview: 1,
    listings: [{ marketEstimate: { status: 'review', sourceFreshness: { transactionStale: false, doorplateStale: false } } }],
  }), /review or unavailable.*--status-notify warn/);
});

test('rejects ok notification status when the market bundle was unavailable', () => {
  assert.throws(() => assertNotificationStatusAllowsMarketData('ok', {
    ...freshEnrichment,
    marketReliable: 0,
    marketUnavailable: 1,
    listings: [{ marketEstimate: { status: 'unavailable', sourceFreshness: { transactionStale: false, doorplateStale: false } } }],
  }), /review or unavailable.*--status-notify warn/);
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
