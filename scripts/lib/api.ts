/**
 * iBigFun JSON API contract: endpoint URLs, request body builder, response
 * types, and pagination math. The filter + source allow-list mirrors the
 * /api/search/list POST captured from the live site on 2026-06-27 (see
 * docs/fetching.md). Keep this the single source of the request shape.
 */

export const SIGNIN_URL = 'https://www.ibigfun.com/user/signin';
export const LOGIN_URL = 'https://www.ibigfun.com/user/login';
export const SEARCH_LIST_URL = 'https://www.ibigfun.com/api/search/list';
/** On-market cross-source posting history for one listing (id in the path). */
export function historyUrl(id: number): string {
  return `https://api.ibigfun.com/on-market/${id}/history`;
}

/** Off-market (下架) posting history endpoint; body is id_encode=<uuid>. */
export const OFF_MARKET_URL = 'https://www.ibigfun.com/api/query_off_market_by_id';

/** Build the URL-encoded query_off_market_by_id POST body for a listing uuid. */
export function buildOffMarketBody(uuid: string): string {
  const p = new URLSearchParams();
  p.set('id_encode', uuid);
  return p.toString();
}

/** One listing as returned by /api/search/list (fields we consume). */
export interface ListItem {
  id: number;
  subject: string;
  source: string | number;
  link: string;
  address: string;
  mrt: string;
  lat: number;
  lng: number;
  add_time: string;
  total: number;
  price_ave: number;
  total_ping: number;
  floor: number;
  total_floor: number;
  pattern: string;
  house_age_x: number | null;
  parking_type: string;
  room: number;
  living_room: number;
  bathroom: number;
  id_encode: string;
  uuid: string;
}

export interface SearchListResponse {
  status: string;
  msg: string;
  total_records: number;
  per_page: number;
  current_page: number;
  data: ListItem[];
}

/** One on-market posting from /on-market/{id}/history. `total` is a number. */
export interface HistoryEntry {
  source: string;
  source_id: string;
  total: number;
  subject: string;
  add_time: string;
  link: string;
}

export interface HistoryResponse {
  status: string;
  data: HistoryEntry[];
}

/** One off-market (下架) posting. `total` is a comma string here, e.g. "1,234". */
export interface OffMarketEntry {
  source: string;
  source_id: string;
  total: string | number;
  subject: string;
  add_time: string;
  link: string;
}

export interface OffMarketResponse {
  status: string;
  msg: string;
  total_records: number;
  data: OffMarketEntry[];
}

/** Captured allow-lists (2026-06-27). Re-confirm if iBigFun changes sources. */
const SOURCE_WEB = ['370', '462', '371'];
const SOURCE = [
  '372', '373', '592', '382', '383', '384', '465', '381', '380', '374', '375',
  '376', '377', '378', '379', '463', '464', '478', '579', '590',
];

/** A profile's fetch map. Keys are /api/search/list param names. */
export type FetchValue =
  | string
  | number
  | string[]
  | { min?: string | number; max?: string | number };
export type FetchMap = Record<string, FetchValue>;

/** Build the URL-encoded /api/search/list POST body for a date range + page.
 *  Fixed envelope (method/on_market/expand/exclude_land/source allow-lists/
 *  dates) is the API contract; `fetchMap` supplies the variable filters:
 *   - scalar            → key=value
 *   - { min, max }      → key[min_val]=<min|""> & key[max_val]=<max|"">
 *   - array             → key[]=v (repeated)
 */
export function buildSearchBody(from: string, to: string, page = 1, fetchMap: FetchMap = {}): string {
  const p = new URLSearchParams();
  p.set('page', String(page));
  p.set('expand', '0');
  p.set('method', 'all_case');
  p.set('on_market', '1');
  for (const [key, val] of Object.entries(fetchMap)) {
    if (Array.isArray(val)) {
      for (const item of val) p.append(`${key}[]`, String(item));
    } else if (val !== null && typeof val === 'object') {
      p.set(`${key}[min_val]`, val.min == null ? '' : String(val.min));
      p.set(`${key}[max_val]`, val.max == null ? '' : String(val.max));
    } else {
      p.set(key, String(val));
    }
  }
  p.set('add_date', from);
  p.set('add_date_max', to);
  for (const s of SOURCE_WEB) p.append('source_web[]', s);
  for (const s of SOURCE) p.append('source[]', s);
  p.set('exclude_land', '1');
  return p.toString();
}

/** Number of result pages for a total at `perPage` per page. */
export function pageCount(total: number, perPage: number): number {
  if (!perPage || perPage <= 0) return 0;
  return Math.ceil((total || 0) / perPage);
}
