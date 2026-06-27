/**
 * Derive a deterministic "days on market" summary from a listing's 刊登紀錄.
 * firstListedDate = earliest record overall (including 下架), so it reflects how
 * long the property has been shopped around. Pure and unit-tested.
 */
import type { ListingHistoryEntry, ListingTenure } from './types.ts';
import { firstNumber } from './parse.ts';
import { daysBetween, isValidDateString } from './date.ts';

const EMPTY: ListingTenure = {
  firstListedDate: null,
  daysOnMarket: null,
  recordCount: 0,
  sourceCount: 0,
  priceTrend: 'unknown',
  firstPrice: null,
  latestPrice: null,
};

export function computeTenure(
  history: ListingHistoryEntry[],
  targetDate: string,
): ListingTenure {
  if (history.length === 0) return { ...EMPTY };

  const sorted = [...history].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const firstListedDate = sorted[0].date;
  const daysOnMarket = isValidDateString(targetDate)
    ? Math.max(0, daysBetween(firstListedDate, targetDate))
    : null;
  const sourceCount = new Set(history.map((h) => h.source).filter(Boolean)).size;

  const priced = sorted
    .map((h) => firstNumber(h.price))
    .filter((n): n is number => n != null);
  let priceTrend: ListingTenure['priceTrend'] = 'unknown';
  let firstPrice: number | null = null;
  let latestPrice: number | null = null;
  if (priced.length > 0) {
    firstPrice = priced[0];
    latestPrice = priced[priced.length - 1];
    priceTrend =
      latestPrice < firstPrice ? 'dropped' : latestPrice > firstPrice ? 'raised' : 'flat';
  }

  return {
    firstListedDate,
    daysOnMarket,
    recordCount: history.length,
    sourceCount,
    priceTrend,
    firstPrice,
    latestPrice,
  };
}
