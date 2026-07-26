/**
 * Auditable record for the small number of external valuation checks that can
 * affect a report bucket. Official marketEstimate values remain in enriched
 * output; this file records the independent review rather than overwriting it.
 */
export type ValuationReviewBucket = 'recommended' | 'near-threshold' | 'suspicious' | 'excluded';
export type OfficialValuationStatus = 'reliable' | 'review' | 'unavailable';

export interface ValuationReview {
  listingId: number;
  source: string;
  sourceUrl: string;
  checkedAt: string;
  externalUnitPriceWan: number | null;
  externalTotalPriceWan: number | null;
  officialStatus: OfficialValuationStatus;
  officialUnavailableReasons: string[];
  officialMedianWan: number | null;
  officialP25Wan: number | null;
  officialP75Wan: number | null;
  differencePercent: number | null;
  accepted: boolean;
  rationale: string;
  resultingBucket: ValuationReviewBucket;
}

export interface ValuationReviewFile {
  schemaVersion: 1;
  reviews: ValuationReview[];
}

const BUCKETS = new Set<ValuationReviewBucket>(['recommended', 'near-threshold', 'suspicious', 'excluded']);
const OFFICIAL_STATUSES = new Set<OfficialValuationStatus>(['reliable', 'review', 'unavailable']);
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

function optionalPositive(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : positive(value, label);
}

function optionalFinite(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : finite(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((item, itemIndex) => text(item, `${label}[${itemIndex}]`));
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
  const externalUnitPriceWan = optionalPositive(entry.externalUnitPriceWan, `reviews[${index}].externalUnitPriceWan`);
  const externalTotalPriceWan = optionalPositive(entry.externalTotalPriceWan, `reviews[${index}].externalTotalPriceWan`);
  const officialP25Wan = optionalPositive(entry.officialP25Wan, `reviews[${index}].officialP25Wan`);
  const officialMedianWan = optionalPositive(entry.officialMedianWan, `reviews[${index}].officialMedianWan`);
  const officialP75Wan = optionalPositive(entry.officialP75Wan, `reviews[${index}].officialP75Wan`);
  const differencePercent = optionalFinite(entry.differencePercent, `reviews[${index}].differencePercent`);
  if ((externalUnitPriceWan === null || officialMedianWan === null) && differencePercent !== null) {
    throw new RangeError(`reviews[${index}].differencePercent requires externalUnitPriceWan and officialMedianWan`);
  }
  if (externalUnitPriceWan !== null && officialMedianWan !== null && differencePercent === null) {
    throw new RangeError(`reviews[${index}].differencePercent is required when both unit-price inputs are available`);
  }
  if (officialP25Wan !== null && officialMedianWan !== null && officialP75Wan !== null &&
    (officialP25Wan > officialMedianWan || officialMedianWan > officialP75Wan)) {
    throw new RangeError(`reviews[${index}] official P25/median/P75 must be ordered`);
  }
  if (typeof entry.accepted !== 'boolean') throw new TypeError(`reviews[${index}].accepted must be boolean`);
  if (entry.accepted && externalUnitPriceWan === null && externalTotalPriceWan === null) {
    throw new RangeError(`reviews[${index}] cannot be accepted without an external price`);
  }
  if (typeof entry.officialStatus !== 'string' || !OFFICIAL_STATUSES.has(entry.officialStatus as OfficialValuationStatus)) {
    throw new TypeError(`reviews[${index}].officialStatus must be one of ${[...OFFICIAL_STATUSES].join('|')}`);
  }
  const officialStatus = entry.officialStatus as OfficialValuationStatus;
  const officialUnavailableReasons = stringArray(entry.officialUnavailableReasons, `reviews[${index}].officialUnavailableReasons`);
  if (officialStatus === 'reliable' &&
    (officialP25Wan === null || officialMedianWan === null || officialP75Wan === null || officialUnavailableReasons.length > 0)) {
    throw new RangeError(`reviews[${index}] reliable official evidence requires a complete interval and no unavailable reasons`);
  }
  if (officialStatus !== 'reliable' && officialUnavailableReasons.length === 0) {
    throw new RangeError(`reviews[${index}] ${officialStatus} official evidence requires unavailable reasons`);
  }
  if (officialStatus === 'unavailable' &&
    (officialP25Wan !== null || officialMedianWan !== null || officialP75Wan !== null)) {
    throw new RangeError(`reviews[${index}] unavailable official evidence cannot contain official prices`);
  }
  if (typeof entry.resultingBucket !== 'string' || !BUCKETS.has(entry.resultingBucket as ValuationReviewBucket)) {
    throw new TypeError(`reviews[${index}].resultingBucket must be one of ${[...BUCKETS].join('|')}`);
  }
  const resultingBucket = entry.resultingBucket as ValuationReviewBucket;
  if (officialStatus !== 'reliable' && resultingBucket === 'recommended') {
    throw new RangeError(`reviews[${index}] ${officialStatus} official evidence cannot result in recommended`);
  }
  return {
    listingId,
    source: text(entry.source, `reviews[${index}].source`),
    sourceUrl: sourceUrl(entry.sourceUrl),
    checkedAt: checkedAt(entry.checkedAt),
    externalUnitPriceWan,
    externalTotalPriceWan,
    officialStatus,
    officialUnavailableReasons,
    officialMedianWan,
    officialP25Wan,
    officialP75Wan,
    differencePercent,
    accepted: entry.accepted,
    rationale: text(entry.rationale, `reviews[${index}].rationale`),
    resultingBucket,
  };
}

/** Rejects malformed or silent external overrides before a report can be marked complete. */
export function validateValuationReview(value: unknown): ValuationReviewFile {
  const file = record(value, 'valuation review');
  if (file.schemaVersion !== 1) throw new TypeError('schemaVersion must be 1');
  if (!Array.isArray(file.reviews)) throw new TypeError('reviews must be an array');
  if (file.reviews.length === 0) throw new RangeError('reviews must contain at least one review');
  return { schemaVersion: 1, reviews: file.reviews.map(review) };
}
