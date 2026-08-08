import { validateValuationReview, validateValuationReviewAgainstEnriched } from './valuation-review.ts';

export type NotificationStatus = 'ok' | 'warn' | 'fail';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Rejects legacy enrichment so every completed report has tenure evidence. */
export function assertValidTenureGates(enriched: unknown): void {
  const result = record(enriched);
  if (!result || !Array.isArray(result.listings)) {
    throw new Error('rerun enrich: a listings array and tenure summary counts are required');
  }

  const summaryKeys = ['tenureEligible', 'tenureExpired', 'tenureReview'] as const;
  if (summaryKeys.some((key) => typeof result[key] !== 'number' ||
    !Number.isSafeInteger(result[key]) || (result[key] as number) < 0)) {
    throw new Error('rerun enrich: non-negative integer tenure summary counts are required');
  }

  const actual = { tenureEligible: 0, tenureExpired: 0, tenureReview: 0 };
  for (const listing of result.listings) {
    const gate = record(listing)?.tenureGate;
    if (gate !== 'eligible' && gate !== 'expired' && gate !== 'review') {
      throw new Error('rerun enrich: every listing requires a valid tenureGate');
    }
    actual[gate === 'eligible' ? 'tenureEligible' : gate === 'expired' ? 'tenureExpired' : 'tenureReview'] += 1;
  }
  if (summaryKeys.some((key) => result[key] !== actual[key])) {
    throw new Error('tenure summary counts must match listings');
  }
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
  if (status !== 'ok') return;
  if (enriched === undefined) throw new Error('enriched artifact is required for --status-notify ok');
  const result = record(enriched);
  if (!result || !Array.isArray(result.listings)) {
    throw new Error('a valid enriched artifact is required for --status-notify ok');
  }
  const summaryKeys = ['marketReliable', 'marketReview', 'marketUnavailable', 'marketDataStale'] as const;
  const summary = Object.fromEntries(summaryKeys.map((key) => [key, result[key]])) as Record<typeof summaryKeys[number], unknown>;
  if (summaryKeys.some((key) => typeof summary[key] !== 'number' || !Number.isSafeInteger(summary[key]) || (summary[key] as number) < 0)) {
    throw new Error('a valid enriched artifact with non-negative integer market summary fields is required for --status-notify ok');
  }

  const actual = { marketReliable: 0, marketReview: 0, marketUnavailable: 0, marketDataStale: 0 };
  for (const listing of result.listings) {
    const estimate = record(record(listing)?.marketEstimate);
    const freshness = record(estimate?.sourceFreshness);
    const estimateStatus = estimate?.status;
    if ((estimateStatus !== 'reliable' && estimateStatus !== 'review' && estimateStatus !== 'unavailable') ||
      typeof freshness?.transactionStale !== 'boolean' || typeof freshness.doorplateStale !== 'boolean') {
      throw new Error('a valid enriched artifact with listing market status and freshness is required for --status-notify ok');
    }
    actual[estimateStatus === 'reliable' ? 'marketReliable' : estimateStatus === 'review' ? 'marketReview' : 'marketUnavailable'] += 1;
    if (freshness.transactionStale || freshness.doorplateStale) actual.marketDataStale += 1;
  }
  if (summaryKeys.some((key) => summary[key] !== actual[key])) {
    throw new Error('market summary counts must match listings before --status-notify ok');
  }
  if (actual.marketDataStale > 0) {
    throw new Error('stale official market data requires --status-notify warn, not ok');
  }
}

/** Validates optional review evidence for every status, then applies the ok-only market gate. */
export function validateReportEvidence(
  status: NotificationStatus,
  enriched: unknown,
  valuationReview?: unknown,
): void {
  assertValidTenureGates(enriched);
  if (valuationReview !== undefined) {
    const reviewFile = validateValuationReview(valuationReview);
    validateValuationReviewAgainstEnriched(reviewFile, enriched);
  }
  assertNotificationStatusAllowsMarketData(status, enriched);
}
