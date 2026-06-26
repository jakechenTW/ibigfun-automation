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

/** Nearest MRT exit by walking distance, attached during enrichment. */
export interface WalkInfo {
  stationZh: string;
  line: string;
  exitId: string;
  distanceM: number; // routed walking distance
  minutes: number; // distanceM at 80 m/min
}

/** Whether the walking-distance decision can be trusted for this listing. */
export interface Reliability {
  coordPresent: boolean;
  coordConsistent: boolean | null; // null = district unknown / no coord
  routeOk: boolean | null; // null = routing not attempted
  ratio: number | null; // routed / straight-line
  reason: string | null; // why unreliable, else null
}

/**
 * A listing plus the deterministic fields computed by scripts/enrich.ts.
 * Estimation (market price, rent) and the final recommend/exclude judgment are
 * NOT here — they stay with the agent (docs/reporting-rules.md).
 */
export interface EnrichedListing extends Listing {
  totalPriceWan: number | null;
  totalPriceNtd: number | null;
  totalPingNum: number | null;
  unitPriceWan: number | null;
  ageNum: number | null;
  monthlyMortgage: number | null;
  district: string | null;
  walk: WalkInfo | null;
  withinWalk: boolean | null; // <=10-min walk; null = data unreliable, manual review
  reliability: Reliability;
  hardExclusion: { excluded: boolean; reasons: string[] };
}

/** Output document written to state/enriched-<date>.json and stdout. */
export interface EnrichResult {
  targetDate: string;
  enrichedAt: string;
  count: number;
  withinWalkCount: number;
  manualReviewCount: number; // withinWalk === null
  hardExcludedCount: number;
  listings: EnrichedListing[];
}
