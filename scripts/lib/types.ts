import type { Coordinate } from './coords.ts';

/**
 * A normalized iBigFun listing. Fields mirror the "Fields To Extract Per
 * Listing" list in docs/fetching.md. Values are kept as the scraped display
 * text (trimmed) rather than parsed numbers — downstream evaluation parses
 * them — except `coordinate`, which is structured for MRT-distance math.
 * Any field that could not be found is `null`.
 */
export interface Listing {
  title: string;
  url: string | null;
  addressOrArea: string | null;
  coordinate: Coordinate | null;
  publishedDate: string | null;
  totalPrice: string | null;
  totalPing: string | null;
  unitPrice: string | null;
  floor: string | null;
  totalFloors: string | null;
  typeLayout: string | null;
  age: string | null;
  parking: string | null;
  realPriceUrl: string | null;
}

/** Output document written to state/listings-<date>.json and stdout. */
export interface FetchResult {
  targetDate: string;
  fetchedAt: string;
  count: number;
  listings: Listing[];
}
