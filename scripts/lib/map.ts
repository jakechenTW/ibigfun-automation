/**
 * Pure mapping from iBigFun's /api/search/list JSON into the normalized
 * `Listing`. Values stay as display strings (downstream enrich parses numbers)
 * except `coordinate`. No network, no DOM — unit-tested.
 */
import type { ListItem, HistoryEntry, OffMarketEntry } from './api.ts';
import type { Coordinate } from './coords.ts';
import type { Listing, ListingHistoryEntry } from './types.ts';
import { normalizeHistory, type RawHistoryRow } from './history.ts';

/** Stringify a numeric field, or null when it is null/undefined. */
function numStr(n: number | null | undefined): string | null {
  return n === null || n === undefined ? null : String(n);
}

/** A listing `total` (number on-market, comma-string off-market) as a raw price token. */
function totalToPrice(total: string | number | null | undefined): string | null {
  return total === null || total === undefined ? null : String(total);
}

/** On-market /history entries → raw rows (all active). */
export function onMarketToRows(entries: HistoryEntry[]): RawHistoryRow[] {
  return entries.map((e) => ({
    price: totalToPrice(e.total),
    source: e.source ?? '',
    date: e.add_time ?? null,
    active: true,
  }));
}

/** Off-market (下架) entries → raw rows (all inactive). */
export function offMarketToRows(entries: OffMarketEntry[]): RawHistoryRow[] {
  return entries.map((e) => ({
    price: totalToPrice(e.total),
    source: e.source ?? '',
    date: e.add_time ?? null,
    active: false,
  }));
}

/** Merge on+off raw rows, dedupe by source|date|active, then normalize. */
export function mergeHistory(onRows: RawHistoryRow[], offRows: RawHistoryRow[]): ListingHistoryEntry[] {
  const seen = new Set<string>();
  const merged: RawHistoryRow[] = [];
  for (const r of [...onRows, ...offRows]) {
    const key = `${r.source}|${r.date}|${r.active}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(r);
  }
  return normalizeHistory(merged);
}

/** Build a Coordinate from lat/lng when both are finite, else null. */
function coordinateOf(it: ListItem): Coordinate | null {
  if (Number.isFinite(it.lat) && Number.isFinite(it.lng) && (it.lat !== 0 || it.lng !== 0)) {
    return { lat: it.lat, lng: it.lng };
  }
  return null;
}

/** Map one API item (+ its already-merged history) to a Listing. */
export function apiItemToListing(it: ListItem, history: ListingHistoryEntry[]): Listing {
  return {
    title: it.subject ?? '',
    url: it.link || null,
    addressOrArea: it.address || null,
    nearbyStation: it.mrt || null,
    coordinate: coordinateOf(it),
    publishedDate: it.add_time ? it.add_time.slice(0, 10) : null,
    totalPrice: numStr(it.total),
    totalPing: numStr(it.total_ping),
    unitPrice: numStr(it.price_ave),
    floor: numStr(it.floor),
    totalFloors: numStr(it.total_floor),
    typeLayout: it.pattern || null,
    age: numStr(it.house_age_x),
    parking: it.parking_type || null,
    realPriceUrl: null, // not exposed by the API; intentionally dropped
    listingHistory: history,
    id: it.id ?? null,
    source: it.source !== null && it.source !== undefined && it.source !== '' ? String(it.source) : null,
    sourceLink: it.link || null,
    room: it.room ?? null,
    livingRoom: it.living_room ?? null,
    bathroom: it.bathroom ?? null,
  };
}
