/**
 * Offline (pure) half of enrichment: parse numbers, compute the mortgage, find
 * the K nearest candidate exits by straight-line distance, check the
 * coordinate↔district consistency, and flag auction keywords. No I/O — the
 * orchestrator (scripts/enrich.ts) then routes the candidates and finalizes.
 */
import type { Listing } from './types.ts';
import { parseWan, parsePing, parseUnitPrice, parseNumber, wanToNtd } from './parse.ts';
import { kNearestExits, type MrtExit, type NearestExit } from './mrt.ts';
import { mortgageForPrice } from './finance.ts';
import { hasAuctionKeyword } from './exclude.ts';
import { extractDistrict, districtConsistent } from './districts.ts';

/** How many straight-line-nearest exits to route per listing. */
export const CANDIDATE_EXITS = 3;

export interface OfflineEnriched extends Listing {
  totalPriceWan: number | null;
  totalPriceNtd: number | null;
  totalPingNum: number | null;
  unitPriceWan: number | null;
  ageNum: number | null;
  monthlyMortgage: number | null;
  district: string | null;
  coordConsistent: boolean | null;
  candidates: NearestExit[];
  hasAuction: boolean;
}

export function enrichOffline(listing: Listing, exits: MrtExit[]): OfflineEnriched {
  const totalPriceWan = parseWan(listing.totalPrice);
  const totalPriceNtd = wanToNtd(totalPriceWan);
  const district = extractDistrict(listing.addressOrArea);
  const candidates = listing.coordinate
    ? kNearestExits(listing.coordinate, exits, CANDIDATE_EXITS)
    : [];
  return {
    ...listing,
    totalPriceWan,
    totalPriceNtd,
    totalPingNum: parsePing(listing.totalPing),
    unitPriceWan: parseUnitPrice(listing.unitPrice),
    ageNum: parseNumber(listing.age),
    monthlyMortgage:
      totalPriceNtd != null ? Math.round(mortgageForPrice(totalPriceNtd)) : null,
    district,
    coordConsistent: districtConsistent(listing.coordinate, district),
    candidates,
    hasAuction: hasAuctionKeyword(listing.title),
  };
}
