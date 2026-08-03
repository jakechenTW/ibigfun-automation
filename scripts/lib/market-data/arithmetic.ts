export interface DerivedBuildingValues {
  buildingPriceNtd: number;
  buildingAreaPing: number;
  buildingUnitPriceWan: number;
}

/** Shared persisted-row arithmetic used by both the builder and strict loader. */
export function deriveBuildingValues(
  totalPriceNtd: number,
  totalAreaPing: number,
  parkingPriceNtd: number,
  parkingAreaPing: number,
): DerivedBuildingValues {
  const buildingPriceNtd = totalPriceNtd - parkingPriceNtd;
  const buildingAreaPing = totalAreaPing - parkingAreaPing;
  return {
    buildingPriceNtd,
    buildingAreaPing,
    buildingUnitPriceWan: buildingPriceNtd / buildingAreaPing / 10_000,
  };
}

export function relativeIqrRatio(p25: number, p50: number, p75: number): number {
  return (p75 - p25) / p50;
}

export function sameDerivedNumber(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(actual), Math.abs(expected));
}
