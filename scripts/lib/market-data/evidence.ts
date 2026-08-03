import type { ComparableEvidence, MarketScenarioEstimate, MarketTransaction } from './types.ts';

export interface OfficialComparableLocator {
  queryUrl: 'https://lvr.land.moi.gov.tw/';
  district: string;
  addressOrRoad: string;
  transactionMonth: string;
  floor: number;
  totalPriceNtd: number;
  totalAreaPing: number;
}

/** Fields a reader can enter at the official query page to locate one comparable. */
export function officialComparableLocator(transaction: MarketTransaction): OfficialComparableLocator {
  return {
    queryUrl: 'https://lvr.land.moi.gov.tw/',
    district: transaction.district,
    addressOrRoad: transaction.originalAddress,
    transactionMonth: transaction.transactionDate.slice(0, 7),
    floor: transaction.floor,
    totalPriceNtd: transaction.totalPriceNtd,
    totalAreaPing: transaction.totalAreaPing,
  };
}

/** Decorates only the local enriched/report projection, leaving persisted indexes unchanged. */
export function attachOfficialComparableLocators(estimate: MarketScenarioEstimate): MarketScenarioEstimate {
  return {
    ...estimate,
    scenarios: estimate.scenarios.map((scenario) => ({
      ...scenario,
      comparables: scenario.comparables.map(withOfficialLocator),
      bundleComparables: scenario.bundleComparables.map(withOfficialLocator),
    })),
  };
}

function withOfficialLocator(comparable: ComparableEvidence): ComparableEvidence & {
  officialLocator: OfficialComparableLocator;
} {
  return {
    ...comparable,
    officialLocator: officialComparableLocator(comparable.transaction),
  };
}
