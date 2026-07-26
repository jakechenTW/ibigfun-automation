/**
 * Collect the filtered target-date listings from iBigFun's JSON APIs (no
 * browser). Paginates /api/search/list, then for each listing fetches its
 * on-market history (/on-market/{id}/history) and off-market history
 * (query_off_market_by_id) through a small concurrency pool with retry. A
 * listing whose history can't be fetched (or whose on-market history is empty
 * for a live listing) is kept with empty history and warned about — never
 * dropped silently. HTTP deps are injected so this is unit-tested offline.
 */
import type { Listing } from './types.ts';
import { MAX_PAGES, HISTORY_CONCURRENCY } from './config.ts';
import { pageCount, fetchVariants as variantsForFetch, type FetchMap, type SearchListResponse, type ListItem, type HistoryEntry, type OffMarketEntry } from './api.ts';
import { apiItemToListing, onMarketToRows, offMarketToRows, mergeHistory } from './map.ts';
import { defaultDeps } from './http.ts';
import { consoleLogger, type Logger } from './journal.ts';

export interface CollectDeps {
  ensureSession: () => Promise<void>;
  fetchPage: (from: string, to: string, page: number) => Promise<SearchListResponse>;
  fetchOnMarketHistory: (id: number) => Promise<HistoryEntry[]>;
  fetchOffMarketHistory: (uuid: string) => Promise<OffMarketEntry[]>;
}

export type CollectResult = { listings: Listing[]; dropped: number; duplicates: number };
export { variantsForFetch as fetchVariants };

/** Merge separately queried house-type variants by stable listing id. */
export function mergeVariantListings(
  variants: Array<{ queryHouseType: string | null; listings: Listing[] }>,
  logger?: Logger,
): { listings: Listing[]; duplicates: number; provenanceConflicts: number } {
  const listings: Listing[] = [];
  const byId = new Map<number, number>();
  let duplicates = 0;
  let provenanceConflicts = 0;

  for (const variant of variants) {
    for (const listing of variant.listings) {
      if (listing.id == null) {
        listings.push(listing);
        continue;
      }
      const priorIndex = byId.get(listing.id);
      if (priorIndex === undefined) {
        byId.set(listing.id, listings.length);
        listings.push(listing);
        continue;
      }

      duplicates++;
      const prior = listings[priorIndex];
      if (prior.queryHouseType === listing.queryHouseType) continue;

      provenanceConflicts++;
      listings[priorIndex] = { ...prior, queryHouseType: null, buildingType: null };
      logger?.event('warn', 'fetch.provenance-conflict',
        `listing ${listing.id} returned by conflicting house_type queries; building type cleared`,
        { listingId: listing.id, firstQueryHouseType: prior.queryHouseType, duplicateQueryHouseType: listing.queryHouseType });
    }
  }
  return { listings, duplicates, provenanceConflicts };
}

/** Run worker over items with at most `limit` in flight; preserves input order. */
async function runPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function runner(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => runner());
  await Promise.all(runners);
  return results;
}

export async function collectListings(
  range: { from: string; to: string },
  deps: CollectDeps = defaultDeps(),
  logger: Logger = consoleLogger('fetch'),
  queryHouseType: string | null = null,
): Promise<CollectResult> {
  await deps.ensureSession();

  // 1) Gather all listing rows across pages, deduping repeated ids (keep first).
  const first = await deps.fetchPage(range.from, range.to, 1);
  const pages = Math.min(pageCount(first.total_records, first.per_page), MAX_PAGES);
  const items: ListItem[] = [];
  const seen = new Set<number>();
  let duplicates = 0;
  for (let p = 1; p <= Math.max(pages, 1); p++) {
    const res = p === 1 ? first : await deps.fetchPage(range.from, range.to, p);
    if (!res.data || res.data.length === 0) break;
    for (const it of res.data) {
      if (seen.has(it.id)) { duplicates++; continue; }
      seen.add(it.id);
      items.push(it);
    }
  }
  if (duplicates > 0) {
    logger.event('info', 'fetch.dedup',
      `dropped ${duplicates} duplicate listing id(s) within range`, { duplicates });
  }

  // 2) Fetch per-listing history through a small pool; skip+warn on failure.
  let dropped = 0;
  const listings = await runPool(items, HISTORY_CONCURRENCY, async (it) => {
    let on: HistoryEntry[];
    try {
      on = await deps.fetchOnMarketHistory(it.id);
    } catch (e) {
      logger.event('warn', 'history.drop',
        `listing ${it.id} on-market fetch failed after retries; dropping history`,
        { listingId: it.id, reason: (e as Error).message, phase: 'on-market' });
      dropped++;
      return apiItemToListing(it, [], queryHouseType);
    }
    if (on.length === 0) {
      logger.event('warn', 'history.drop',
        `listing ${it.id} returned no on-market records (likely throttled); dropping history`,
        { listingId: it.id, reason: 'empty on-market', phase: 'on-market' });
      dropped++;
      return apiItemToListing(it, [], queryHouseType);
    }
    let off: OffMarketEntry[] = [];
    try {
      off = await deps.fetchOffMarketHistory(it.uuid);
    } catch (e) {
      logger.event('warn', 'history.off-market-skip',
        `listing ${it.id} off-market fetch failed after retries; keeping on-market only`,
        { listingId: it.id, reason: (e as Error).message, phase: 'off-market' });
    }
    return apiItemToListing(it, mergeHistory(onMarketToRows(on), offMarketToRows(off)), queryHouseType);
  });

  logger.event('info', 'history.summary',
    `${items.length - dropped} listings ok, ${dropped} dropped`,
    { ok: items.length - dropped, dropped });
  return { listings, dropped, duplicates };
}

/** Collect every required house-type variant and merge their stable IDs. */
export async function collectListingVariants(
  range: { from: string; to: string },
  fetch: FetchMap,
  depsForVariant: (filters: FetchMap) => CollectDeps = defaultDeps,
  logger: Logger = consoleLogger('fetch'),
): Promise<CollectResult & { provenanceConflicts: number }> {
  const collected: Array<{ queryHouseType: string | null; listings: Listing[] }> = [];
  let dropped = 0;
  let withinVariantDuplicates = 0;

  for (const variant of variantsForFetch(fetch)) {
    const result = await collectListings(range, depsForVariant(variant.filters), logger, variant.queryHouseType);
    collected.push({ queryHouseType: variant.queryHouseType, listings: result.listings });
    dropped += result.dropped;
    withinVariantDuplicates += result.duplicates;
  }

  const merged = mergeVariantListings(collected, logger);
  if (merged.duplicates > 0) {
    logger.event('info', 'fetch.variant-dedup',
      `dropped ${merged.duplicates} duplicate listing id(s) across house_type queries`,
      { duplicates: merged.duplicates, provenanceConflicts: merged.provenanceConflicts });
  }
  return {
    listings: merged.listings,
    dropped,
    duplicates: withinVariantDuplicates + merged.duplicates,
    provenanceConflicts: merged.provenanceConflicts,
  };
}
