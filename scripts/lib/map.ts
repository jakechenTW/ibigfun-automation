/**
 * Pure mapping from iBigFun's /api/search/list + on-market/o2o-same JSON into
 * the normalized `Listing`. Values stay as display strings (downstream enrich
 * parses numbers) except `coordinate`. No network, no DOM — unit-tested.
 */
import type { ListItem, O2oForId } from './api.ts';
import type { Coordinate } from './coords.ts';
import type { Listing } from './types.ts';
import { normalizeHistory, type RawHistoryRow } from './history.ts';

/** Stringify a numeric field, or null when it is null/undefined. */
function numStr(n: number | null | undefined): string | null {
  return n === null || n === undefined ? null : String(n);
}

/** Build a Coordinate from lat/lng when both are finite, else null. */
function coordinateOf(it: ListItem): Coordinate | null {
  if (Number.isFinite(it.lat) && Number.isFinite(it.lng) && (it.lat !== 0 || it.lng !== 0)) {
    return { lat: it.lat, lng: it.lng };
  }
  return null;
}

/** Convert one listing's o2o-same map into raw history rows (all active). */
export function o2oToRawHistory(forId: O2oForId): RawHistoryRow[] {
  return Object.entries(forId).map(([source, e]) => ({
    price: e.total !== null && e.total !== undefined ? String(e.total) : null,
    source,
    date: e.add_date ?? null,
    active: true, // o2o-same exposes no 下架 flag; see spec fidelity note
  }));
}

/** Map one API item (+ its history) to a Listing. */
export function apiItemToListing(it: ListItem, historyForId: O2oForId): Listing {
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
    listingHistory: normalizeHistory(o2oToRawHistory(historyForId)),
    id: it.id ?? null,
    source: it.source !== null && it.source !== undefined && it.source !== '' ? String(it.source) : null,
    sourceLink: it.link || null,
    room: it.room ?? null,
    livingRoom: it.living_room ?? null,
    bathroom: it.bathroom ?? null,
  };
}
