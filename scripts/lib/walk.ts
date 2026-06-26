/**
 * Walking-distance decision (pure). Given the offline result and the routed
 * walking distances to the candidate exits, pick the shortest-walk exit, run
 * the reliability gate, and decide `withinWalk` plus hard exclusion.
 *
 * Reliability gate: trust the decision only when the coordinate is consistent
 * with the address district AND the routed/straight ratio is plausible.
 * Otherwise `withinWalk` is null (manual review) and we never auto-exclude on
 * distance grounds.
 */
import type { OfflineEnriched } from './enrich-offline.ts';
import type { EnrichedListing, Reliability, WalkInfo } from './types.ts';

/** ≤10-min walk threshold (~800m at 80 m/min); transparent and tunable. */
export const WALK_THRESHOLD_M = 800;
export const WALK_SPEED_M_PER_MIN = 80;
/** Plausible routed/straight ratio band; outside it the route is not trusted. */
export const RATIO_MIN = 0.9;
export const RATIO_MAX = 2.5;

/** Listing + numeric/district fields, without the offline-only internals. */
function listingBase(o: OfflineEnriched) {
  const { candidates, coordConsistent, hasAuction, ...rest } = o;
  return rest;
}

/**
 * @param routed walking distances aligned to `o.candidates` (null per entry
 *   that failed); or null when routing was not attempted at all.
 */
export function finalizeWalk(
  o: OfflineEnriched,
  routed: (number | null)[] | null,
): EnrichedListing {
  const coordPresent = o.candidates.length > 0;
  const reliability: Reliability = {
    coordPresent,
    coordConsistent: o.coordConsistent,
    routeOk: null,
    ratio: null,
    reason: null,
  };
  let walk: WalkInfo | null = null;
  let withinWalk: boolean | null = null;

  if (!coordPresent) {
    reliability.reason = 'no coordinate';
  } else if (o.coordConsistent === false) {
    reliability.reason = 'coordinate inconsistent with district';
  } else if (!routed) {
    reliability.routeOk = false;
    reliability.reason = 'routing unavailable';
  } else {
    let best: { idx: number; walkM: number } | null = null;
    for (let i = 0; i < o.candidates.length; i++) {
      const w = routed[i];
      if (w != null && (!best || w < best.walkM)) best = { idx: i, walkM: w };
    }
    if (!best) {
      reliability.routeOk = false;
      reliability.reason = 'routing returned no distance';
    } else {
      const c = o.candidates[best.idx];
      const ratio = best.walkM / c.distanceM;
      reliability.ratio = Math.round(ratio * 100) / 100;
      reliability.routeOk = ratio >= RATIO_MIN && ratio <= RATIO_MAX;
      if (!reliability.routeOk) {
        reliability.reason = 'route ratio implausible';
      } else {
        walk = {
          stationZh: c.exit.nameZh,
          line: c.exit.line,
          exitId: c.exit.exitId,
          distanceM: Math.round(best.walkM),
          minutes: Math.round(best.walkM / WALK_SPEED_M_PER_MIN),
        };
        withinWalk = best.walkM <= WALK_THRESHOLD_M;
      }
    }
  }

  const reasons: string[] = [];
  if (o.hasAuction) reasons.push('auction/special-disposition keyword in title');
  if (withinWalk === false && walk) {
    reasons.push(`>10-min walk to MRT (routed ${walk.distanceM}m to ${walk.stationZh})`);
  }

  return {
    ...listingBase(o),
    walk,
    withinWalk,
    reliability,
    hardExclusion: { excluded: reasons.length > 0, reasons },
  };
}
