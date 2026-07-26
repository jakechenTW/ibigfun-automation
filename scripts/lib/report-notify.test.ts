import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNotificationStatusAllowsMarketData } from './report-notify.ts';

const freshEnrichment = {
  marketDataStale: 0,
  listings: [{ marketEstimate: { sourceFreshness: { transactionStale: false, doorplateStale: false } } }],
};

test('rejects ok notification status when enrichment summary reports stale official data', () => {
  assert.throws(
    () => assertNotificationStatusAllowsMarketData('ok', { ...freshEnrichment, marketDataStale: 1 }),
    /--status-notify warn/,
  );
});

test('rejects ok notification status when a listing has a stale official source', () => {
  assert.throws(
    () => assertNotificationStatusAllowsMarketData('ok', {
      ...freshEnrichment,
      listings: [{ marketEstimate: { sourceFreshness: { transactionStale: true, doorplateStale: false } } }],
    }),
    /--status-notify warn/,
  );
});

test('allows warn status for stale data and ok status for fresh data', () => {
  assert.doesNotThrow(() => assertNotificationStatusAllowsMarketData('warn', { ...freshEnrichment, marketDataStale: 1 }));
  assert.doesNotThrow(() => assertNotificationStatusAllowsMarketData('ok', freshEnrichment));
});
