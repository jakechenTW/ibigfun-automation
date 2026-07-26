import type { BuildingType, FloorGroup } from './types.ts';

const OFFICIAL_BUILDING_TYPES: Record<string, BuildingType> = {
  '公寓(5樓含以下無電梯)': 'apartment',
  '華廈(10層含以下有電梯)': 'midrise',
  '住宅大樓(11層含以上有電梯)': 'highrise',
};

/** Normalizes only the official building labels supported by the market data. */
export function normalizeOfficialBuildingType(raw: string): BuildingType | null {
  return OFFICIAL_BUILDING_TYPES[raw.normalize('NFKC').replace(/\s+/g, '')] ?? null;
}

/** Assigns a floor group from structured building type and floor data. */
export function floorGroup(
  type: BuildingType,
  floor: number,
  totalFloors: number,
): FloorGroup | null {
  if (!Number.isInteger(floor) || !Number.isInteger(totalFloors) || floor < 1 || totalFloors < 1 || floor > totalFloors) {
    return null;
  }

  if (floor === 1) return 'first';

  if (type === 'apartment') {
    if (floor === totalFloors) return 'top';
    return floor <= 3 ? 'low' : 'middle';
  }

  if (floor <= 4) return 'low';
  if (floor <= 7) return 'middle';
  return 'high';
}
