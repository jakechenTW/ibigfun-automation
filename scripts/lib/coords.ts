/**
 * Extracts a lat/lng coordinate from a Google Maps URL.
 *
 * iBigFun listing addresses often link to Google Maps; the coordinate in that
 * link is the listing location used for MRT-distance checks (see
 * docs/reporting-rules.md). This parser is pure and unit-tested.
 */

export interface Coordinate {
  lat: number;
  lng: number;
}

// Rough Taipei-area sanity bounds; rejects obviously broken coordinates.
const LAT_MIN = -90;
const LAT_MAX = 90;
const LNG_MIN = -180;
const LNG_MAX = 180;

function inRange(lat: number, lng: number): boolean {
  return lat >= LAT_MIN && lat <= LAT_MAX && lng >= LNG_MIN && lng <= LNG_MAX;
}

function toCoordinate(latRaw: string, lngRaw: string): Coordinate | null {
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!inRange(lat, lng)) return null;
  return { lat, lng };
}

/**
 * Parse the first coordinate found in a Google Maps URL, trying the common
 * encodings in order: `q=lat,lng`, `@lat,lng`, and `!3dlat!4dlng`.
 * Returns null when no valid coordinate is present.
 */
export function parseMapsCoordinate(url: string | null | undefined): Coordinate | null {
  if (!url) return null;

  const q = url.match(/[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (q) return toCoordinate(q[1], q[2]);

  const at = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) return toCoordinate(at[1], at[2]);

  const data = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (data) return toCoordinate(data[1], data[2]);

  return null;
}
