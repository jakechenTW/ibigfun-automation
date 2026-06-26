/**
 * Taipei district sanity check for listing coordinates.
 *
 * A listing has both a text address and an embedded map coordinate; they should
 * agree. This module flags gross mismatches (a coordinate pinned in the wrong
 * district) so the walking-distance decision isn't trusted on bad data.
 * Approximate district centroids — a coarse sanity gate, not precise validation.
 * Pure and unit-tested.
 */
import { haversineMeters, type LatLng } from './geo.ts';

/** Approximate centroids of Taipei's 12 districts. */
const CENTROIDS: Record<string, LatLng> = {
  中正區: { lat: 25.032, lng: 121.518 },
  大同區: { lat: 25.063, lng: 121.513 },
  中山區: { lat: 25.069, lng: 121.538 },
  松山區: { lat: 25.058, lng: 121.557 },
  大安區: { lat: 25.026, lng: 121.543 },
  萬華區: { lat: 25.032, lng: 121.499 },
  信義區: { lat: 25.031, lng: 121.567 },
  士林區: { lat: 25.092, lng: 121.526 },
  北投區: { lat: 25.132, lng: 121.501 },
  內湖區: { lat: 25.069, lng: 121.594 },
  南港區: { lat: 25.054, lng: 121.606 },
  文山區: { lat: 24.989, lng: 121.57 },
};

const DISTRICT_NAMES = Object.keys(CENTROIDS);

/** Extract the Taipei district (e.g. "中正區") from an address, or null. */
export function extractDistrict(address: string | null): string | null {
  if (!address) return null;
  return DISTRICT_NAMES.find((d) => address.includes(d)) ?? null;
}

/**
 * Is `coord` consistent with the stated `district`?
 * - null when the district is unknown/unmapped or no coordinate (can't tell).
 * - false when the stated district's centroid is much farther from the
 *   coordinate than the nearest district's centroid (likely a wrong-district pin).
 * - true otherwise.
 *
 * Tolerance (nearest×1.5 + 1km) keeps legitimate large/edge-of-district
 * addresses passing while catching gross mismatches.
 */
export function districtConsistent(
  coord: LatLng | null,
  district: string | null,
): boolean | null {
  if (!coord || !district || !CENTROIDS[district]) return null;
  const km = (d: string) => haversineMeters(coord, CENTROIDS[d]) / 1000;
  const statedKm = km(district);
  const nearestKm = Math.min(...DISTRICT_NAMES.map(km));
  return statedKm <= nearestKm * 1.5 + 1.0;
}
