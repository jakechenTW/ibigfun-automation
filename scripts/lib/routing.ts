/**
 * OpenRouteService foot-walking client. ORS computes walking routes over
 * OpenStreetMap road/path data; we use its Matrix endpoint to get the walking
 * distance from one listing coordinate to several candidate MRT exits in a
 * single call. Network-dependent (not unit-tested) — verified live and cached
 * by the orchestrator (scripts/enrich.ts).
 */
import type { LatLng } from './geo.ts';

const ORS_MATRIX_URL = 'https://api.openrouteservice.org/v2/matrix/foot-walking';

/**
 * Walking distances (meters) from `origin` to each of `dests`, aligned to the
 * `dests` order. A per-destination value may be null if ORS returns none.
 * Throws on HTTP / network / shape errors so the caller can mark the listing
 * "routing unavailable" rather than guessing.
 */
export async function routeWalkDistances(
  origin: LatLng,
  dests: LatLng[],
  apiKey: string,
): Promise<(number | null)[]> {
  if (dests.length === 0) return [];

  const locations = [
    [origin.lng, origin.lat],
    ...dests.map((d) => [d.lng, d.lat]),
  ];
  const body = {
    locations,
    sources: [0],
    destinations: dests.map((_, i) => i + 1),
    metrics: ['distance'],
    units: 'm',
  };

  const res = await fetch(ORS_MATRIX_URL, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`ORS matrix HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { distances?: (number | null)[][] };
  const row = json.distances?.[0];
  if (!Array.isArray(row)) throw new Error('ORS matrix: missing distances');
  return row.map((d) => (typeof d === 'number' ? d : null));
}
