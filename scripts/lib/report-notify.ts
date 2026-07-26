export type NotificationStatus = 'ok' | 'warn' | 'fail';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Reads both the persisted summary and per-listing source flags defensively. */
export function hasStaleOfficialMarketData(enriched: unknown): boolean {
  const result = record(enriched);
  if (!result) return false;
  if (typeof result.marketDataStale === 'number' && result.marketDataStale > 0) return true;
  if (!Array.isArray(result.listings)) return false;
  return result.listings.some((listing) => {
    const estimate = record(record(listing)?.marketEstimate);
    const freshness = record(estimate?.sourceFreshness);
    return freshness?.transactionStale === true || freshness?.doorplateStale === true;
  });
}

/** Policy gate: stale official sources must be surfaced to the recipient as warn. */
export function assertNotificationStatusAllowsMarketData(status: NotificationStatus, enriched: unknown): void {
  if (status === 'ok' && hasStaleOfficialMarketData(enriched)) {
    throw new Error('stale official market data requires --status-notify warn, not ok');
  }
}
