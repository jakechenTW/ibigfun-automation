/**
 * Objective hard-exclusion checks (docs/reporting-rules.md). These flag only
 * what the data clearly determines; the agent confirms and makes the final call.
 * Pure and unit-tested.
 */

/** Auction / special-disposition markers (foreclosure, court/bank auction, tender, post-auction bidding). */
const AUCTION_KEYWORDS = ['法拍', '銀拍', '金拍', '法院拍賣', '拍賣', '投標', '應買'];

export function hasAuctionKeyword(title: string): boolean {
  return AUCTION_KEYWORDS.some((k) => title.includes(k));
}

export interface HardExclusion {
  excluded: boolean;
  reasons: string[];
}

/**
 * Decide objective hard exclusion from title + straight-line MRT distance.
 *
 * MRT rule: auto-exclude only when straight-line distance is clearly beyond the
 * boundary (> 900 m) — straight-line under-estimates walking distance, so this
 * is comfortably past the 800 m rule. 700–900 m is a manual boundary case (not
 * excluded here). A missing distance never excludes (insufficient evidence).
 */
export function evaluateHardExclusion(opts: {
  title: string;
  mrtDistanceM: number | null;
}): HardExclusion {
  const reasons: string[] = [];
  if (hasAuctionKeyword(opts.title)) {
    reasons.push('auction/special-disposition keyword in title');
  }
  if (opts.mrtDistanceM != null && opts.mrtDistanceM > 900) {
    reasons.push(
      `clearly over 800m from MRT (straight-line ${Math.round(opts.mrtDistanceM)}m)`,
    );
  }
  return { excluded: reasons.length > 0, reasons };
}
