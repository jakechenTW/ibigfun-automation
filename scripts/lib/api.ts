/**
 * iBigFun JSON API contract: endpoint URLs, request body builder, response
 * types, and pagination math. The filter + source allow-list mirrors the
 * /api/search/list POST captured from the live site on 2026-06-27 (see
 * docs/fetching.md). Keep this the single source of the request shape.
 */

export const SIGNIN_URL = 'https://www.ibigfun.com/user/signin';
export const LOGIN_URL = 'https://www.ibigfun.com/user/login';
export const SEARCH_LIST_URL = 'https://www.ibigfun.com/api/search/list';
export const O2O_SAME_URL = 'https://api.ibigfun.com/on-market/o2o-same';

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

/** One cross-source posting record from on-market/o2o-same. */
export interface O2oEntry {
  source_id: string;
  link: string;
  total: number;
  add_date: string;
}

/** sourceName -> record, for a single listing id. */
export type O2oForId = Record<string, O2oEntry>;

export interface O2oResponse {
  status: string;
  data: Record<string, O2oForId>;
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

/** Build the URL-encoded /api/search/list POST body for a date + page. */
export function buildSearchBody(date: string, page = 1): string {
  const p = new URLSearchParams();
  p.set('page', String(page));
  p.set('expand', '0');
  p.set('method', 'all_case');
  p.set('on_market', '1');
  p.set('city', '1');
  p.set('price_segment[min_val]', '');
  p.set('price_segment[max_val]', '2500');
  p.set('floor_segment[min_val]', '2');
  p.set('floor_segment[max_val]', '4');
  p.set('total_floor[min_val]', '');
  p.set('total_floor[max_val]', '5');
  p.set('add_date', date);
  p.set('add_date_max', date);
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
