/**
 * Mortgage and ratio math for the investment screen. Pure and unit-tested.
 *
 * Project assumptions (docs/reporting-rules.md): 80% loan-to-value, 2.6% annual
 * interest, 30-year principal-and-interest amortization.
 */

export const LOAN_TO_VALUE = 0.8;
export const ANNUAL_RATE_PCT = 2.6;
export const TERM_YEARS = 30;

/** Monthly payment for a fully-amortizing loan. */
export function monthlyMortgage(
  principalNtd: number,
  annualRatePct: number,
  years: number,
): number {
  const r = annualRatePct / 100 / 12;
  const n = years * 12;
  if (r === 0) return principalNtd / n;
  const factor = Math.pow(1 + r, n);
  return (principalNtd * r * factor) / (factor - 1);
}

/** Monthly payment for a listing's total price under the project assumptions. */
export function mortgageForPrice(totalPriceNtd: number): number {
  return monthlyMortgage(
    totalPriceNtd * LOAN_TO_VALUE,
    ANNUAL_RATE_PCT,
    TERM_YEARS,
  );
}

/**
 * Discount vs market, in percent: positive means below market.
 * NOTE: the investment screen now frames the metric as 開價溢價 (asking premium)
 * = −discountPercent. Kept as a utility; see docs/reporting-rules.md (Calculations).
 */
export function discountPercent(
  marketUnitPrice: number,
  listingUnitPrice: number,
): number {
  return ((marketUnitPrice - listingUnitPrice) / marketUnitPrice) * 100;
}

/**
 * Rent coverage ratio: monthly rent / monthly mortgage payment.
 * Advisory display only — the investment screen no longer gates buckets on this
 * (rent is too unreliable to gate). See docs/reporting-rules.md (Rent).
 */
export function rentCoverage(
  monthlyRent: number,
  monthlyMortgagePayment: number,
): number {
  return monthlyRent / monthlyMortgagePayment;
}
