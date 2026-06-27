import type { Coordinate } from './coords.ts';

/** One row of iBigFun's 刊登紀錄: this property's appearance on one source/date. */
export interface ListingHistoryEntry {
  date: string; // "2026-06-05"
  source: string; // "樂屋網" | "591" | …; "" when blank
  price: string | null; // raw token, e.g. "1588" / "1,588"; null when absent
  active: boolean; // false = a (下架) record
}

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
  /** Nearest-MRT text the listing itself shows, e.g. "植物園站(施工中)". */
  nearbyStation: string | null;
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
  /** Cross-source posting history from iBigFun's 刊登紀錄 (incl. delisted); [] if none. */
  listingHistory: ListingHistoryEntry[];
  /** Stable iBigFun listing id (path key for /on-market/{id}/history); null if absent. */
  id: number | null;
  /** Origin platform label, e.g. "樂屋"; null if absent. */
  source: string | null;
  /** Canonical source-site URL for the listing (same value as `url`). */
  sourceLink: string | null;
  /** Room counts parsed by iBigFun; null if absent. */
  room: number | null;
  livingRoom: number | null;
  bathroom: number | null;
}

/** Output document written to state/listings-<label>.json and stdout. */
export interface FetchResult {
  from: string;
  to: string;
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

/** Deterministic "how long on market" summary derived from `listingHistory`. */
export interface ListingTenure {
  firstListedDate: string | null; // earliest date across all records (incl. 下架)
  daysOnMarket: number | null; // anchorDate − firstListedDate; null if no history / bad date
  recordCount: number; // total history rows
  sourceCount: number; // distinct non-empty sources
  priceTrend: 'flat' | 'dropped' | 'raised' | 'unknown';
  firstPrice: number | null; // earliest record's price (萬)
  latestPrice: number | null; // latest record's price (萬)
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
  /** Advisory signals for agent judgment (do NOT auto-exclude). */
  signals: { auctionKeyword: boolean };
  hardExclusion: { excluded: boolean; reasons: string[] };
  tenure: ListingTenure;
}

/** Output document written to state/enriched-<label>.json and stdout. */
export interface EnrichResult {
  from: string;
  to: string;
  enrichedAt: string;
  count: number;
  withinWalkCount: number;
  manualReviewCount: number; // withinWalk === null
  hardExcludedCount: number;
  listings: EnrichedListing[];
}
