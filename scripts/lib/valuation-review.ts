/**
 * Auditable record for the small number of external valuation checks that can
 * affect a report bucket. Official marketEstimate values remain in enriched
 * output; this file records the independent review rather than overwriting it.
 */
export type ValuationReviewBucket = 'recommended' | 'near-threshold' | 'suspicious' | 'excluded';

export interface ValuationReview {
  listingId: number;
  source: string;
  sourceUrl: string;
  checkedAt: string;
  externalUnitPriceWan: number;
  externalTotalPriceWan: number;
  officialMedianWan: number;
  officialP25Wan: number;
  officialP75Wan: number;
  differencePercent: number;
  accepted: boolean;
  rationale: string;
  resultingBucket: ValuationReviewBucket;
}

export interface ValuationReviewFile {
  schemaVersion: 1;
  reviews: ValuationReview[];
}

const BUCKETS = new Set<ValuationReviewBucket>(['recommended', 'near-threshold', 'suspicious', 'excluded']);
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?Z$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a nonempty string`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
  return value;
}

function positive(value: unknown, label: string): number {
  const number = finite(value, label);
  if (number <= 0) throw new RangeError(`${label} must be greater than zero`);
  return number;
}

function sourceUrl(value: unknown): string {
  const url = text(value, 'sourceUrl');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TypeError();
  } catch {
    throw new TypeError('sourceUrl must be an HTTP(S) URL');
  }
  return url;
}

function checkedAt(value: unknown): string {
  const timestamp = text(value, 'checkedAt');
  const parts = ISO_TIMESTAMP.exec(timestamp);
  const parsed = new Date(timestamp);
  if (!parts || Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(parts[1]) ||
    parsed.getUTCMonth() + 1 !== Number(parts[2]) ||
    parsed.getUTCDate() !== Number(parts[3]) ||
    parsed.getUTCHours() !== Number(parts[4]) ||
    parsed.getUTCMinutes() !== Number(parts[5]) ||
    parsed.getUTCSeconds() !== Number(parts[6])) {
    throw new TypeError('checkedAt must be an ISO-8601 UTC timestamp');
  }
  return timestamp;
}

function review(value: unknown, index: number): ValuationReview {
  const entry = record(value, `reviews[${index}]`);
  const listingId = finite(entry.listingId, `reviews[${index}].listingId`);
  if (!Number.isSafeInteger(listingId) || listingId <= 0) {
    throw new RangeError(`reviews[${index}].listingId must be a positive safe integer`);
  }
  const officialP25Wan = positive(entry.officialP25Wan, `reviews[${index}].officialP25Wan`);
  const officialMedianWan = positive(entry.officialMedianWan, `reviews[${index}].officialMedianWan`);
  const officialP75Wan = positive(entry.officialP75Wan, `reviews[${index}].officialP75Wan`);
  if (officialP25Wan > officialMedianWan || officialMedianWan > officialP75Wan) {
    throw new RangeError(`reviews[${index}] official P25/median/P75 must be ordered`);
  }
  if (typeof entry.accepted !== 'boolean') throw new TypeError(`reviews[${index}].accepted must be boolean`);
  if (typeof entry.resultingBucket !== 'string' || !BUCKETS.has(entry.resultingBucket as ValuationReviewBucket)) {
    throw new TypeError(`reviews[${index}].resultingBucket must be one of ${[...BUCKETS].join('|')}`);
  }
  return {
    listingId,
    source: text(entry.source, `reviews[${index}].source`),
    sourceUrl: sourceUrl(entry.sourceUrl),
    checkedAt: checkedAt(entry.checkedAt),
    externalUnitPriceWan: positive(entry.externalUnitPriceWan, `reviews[${index}].externalUnitPriceWan`),
    externalTotalPriceWan: positive(entry.externalTotalPriceWan, `reviews[${index}].externalTotalPriceWan`),
    officialMedianWan,
    officialP25Wan,
    officialP75Wan,
    differencePercent: finite(entry.differencePercent, `reviews[${index}].differencePercent`),
    accepted: entry.accepted,
    rationale: text(entry.rationale, `reviews[${index}].rationale`),
    resultingBucket: entry.resultingBucket as ValuationReviewBucket,
  };
}

/** Rejects malformed or silent external overrides before a report can be marked complete. */
export function validateValuationReview(value: unknown): ValuationReviewFile {
  const file = record(value, 'valuation review');
  if (file.schemaVersion !== 1) throw new TypeError('schemaVersion must be 1');
  if (!Array.isArray(file.reviews)) throw new TypeError('reviews must be an array');
  return { schemaVersion: 1, reviews: file.reviews.map(review) };
}
