/**
 * Builds the iBigFun filtered latest-sale URL for a target date.
 *
 * The base URL and filter params mirror the documented query in
 * docs/fetching.md. Keep this the single source of the filter set so the
 * scraper and the docs cannot drift.
 */

const BASE_URL = 'https://www.ibigfun.com/lists/latest';

/** Documented filter params, in the documented order. */
const FILTERS: Record<string, string> = {
  page: '1',
  expand: '0',
  method: 'all_case',
  on_market: '1',
  city: '1',
  price_segment: ',2500',
  floor_segment: '2,4',
  total_floor: ',5',
};

/**
 * Filtered list URL for `date` (YYYY-MM-DD), with both add_date params set to
 * the target date and an optional 1-based `page`.
 */
export function buildListUrl(date: string, page = 1): string {
  const params = new URLSearchParams({
    ...FILTERS,
    page: String(page),
    add_date: date,
    add_date_max: date,
  });
  return `${BASE_URL}?${params.toString()}`;
}
