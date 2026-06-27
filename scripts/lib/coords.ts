/**
 * Geographic coordinate type shared across the codebase.
 *
 * A listing's lat/lng (the location used for MRT-distance checks — see
 * docs/reporting-rules.md) now comes straight from the iBigFun API
 * (scripts/lib/map.ts). The earlier Google-Maps-URL parser was removed when the
 * fetch step moved to the JSON API; only this type remains.
 */

export interface Coordinate {
  lat: number;
  lng: number;
}
