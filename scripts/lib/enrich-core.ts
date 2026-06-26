/**
 * Pure per-listing enrichment: parse numbers, find the nearest MRT exit,
 * compute the monthly mortgage, and apply objective hard-exclusion flags.
 * No I/O — scripts/enrich.ts supplies the listings and the exit dataset.
 */
import type { Listing, EnrichedListing } from './types.ts';
import { parseWan, parsePing, parseUnitPrice, parseNumber, wanToNtd } from './parse.ts';
import { nearestExit, type MrtExit } from './mrt.ts';
import { mortgageForPrice } from './finance.ts';
import { evaluateHardExclusion } from './exclude.ts';

const MRT_BOUNDARY_MIN_M = 700;
const MRT_BOUNDARY_MAX_M = 900;

export function enrichListing(listing: Listing, exits: MrtExit[]): EnrichedListing {
  const totalPriceWan = parseWan(listing.totalPrice);
  const totalPriceNtd = wanToNtd(totalPriceWan);

  const near = listing.coordinate ? nearestExit(listing.coordinate, exits) : null;
  const distanceM = near ? near.distanceM : null;
  const mrt = near
    ? {
        stationId: near.exit.stationId,
        nameZh: near.exit.nameZh,
        line: near.exit.line,
        exitId: near.exit.exitId,
        distanceM: Math.round(near.distanceM),
      }
    : null;
  const mrtBoundaryCase =
    distanceM != null && distanceM > MRT_BOUNDARY_MIN_M && distanceM <= MRT_BOUNDARY_MAX_M;

  return {
    ...listing,
    totalPriceWan,
    totalPriceNtd,
    totalPingNum: parsePing(listing.totalPing),
    unitPriceWan: parseUnitPrice(listing.unitPrice),
    ageNum: parseNumber(listing.age),
    monthlyMortgage:
      totalPriceNtd != null ? Math.round(mortgageForPrice(totalPriceNtd)) : null,
    mrt,
    mrtBoundaryCase,
    hardExclusion: evaluateHardExclusion({
      title: listing.title,
      mrtDistanceM: distanceM,
    }),
  };
}
