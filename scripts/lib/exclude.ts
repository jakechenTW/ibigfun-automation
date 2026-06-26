/**
 * Auction / special-disposition detection (docs/reporting-rules.md). The MRT
 * distance exclusion now lives in walk.ts (walking-distance based); this module
 * only owns the title-keyword check. Pure and unit-tested.
 */

/** Foreclosure, court/bank auction, tender, post-auction bidding markers. */
const AUCTION_KEYWORDS = ['法拍', '銀拍', '金拍', '法院拍賣', '拍賣', '投標', '應買'];

export function hasAuctionKeyword(title: string): boolean {
  return AUCTION_KEYWORDS.some((k) => title.includes(k));
}
