/**
 * Normalize the raw rows read from a listing's inline 刊登紀錄 (`table.sub-table`)
 * into `ListingHistoryEntry[]`. Pure: the DOM reading happens in extract.ts; this
 * just drops non-date rows (header / junk) and trims. Price keeps its raw token
 * (commas and all) — parse.ts handles the number later, in enrich.
 */
import type { ListingHistoryEntry } from './types.ts';
import { isValidDateString } from './date.ts';

/** A history row as read straight from the sub-table DOM. */
export interface RawHistoryRow {
  price: string | null;
  source: string | null;
  date: string | null;
  active: boolean;
}

export function normalizeHistory(rows: RawHistoryRow[]): ListingHistoryEntry[] {
  return rows
    .filter((r) => r.date != null && isValidDateString(r.date))
    .map((r) => ({
      date: r.date as string,
      source: (r.source ?? '').trim(),
      price: r.price && r.price.trim() ? r.price.trim() : null,
      active: r.active,
    }));
}
