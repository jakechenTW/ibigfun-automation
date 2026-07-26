import type { Coordinate } from '../coords.ts';
import { GRID_CELL_DEGREES } from './config.ts';

const METERS_PER_LATITUDE_DEGREE = 111_320;

function assertFiniteCoordinate(coordinate: Coordinate): void {
  if (!Number.isFinite(coordinate.lat) || !Number.isFinite(coordinate.lng)) {
    throw new RangeError('Grid coordinates must be finite');
  }
}

/** Returns the stable fixed-degree grid cell containing a coordinate. */
export function gridKey(coordinate: Coordinate): string {
  assertFiniteCoordinate(coordinate);
  return `${Math.floor(coordinate.lat / GRID_CELL_DEGREES)}:${Math.floor(coordinate.lng / GRID_CELL_DEGREES)}`;
}

/**
 * Enumerates sorted grid cells spanning the radius bounding box, so every cell
 * that can intersect the requested radius is present for a deterministic index
 * lookup.
 */
export function neighborGridKeys(coordinate: Coordinate, radiusM: number): string[] {
  assertFiniteCoordinate(coordinate);
  if (!Number.isFinite(radiusM) || radiusM < 0) {
    throw new RangeError('Grid radius must be a non-negative finite number');
  }

  const latitudeDelta = radiusM / METERS_PER_LATITUDE_DEGREE;
  const longitudeDelta = radiusM /
    (METERS_PER_LATITUDE_DEGREE * Math.cos((coordinate.lat * Math.PI) / 180));
  const minLatCell = Math.floor((coordinate.lat - latitudeDelta) / GRID_CELL_DEGREES);
  const maxLatCell = Math.floor((coordinate.lat + latitudeDelta) / GRID_CELL_DEGREES);
  const minLngCell = Math.floor((coordinate.lng - longitudeDelta) / GRID_CELL_DEGREES);
  const maxLngCell = Math.floor((coordinate.lng + longitudeDelta) / GRID_CELL_DEGREES);

  const keys: string[] = [];
  for (let latCell = minLatCell; latCell <= maxLatCell; latCell += 1) {
    for (let lngCell = minLngCell; lngCell <= maxLngCell; lngCell += 1) {
      keys.push(`${latCell}:${lngCell}`);
    }
  }
  return keys.sort();
}
