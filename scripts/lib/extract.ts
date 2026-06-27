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
import { pageCount, type SearchListResponse, type ListItem, type HistoryEntry, type OffMarketEntry } from './api.ts';
import { apiItemToListing, onMarketToRows, offMarketToRows, mergeHistory } from './map.ts';
import { defaultDeps } from './http.ts';

export interface CollectDeps {
  ensureSession: () => Promise<void>;
  fetchPage: (date: string, page: number) => Promise<SearchListResponse>;
  fetchOnMarketHistory: (id: number) => Promise<HistoryEntry[]>;
  fetchOffMarketHistory: (uuid: string) => Promise<OffMarketEntry[]>;
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

export async function collectListings(date: string, deps: CollectDeps = defaultDeps()): Promise<Listing[]> {
  await deps.ensureSession();

  // 1) Gather all listing rows across pages.
  const first = await deps.fetchPage(date, 1);
  const pages = Math.min(pageCount(first.total_records, first.per_page), MAX_PAGES);
  const items: ListItem[] = [];
  for (let p = 1; p <= Math.max(pages, 1); p++) {
    const res = p === 1 ? first : await deps.fetchPage(date, p);
    if (!res.data || res.data.length === 0) break;
    items.push(...res.data);
  }

  // 2) Fetch per-listing history through a small pool; skip+warn on failure.
  let dropped = 0;
  const listings = await runPool(items, HISTORY_CONCURRENCY, async (it) => {
    let on: HistoryEntry[];
    try {
      on = await deps.fetchOnMarketHistory(it.id);
    } catch (e) {
      console.error(`WARN history: listing ${it.id} on-market fetch failed after retries (${(e as Error).message}); dropping history`);
      dropped++;
      return apiItemToListing(it, []);
    }
    if (on.length === 0) {
      // A live listing always has >=1 on-market source; empty == suspicious.
      console.error(`WARN history: listing ${it.id} returned no on-market records (likely throttled); dropping history`);
      dropped++;
      return apiItemToListing(it, []);
    }
    let off: OffMarketEntry[] = [];
    try {
      off = await deps.fetchOffMarketHistory(it.uuid);
    } catch (e) {
      console.error(`WARN history: listing ${it.id} off-market fetch failed after retries (${(e as Error).message}); keeping on-market only`);
    }
    return apiItemToListing(it, mergeHistory(onMarketToRows(on), offMarketToRows(off)));
  });

  console.error(`history: ${items.length - dropped} listings ok, ${dropped} dropped (see WARN above)`);
  return listings;
}
