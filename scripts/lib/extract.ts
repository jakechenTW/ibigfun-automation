/**
 * Collect the filtered target-date listings from iBigFun's JSON APIs (no
 * browser). Paginates /api/search/list by total_records/per_page, fetches the
 * cross-source history per page, and maps each item to a Listing. The HTTP
 * deps are injected so the pagination logic is unit-tested without network.
 */
import type { Listing } from './types.ts';
import { MAX_PAGES } from './config.ts';
import { pageCount, type SearchListResponse, type O2oResponse } from './api.ts';
import { apiItemToListing } from './map.ts';
import { defaultDeps } from './http.ts';

export interface CollectDeps {
  ensureSession: () => Promise<void>;
  fetchPage: (date: string, page: number) => Promise<SearchListResponse>;
  fetchHistory: (ids: number[]) => Promise<O2oResponse['data']>;
}

export async function collectListings(date: string, deps: CollectDeps = defaultDeps()): Promise<Listing[]> {
  await deps.ensureSession();

  const first = await deps.fetchPage(date, 1);
  const pages = Math.min(pageCount(first.total_records, first.per_page), MAX_PAGES);
  const all: Listing[] = [];

  for (let p = 1; p <= Math.max(pages, 1); p++) {
    const res = p === 1 ? first : await deps.fetchPage(date, p);
    if (!res.data || res.data.length === 0) break;
    const ids = res.data.map((it) => it.id);
    const history = await deps.fetchHistory(ids);
    for (const it of res.data) {
      all.push(apiItemToListing(it, history[String(it.id)] ?? {}));
    }
  }
  return all;
}
