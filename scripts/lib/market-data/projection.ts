import proj4 from 'proj4';
import type { Coordinate } from '../coords.ts';

const EPSG_3826 = '+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs +type=crs';
const EPSG_4326 = '+proj=longlat +datum=WGS84 +no_defs +type=crs';

const TAIPEI_BOUNDS = {
  minLat: 24.8,
  maxLat: 25.35,
  minLng: 121.3,
  maxLng: 121.8,
};

proj4.defs('EPSG:3826', EPSG_3826);
proj4.defs('EPSG:4326', EPSG_4326);

/** Converts finite TWD97 TM2 zone 121 coordinates that resolve inside Taipei. */
export function twd97ToWgs84(x: number, y: number): Coordinate {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RangeError('TWD97 coordinates must be finite');
  }

  const [lng, lat] = proj4('EPSG:3826', 'EPSG:4326', [x, y]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < TAIPEI_BOUNDS.minLat || lat > TAIPEI_BOUNDS.maxLat ||
      lng < TAIPEI_BOUNDS.minLng || lng > TAIPEI_BOUNDS.maxLng) {
    throw new RangeError('TWD97 coordinates must resolve within Taipei');
  }

  return { lat, lng };
}
