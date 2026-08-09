import { deriveBuildingValues, relativeIqrRatio } from './arithmetic.ts';
import { PARKING_POLICY } from './config.ts';
import { estimateParking } from './parking.ts';
import { weightedQuantile } from './statistics.ts';
import type {
  MarketTransaction,
  ParkingImputationEvidence,
  ParkingPriceAreaPair,
} from './types.ts';

export interface AcceptedParkingImputation {
  imputation: ParkingImputationEvidence;
  parkingPriceNtd: number;
  parkingAreaPing: number;
  buildingPriceNtd: number;
  buildingAreaPing: number;
  buildingUnitPriceWan: number;
  buildingUnitPriceBoundsWan: NonNullable<MarketTransaction['buildingUnitPriceBoundsWan']>;
}

/** Pure policy-8 derivation from a subject and its authoritative causal history. */
export function deriveAcceptedParkingImputation(
  transaction: MarketTransaction,
  directGradeA: readonly MarketTransaction[],
): AcceptedParkingImputation | null {
  const coordinate = transaction.location.coordinate;
  const family = transaction.parkingEvidence.family;
  const count = transaction.transferredParkingCount;
  if (!coordinate || (family !== 'flat' && family !== 'mechanical')
    || !Number.isSafeInteger(count) || count === null || count <= 0) return null;
  const officialPrice = transaction.parkingEvidence.officialPriceNtd;
  const officialArea = transaction.parkingEvidence.officialAreaPing;
  const estimate = estimateParking({
    coordinate,
    matchedAddress: transaction.location.matchedAddress,
    buildingType: transaction.buildingType,
    family,
    knownPriceNtd: officialPrice === null ? null : officialPrice / count,
    knownAreaPing: officialArea === null ? null : officialArea / count,
  }, directGradeA, transaction.transactionDate);
  if (!estimate) return null;

  const finalPair = (pair: ParkingPriceAreaPair): ParkingPriceAreaPair => ({
    priceNtd: officialPrice ?? pair.priceNtd * count,
    areaPing: officialArea ?? pair.areaPing * count,
  });
  const pairP25 = finalPair(estimate.pairP25);
  const pairP50 = finalPair(estimate.pairP50);
  const pairP75 = finalPair(estimate.pairP75);
  const finalPairs = estimate.directPairs.map((pair) => ({
    id: pair.id,
    ...finalPair(pair),
    weight: pair.weight,
  }));
  const componentQuantile = (component: 'priceNtd' | 'areaPing', quantile: number): number => weightedQuantile(
    finalPairs.map((pair) => ({ id: pair.id, value: pair[component], weight: pair.weight })),
    quantile,
  );
  const priceP25Ntd = Math.min(componentQuantile('priceNtd', 0.25), pairP50.priceNtd);
  const priceP75Ntd = Math.max(componentQuantile('priceNtd', 0.75), pairP50.priceNtd);
  const areaP25Ping = Math.min(componentQuantile('areaPing', 0.25), pairP50.areaPing);
  const areaP75Ping = Math.max(componentQuantile('areaPing', 0.75), pairP50.areaPing);
  const priceIqrRatio = relativeIqrRatio(priceP25Ntd, pairP50.priceNtd, priceP75Ntd);
  const areaIqrRatio = relativeIqrRatio(areaP25Ping, pairP50.areaPing, areaP75Ping);
  const buildingObservations = finalPairs.flatMap((pair) => {
    const buildingPriceNtd = transaction.totalPriceNtd - pair.priceNtd;
    const buildingAreaPing = transaction.totalAreaPing - pair.areaPing;
    const unitPriceWan = buildingPriceNtd / buildingAreaPing / 10_000;
    return buildingPriceNtd > 0 && buildingAreaPing > 0 && Number.isFinite(unitPriceWan) && unitPriceWan > 0
      ? [{ id: pair.id, value: unitPriceWan, weight: pair.weight }]
      : [];
  });
  if (buildingObservations.length !== finalPairs.length) return null;
  const { buildingPriceNtd, buildingAreaPing, buildingUnitPriceWan } = deriveBuildingValues(
    transaction.totalPriceNtd,
    transaction.totalAreaPing,
    pairP50.priceNtd,
    pairP50.areaPing,
  );
  const p25 = Math.min(weightedQuantile(buildingObservations, 0.25), buildingUnitPriceWan);
  const p75 = Math.max(weightedQuantile(buildingObservations, 0.75), buildingUnitPriceWan);
  const buildingIqrRatio = relativeIqrRatio(p25, buildingUnitPriceWan, p75);
  if (buildingPriceNtd <= 0 || buildingAreaPing <= 0
      || !Number.isFinite(priceIqrRatio) || priceIqrRatio > PARKING_POLICY.maximumPriceIqrRatio
      || !Number.isFinite(areaIqrRatio) || areaIqrRatio > PARKING_POLICY.maximumAreaIqrRatio
      || !Number.isFinite(buildingIqrRatio)
      || buildingIqrRatio > PARKING_POLICY.maximumBuildingUnitPriceIqrRatio) {
    return null;
  }
  return {
    imputation: {
      asOf: estimate.asOf,
      stage: estimate.stage,
      comparableIds: estimate.comparableIds,
      comparableCount: estimate.comparableCount,
      priceP25Ntd,
      priceP50Ntd: pairP50.priceNtd,
      priceP75Ntd,
      areaP25Ping,
      areaP50Ping: pairP50.areaPing,
      areaP75Ping,
      pairP25,
      pairP50,
      pairP75,
      priceIqrRatio,
      areaIqrRatio,
    },
    parkingPriceNtd: pairP50.priceNtd,
    parkingAreaPing: pairP50.areaPing,
    buildingPriceNtd,
    buildingAreaPing,
    buildingUnitPriceWan,
    buildingUnitPriceBoundsWan: { p25, p50: buildingUnitPriceWan, p75, relativeIqrRatio: buildingIqrRatio },
  };
}
