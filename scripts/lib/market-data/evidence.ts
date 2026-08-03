import type {
  ComparableEvidence,
  MarketScenarioEstimate,
  MarketTransaction,
  UseScenarioEstimate,
} from './types.ts';

export interface OfficialComparableLocator {
  queryUrl: 'https://lvr.land.moi.gov.tw/';
  district: string;
  addressOrRoad: string;
  transactionMonth: string;
  floor: number;
  totalPriceNtd: number;
  totalAreaPing: number;
}

/** Comparable evidence as serialized only into local enriched/report artifacts. */
export interface LocalComparableEvidence extends ComparableEvidence {
  officialLocator: OfficialComparableLocator;
}

export interface LocalUseScenarioEstimate extends Omit<UseScenarioEstimate, 'comparables' | 'bundleComparables'> {
  comparables: LocalComparableEvidence[];
  bundleComparables: LocalComparableEvidence[];
}

export interface LocalMarketScenarioEstimate extends Omit<MarketScenarioEstimate, 'scenarios'> {
  scenarios: LocalUseScenarioEstimate[];
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
export function attachOfficialComparableLocators(estimate: MarketScenarioEstimate): LocalMarketScenarioEstimate {
  return {
    ...estimate,
    scenarios: estimate.scenarios.map((scenario) => ({
      ...scenario,
      comparables: scenario.comparables.map(withOfficialLocator),
      bundleComparables: scenario.bundleComparables.map(withOfficialLocator),
    })),
  };
}

function withOfficialLocator(comparable: ComparableEvidence): LocalComparableEvidence {
  return {
    ...comparable,
    officialLocator: officialComparableLocator(comparable.transaction),
  };
}
