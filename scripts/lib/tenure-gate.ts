export type TenureGate = 'eligible' | 'expired' | 'review';

export function classifyTenureGate(daysOnMarket: number | null, maxDaysOnMarket: number): TenureGate {
  if (daysOnMarket === null) return 'review';
  return daysOnMarket <= maxDaysOnMarket ? 'eligible' : 'expired';
}
