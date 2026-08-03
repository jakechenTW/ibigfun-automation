import { parse } from 'csv-parse';
import type { Readable } from 'node:stream';
import type { Coordinate } from '../coords.ts';
import { baseDoorplateKey, normalizeTaiwanAddress, type NormalizedAddress } from './address.ts';
import { MARKET_SCHEMA_VERSION } from './config.ts';
import { gridKey, neighborGridKeys } from './grid.ts';
import { twd97ToWgs84 } from './projection.ts';
import type { DoorplateIndex, DoorplatePoint, LocationEvidence } from './types.ts';

export type DoorplateCsvRow = Record<string, string>;

const ADDRESS_FIELDS = ['門牌地址', '完整地址', '地址'];
const CITY_FIELDS = ['縣市別', '縣市名稱', '縣市', '市'];
const CITY_CODE_FIELDS = ['省市縣市代碼'];
const DISTRICT_FIELDS = ['鄉鎮市區', '行政區', '區'];
const DISTRICT_CODE_FIELDS = ['鄉鎮市區代碼'];
const ROAD_FIELDS = ['路街', '路街名稱', '路名', '街道', '街路段'];
const SECTION_FIELDS = ['段'];
const LANE_FIELDS = ['巷'];
const ALLEY_FIELDS = ['弄'];
const NUMBER_FIELDS = ['號', '門牌號碼'];
const SUB_NUMBER_FIELDS = ['之', '附號'];
const X_FIELDS = ['坐標X', 'X坐標', '橫坐標', '橫座標', 'TWD97X', 'X'];
const Y_FIELDS = ['坐標Y', 'Y坐標', '縱坐標', '縱座標', 'TWD97Y', 'Y'];

const CITY_CODES: Record<string, string> = {
  '63000': '台北市',
};

const TAIPEI_DISTRICT_CODES: Record<string, string> = {
  '63000010': '松山區',
  '63000020': '信義區',
  '63000030': '大安區',
  '63000040': '中山區',
  '63000050': '中正區',
  '63000060': '大同區',
  '63000070': '萬華區',
  '63000080': '文山區',
  '63000090': '南港區',
  '63000100': '內湖區',
  '63000110': '士林區',
  '63000120': '北投區',
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePoints(left: DoorplatePoint, right: DoorplatePoint): number {
  return compareText(left.canonicalAddress, right.canonicalAddress) ||
    left.coordinate.lat - right.coordinate.lat ||
    left.coordinate.lng - right.coordinate.lng ||
    compareText(left.district, right.district) ||
    compareText(left.roadKey, right.roadKey) ||
    left.mainNumber - right.mainNumber ||
    (left.subNumber ?? -1) - (right.subNumber ?? -1);
}

function sortedIndexView(view: Record<string, DoorplatePoint[]>): Record<string, DoorplatePoint[]> {
  return Object.fromEntries(
    Object.entries(view)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, points]) => [key, points.sort(comparePoints)]),
  );
}

function field(row: DoorplateCsvRow, names: string[]): string | null {
  for (const name of names) {
    const value = row[name]?.trim();
    if (value) return value;
  }
  return null;
}

function hasHeader(headers: Set<string>, names: readonly string[]): boolean {
  return names.some((name) => headers.has(name));
}

/** Rejects source schema drift before silently dropping every unusable doorplate row. */
export function validateDoorplateHeaders(headers: Iterable<string>): void {
  const available = new Set([...headers].map((header) => header.normalize('NFKC').trim()));
  const hasAddress = hasHeader(available, ADDRESS_FIELDS);
  const hasStructuredAddress =
    (hasHeader(available, CITY_FIELDS) || hasHeader(available, CITY_CODE_FIELDS)) &&
    (hasHeader(available, DISTRICT_FIELDS) || hasHeader(available, DISTRICT_CODE_FIELDS)) &&
    hasHeader(available, ROAD_FIELDS) &&
    hasHeader(available, NUMBER_FIELDS);
  const hasCoordinates = hasHeader(available, X_FIELDS) && hasHeader(available, Y_FIELDS);
  if ((!hasAddress && !hasStructuredAddress) || !hasCoordinates) {
    throw new Error('Missing required doorplate headers');
  }
}

function withSuffix(value: string | null, suffix: string): string {
  if (!value) return '';
  return value.endsWith(suffix) ? value : `${value}${suffix}`;
}

function structuredAddress(row: DoorplateCsvRow): string | null {
  const exact = field(row, ADDRESS_FIELDS);
  if (exact) return exact;

  const city = field(row, CITY_FIELDS) ?? CITY_CODES[field(row, CITY_CODE_FIELDS) ?? ''];
  const district = field(row, DISTRICT_FIELDS) ??
    TAIPEI_DISTRICT_CODES[field(row, DISTRICT_CODE_FIELDS) ?? ''];
  const road = field(row, ROAD_FIELDS);
  const number = field(row, NUMBER_FIELDS);
  if (!city || !district || !road || !number) return null;

  const subNumber = field(row, SUB_NUMBER_FIELDS);
  const normalizedNumber = number.includes('號') ? number : `${number}號`;
  return `${city}${district}${road}${withSuffix(field(row, SECTION_FIELDS), '段')}` +
    `${withSuffix(field(row, LANE_FIELDS), '巷')}${withSuffix(field(row, ALLEY_FIELDS), '弄')}` +
    `${normalizedNumber}${subNumber ? `之${subNumber.replace(/^之/, '')}` : ''}`;
}

function finiteNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function roadKey(address: NormalizedAddress): string | null {
  if (!address.city || !address.district || !address.road) return null;
  return `${address.city}${address.district}${address.road}` +
    `${address.section === null ? '' : `${address.section}段`}` +
    `${address.lane === null ? '' : `${address.lane}巷`}` +
    `${address.alley === null ? '' : `${address.alley}弄`}`;
}

/** Maps a complete official CSV row into a safe, normalized WGS84 doorplate. */
export function mapDoorplateRow(row: DoorplateCsvRow): DoorplatePoint | null {
  const inputAddress = structuredAddress(row);
  const x = finiteNumber(field(row, X_FIELDS));
  const y = finiteNumber(field(row, Y_FIELDS));
  if (!inputAddress || x === null || y === null) return null;

  const address = normalizeTaiwanAddress(inputAddress);
  const indexedRoadKey = roadKey(address);
  const canonicalAddress = baseDoorplateKey(address);
  if (!address.district || address.number === null || !indexedRoadKey || !canonicalAddress) return null;

  try {
    return {
      canonicalAddress,
      coordinate: twd97ToWgs84(x, y),
      district: address.district,
      roadKey: indexedRoadKey,
      mainNumber: address.number,
      subNumber: address.subNumber,
    };
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** Builds deterministic address, road, and spatial views without loading the CSV into memory. */
export async function buildDoorplateIndex(
  source: Readable,
  datasetVersion: string,
  schemaVersion = MARKET_SCHEMA_VERSION,
): Promise<DoorplateIndex> {
  const byCanonicalAddress: Record<string, DoorplatePoint[]> = {};
  const byRoad: Record<string, DoorplatePoint[]> = {};
  const cells: Record<string, DoorplatePoint[]> = {};
  const seen = new Set<string>();
  const parser = source.pipe(parse({
    bom: true,
    columns: (headers: string[]) => {
      validateDoorplateHeaders(headers);
      return headers;
    },
    skip_empty_lines: true,
    trim: true,
  }));

  for await (const record of parser as AsyncIterable<DoorplateCsvRow>) {
    const point = mapDoorplateRow(record);
    if (!point) continue;
    const pointKey = `${point.canonicalAddress}\0${point.coordinate.lat}\0${point.coordinate.lng}`;
    if (seen.has(pointKey)) continue;
    seen.add(pointKey);

    (byCanonicalAddress[point.canonicalAddress] ??= []).push(point);
    (byRoad[point.roadKey] ??= []).push(point);
    (cells[gridKey(point.coordinate)] ??= []).push(point);
  }

  return {
    schemaVersion,
    datasetVersion,
    byCanonicalAddress: sortedIndexView(byCanonicalAddress),
    byRoad: sortedIndexView(byRoad),
    cells: sortedIndexView(cells),
  };
}

function unresolved(index: DoorplateIndex, normalizedAddress: string): LocationEvidence {
  return {
    method: 'unresolved',
    coordinate: null,
    normalizedAddress,
    matchedAddress: null,
    uncertaintyMeters: null,
    confidence: 'low',
    datasetVersion: index.datasetVersion,
  };
}

function haversineMeters(left: Coordinate, right: Coordinate): number {
  const radians = Math.PI / 180;
  const deltaLat = (right.lat - left.lat) * radians;
  const deltaLng = (right.lng - left.lng) * radians;
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(left.lat * radians) * Math.cos(right.lat * radians) * Math.sin(deltaLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function centroidOf(points: DoorplatePoint[]): Coordinate {
  const total = points.reduce<Coordinate>(
    (sum, point) => ({ lat: sum.lat + point.coordinate.lat, lng: sum.lng + point.coordinate.lng }),
    { lat: 0, lng: 0 },
  );
  return { lat: total.lat / points.length, lng: total.lng / points.length };
}

/** Locates an exact official doorplate or a masked range on the same road. */
export function locateAddress(index: DoorplateIndex, input: string): LocationEvidence {
  const address = normalizeTaiwanAddress(input);
  if (address.numberRange) {
    const indexedRoadKey = roadKey(address);
    if (!indexedRoadKey) return unresolved(index, address.canonical);

    const candidates = (index.byRoad[indexedRoadKey] ?? []).filter((point) =>
      point.mainNumber >= address.numberRange!.min && point.mainNumber <= address.numberRange!.max,
    );
    if (candidates.length === 0) return unresolved(index, address.canonical);

    const coordinate = centroidOf(candidates);
    const uncertaintyMeters = Math.max(...candidates.map((point) => haversineMeters(coordinate, point.coordinate)));
    return {
      method: 'address-range',
      coordinate,
      normalizedAddress: address.canonical,
      matchedAddress: candidates[0]!.canonicalAddress,
      uncertaintyMeters,
      confidence: 'medium',
      datasetVersion: index.datasetVersion,
    };
  }

  const baseKey = baseDoorplateKey(address);
  const points = baseKey ? index.byCanonicalAddress[baseKey] : undefined;
  const point = points?.[0];
  if (!point || points.some((candidate) =>
    candidate.coordinate.lat !== point.coordinate.lat || candidate.coordinate.lng !== point.coordinate.lng)) {
    return unresolved(index, address.canonical);
  }
  return {
    method: 'exact-doorplate',
    coordinate: point.coordinate,
    normalizedAddress: address.canonical,
    matchedAddress: point.canonicalAddress,
    uncertaintyMeters: 0,
    confidence: 'high',
    datasetVersion: index.datasetVersion,
  };
}

/** Finds the closest indexed doorplate within the local 300-metre search bound. */
export function nearestDoorplate(index: DoorplateIndex, coordinate: Coordinate): LocationEvidence {
  for (const radiusM of [100, 200, 300]) {
    const candidates = neighborGridKeys(coordinate, radiusM)
      .flatMap((key) => index.cells[key] ?? [])
      .map((point) => ({ point, distance: haversineMeters(coordinate, point.coordinate) }))
      .filter((candidate) => candidate.distance <= radiusM)
      .sort((left, right) => left.distance - right.distance || comparePoints(left.point, right.point));
    const nearest = candidates[0];
    if (!nearest) continue;

    return {
      method: 'nearest-doorplate',
      coordinate: nearest.point.coordinate,
      normalizedAddress: nearest.point.canonicalAddress,
      matchedAddress: nearest.point.canonicalAddress,
      uncertaintyMeters: nearest.distance,
      confidence: 'high',
      datasetVersion: index.datasetVersion,
    };
  }

  return unresolved(index, '');
}
