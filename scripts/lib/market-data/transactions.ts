import { locateAddress } from './doorplates.ts';
import { floorGroup, normalizeOfficialBuildingType } from './property.ts';
import type {
  DoorplateIndex,
  MarketTransaction,
  NormalizedPrimaryUse,
  ParkingEvidence,
  ParkingFamily,
  RawParkingEvidence,
  TransactionEligibilityEvidence,
} from './types.ts';

export type SaleTransactionRow = Record<string, string>;

export interface TransactionNormalizationContext {
  doorplates: DoorplateIndex;
  sourceVersion: string;
}

export type TransactionNormalization =
  | { kind: 'included'; transaction: MarketTransaction }
  | { kind: 'excluded'; id: string; reasons: string[] };

type FieldName =
  | 'target'
  | 'address'
  | 'transactionDate'
  | 'floor'
  | 'totalFloors'
  | 'buildingType'
  | 'completionDate'
  | 'buildingArea'
  | 'totalPrice'
  | 'officialUnitPrice'
  | 'parkingType'
  | 'parkingArea'
  | 'parkingPrice'
  | 'primaryUse'
  | 'transactionCounts'
  | 'elevator'
  | 'notes'
  | 'id';

const HEADER_ALIASES: Record<FieldName, readonly string[]> = {
  target: ['交易標的'],
  address: ['土地位置建物門牌', '土地位置建物門牌地址'],
  transactionDate: ['交易年月日'],
  floor: ['移轉層次'],
  totalFloors: ['總樓層數'],
  buildingType: ['建物型態'],
  completionDate: ['建築完成年月', '建築完成年月日'],
  buildingArea: ['建物移轉總面積平方公尺'],
  totalPrice: ['總價元'],
  officialUnitPrice: ['單價元平方公尺', '單價元/平方公尺'],
  parkingType: ['車位類別'],
  parkingArea: ['車位移轉總面積平方公尺'],
  parkingPrice: ['車位總價元'],
  primaryUse: ['主要用途'],
  transactionCounts: ['交易筆棟數'],
  elevator: ['電梯'],
  notes: ['備註', '備註欄'],
  id: ['編號'],
};

const REQUIRED_FIELDS = Object.keys(HEADER_ALIASES) as FieldName[];
const PING_PER_SQUARE_METER = 0.3025;
const SQUARE_METERS_PER_PING = 1 / PING_PER_SQUARE_METER;

export function normalizePrimaryUse(raw: string): NormalizedPrimaryUse {
  switch (raw.normalize('NFKC').replace(/\s+/gu, '')) {
    case '住家用': return 'residential';
    case '住商用': return 'mixed-residential';
    case '辦公用': return 'office';
    case '商業用': return 'commercial';
    case '工業用': return 'industrial';
    case '住工用': return 'mixed-industrial';
    default: return 'unknown';
  }
}

export function normalizeParkingFamily(raw: string): ParkingFamily {
  const value = raw.normalize('NFKC').replace(/\s+/gu, '');
  if (value === '' || value === '無車位') return 'none';
  if (value.includes('平面')) return 'flat';
  if (value.includes('機械')) return 'mechanical';
  return 'unknown';
}

function canonicalHeader(header: string): string {
  return header.normalize('NFKC').replace(/[\s/／]/g, '');
}

function fieldValues(row: SaleTransactionRow): Map<string, string> {
  return new Map(Object.entries(row).map(([key, value]) => [canonicalHeader(key), value.trim()]));
}

function aliasValue(values: Map<string, string>, field: FieldName): string {
  for (const alias of HEADER_ALIASES[field]) {
    const value = values.get(canonicalHeader(alias));
    if (value !== undefined) return value;
  }
  return '';
}

/** Rejects schema drift before a caller attempts to normalize individual records. */
export function validateSaleTransactionHeaders(headers: Iterable<string>): void {
  const available = new Set([...headers].map(canonicalHeader));
  const missing = REQUIRED_FIELDS.filter((field) =>
    !HEADER_ALIASES[field].some((alias) => available.has(canonicalHeader(alias))),
  );
  if (missing.length > 0) {
    const labels = missing.map((field) => HEADER_ALIASES[field][0]).join('、');
    throw new Error(`Missing required transaction headers: ${labels}`);
  }
}

function finitePositive(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value.normalize('NFKC').replaceAll(',', ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isZeroOrEmpty(value: string): boolean {
  if (!value) return true;
  const parsed = Number(value.normalize('NFKC').replaceAll(',', ''));
  return Number.isFinite(parsed) && parsed === 0;
}

function chineseInteger(value: string): number | null {
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 兩: 2,
  };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1_000 };
  if (!value || !/^[零〇一二三四五六七八九十百千兩]+$/.test(value)) return null;

  let total = 0;
  let current = 0;
  for (const character of value) {
    const unit = units[character];
    if (unit) {
      total += (current || 1) * unit;
      current = 0;
    } else {
      current = digits[character]!;
    }
  }
  return total + current;
}

function floorNumber(value: string): number | null {
  const normalized = value.normalize('NFKC').trim();
  const match = /^(\d+|[零〇一二三四五六七八九十百千兩]+)層$/.exec(normalized);
  if (!match) return null;
  const number = /^\d+$/.test(match[1]!) ? Number(match[1]) : chineseInteger(match[1]!);
  return number !== null && Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Converts a valid ROC calendar date (YYYMMDD) to its ISO calendar date. */
export function rocDateToIso(raw: string): string | null {
  const normalized = raw.normalize('NFKC').trim().replace(/[^\d]/g, '');
  if (!/^\d{7}$/.test(normalized)) return null;

  const year = Number(normalized.slice(0, 3)) + 1911;
  const month = Number(normalized.slice(3, 5));
  const day = Number(normalized.slice(5, 7));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Returns only explicit non-market conditions; ambiguous marketing prose is intentionally ignored. */
export function specialTransactionFlags(notes: string): string[] {
  const normalized = notes.normalize('NFKC').replace(/\s+/g, '');
  const flags: string[] = [];
  if (/親友、員工、共有人或其他特殊關係(?:人)?間之交易|親友.*特殊關係(?:人)?間之交易/.test(normalized)) flags.push('related-party');
  if (/特殊交易|特殊情況|急售|法院拍賣/.test(normalized)) flags.push('special-disposition');
  if (/凶宅|事故屋/.test(normalized)) flags.push('accident-property');
  if (/毛胚屋|未完成建物|未完工建物/.test(normalized)) flags.push('unfinished-building');
  if (/地上權|使用權|租賃權|地役權|典權/.test(normalized)) flags.push('non-freehold');
  return flags;
}

function transferredBuildingCount(raw: string): number | null {
  const match = /(?:^|土地\d+)建物(\d+)車位\d+$/.exec(raw.normalize('NFKC').replace(/\s+/g, ''));
  return match ? Number(match[1]) : null;
}

export function classifyTransactionEligibility(
  primaryUseRaw: string,
  transactionCountsRaw: string,
  notes: string,
): TransactionEligibilityEvidence | { excludedReasons: string[] } {
  const count = transferredBuildingCount(transactionCountsRaw);
  if (/政府機關.*(?:標讓售|讓售)/u.test(notes)) return { excludedReasons: ['government-sale'] };
  const primaryUse = normalizePrimaryUse(primaryUseRaw);
  const legacyReliable = primaryUse === 'residential' && count === 1;
  return {
    eligibility: legacyReliable ? 'reliable-eligible' : 'review-only',
    reasons: legacyReliable ? [] : [
      ...(primaryUse === 'residential' ? [] : [primaryUse === 'unknown' ? 'primary-use-unavailable' : 'scenario-only-primary-use']),
      ...(count !== 1 ? ['multiple-buildings'] : []),
    ],
    primaryUse,
    transferredBuildingCount: count,
  };
}

export function classifyParkingEvidence(input: RawParkingEvidence): ParkingEvidence {
  const family = normalizeParkingFamily(input.originalType);
  const areaAvailable = input.areaSqM !== null;
  const priceAvailable = input.priceNtd !== null;
  const officialAreaPing = areaAvailable ? input.areaSqM! * PING_PER_SQUARE_METER : null;

  if (family === 'none') {
    if (!areaAvailable && !priceAvailable && input.areaWasZeroOrEmpty && input.priceWasZeroOrEmpty) {
      return {
        grade: 'A', family, originalType: input.originalType,
        officialPriceNtd: 0, officialAreaPing: 0, imputation: null, reasons: [],
      };
    }
    return {
      grade: 'C', family, originalType: input.originalType,
      officialPriceNtd: null, officialAreaPing: null, imputation: null,
      reasons: ['parking-type-conflict'],
    };
  }

  if (family === 'unknown') {
    return {
      grade: 'C', family, originalType: input.originalType,
      officialPriceNtd: null, officialAreaPing: null, imputation: null,
      reasons: ['parking-family-unavailable'],
    };
  }

  if (areaAvailable && priceAvailable) {
    return {
      grade: 'A', family, originalType: input.originalType,
      officialPriceNtd: input.priceNtd, officialAreaPing, imputation: null, reasons: [],
    };
  }

  if ((!areaAvailable && !input.areaWasZeroOrEmpty) || (!priceAvailable && !input.priceWasZeroOrEmpty)) {
    return {
      grade: 'C', family, originalType: input.originalType,
      officialPriceNtd: null, officialAreaPing: null, imputation: null,
      reasons: ['parking-numeric-invalid'],
    };
  }

  return {
    grade: 'B', family, originalType: input.originalType,
    officialPriceNtd: input.priceNtd, officialAreaPing, imputation: null,
    reasons: [
      ...(areaAvailable ? [] : ['parking-area-unavailable']),
      ...(priceAvailable ? [] : ['parking-price-unavailable']),
    ],
  };
}

/** Detects the official explanatory row without relying on its position in the CSV. */
export function isSaleTransactionDataRow(row: SaleTransactionRow): boolean {
  try {
    validateSaleTransactionHeaders(Object.keys(row));
  } catch {
    return false;
  }
  const values = fieldValues(row);
  return rocDateToIso(aliasValue(values, 'transactionDate')) !== null && finitePositive(aliasValue(values, 'totalPrice')) !== null;
}

function excluded(id: string, reason: string): TransactionNormalization {
  return { kind: 'excluded', id, reasons: [reason] };
}

/**
 * Normalizes one official Taipei sale row using only structured official fields
 * and the offline doorplate index. It performs no network access or marketing
 * text inference.
 */
export function normalizeSaleTransaction(
  row: SaleTransactionRow,
  context: TransactionNormalizationContext,
): TransactionNormalization {
  validateSaleTransactionHeaders(Object.keys(row));
  const values = fieldValues(row);
  const id = aliasValue(values, 'id');

  if (!isSaleTransactionDataRow(row)) return excluded(id, 'non-data-row');

  const target = aliasValue(values, 'target');
  if (!target.includes('建物')) return excluded(id, 'missing-building-target');

  const notes = aliasValue(values, 'notes');
  const explicitFlags = specialTransactionFlags(`${target}\n${notes}`);
  if (explicitFlags.length > 0) return { kind: 'excluded', id, reasons: explicitFlags };

  const eligibility = classifyTransactionEligibility(
    aliasValue(values, 'primaryUse'),
    aliasValue(values, 'transactionCounts'),
    notes,
  );
  if ('excludedReasons' in eligibility) return { kind: 'excluded', id, reasons: eligibility.excludedReasons };

  const buildingType = normalizeOfficialBuildingType(aliasValue(values, 'buildingType'));
  if (!buildingType) return excluded(id, 'unsupported-building-type');

  const transactionDate = rocDateToIso(aliasValue(values, 'transactionDate'));
  const buildingAreaSqM = finitePositive(aliasValue(values, 'buildingArea'));
  const totalPriceNtd = finitePositive(aliasValue(values, 'totalPrice'));
  const officialUnitPriceNtd = finitePositive(aliasValue(values, 'officialUnitPrice'));
  const floor = floorNumber(aliasValue(values, 'floor'));
  const totalFloors = floorNumber(aliasValue(values, 'totalFloors'));
  if (!transactionDate || !buildingAreaSqM || !totalPriceNtd || !officialUnitPriceNtd || !floor || !totalFloors) {
    return excluded(id, 'invalid-required-value');
  }

  const group = floorGroup(buildingType, floor, totalFloors);
  if (!group) return excluded(id, 'invalid-floor');

  const parkingType = aliasValue(values, 'parkingType');
  const parkingAreaRaw = aliasValue(values, 'parkingArea');
  const parkingPriceRaw = aliasValue(values, 'parkingPrice');
  const parkingEvidence = classifyParkingEvidence({
    originalType: parkingType,
    areaSqM: finitePositive(parkingAreaRaw),
    priceNtd: finitePositive(parkingPriceRaw),
    areaWasZeroOrEmpty: isZeroOrEmpty(parkingAreaRaw),
    priceWasZeroOrEmpty: isZeroOrEmpty(parkingPriceRaw),
    totalAreaSqM: buildingAreaSqM,
    totalPriceNtd,
  });
  const transactionEligibility = parkingEvidence.grade === 'A'
    ? eligibility
    : {
      ...eligibility,
      eligibility: 'review-only' as const,
      reasons: [...eligibility.reasons, 'parking-not-separable'],
    };

  const parkingAreaSqM = parkingEvidence.grade === 'A'
    ? parkingEvidence.officialAreaPing! * SQUARE_METERS_PER_PING
    : null;
  const parkingPriceNtd = parkingEvidence.grade === 'A' ? parkingEvidence.officialPriceNtd! : null;
  const buildingAreaSqMNet = parkingAreaSqM === null ? null : buildingAreaSqM - parkingAreaSqM;
  const buildingPriceNtd = parkingPriceNtd === null ? null : totalPriceNtd - parkingPriceNtd;
  if (buildingAreaSqMNet !== null && buildingPriceNtd !== null && (buildingAreaSqMNet <= 0 || buildingPriceNtd <= 0)) {
    return excluded(id, 'invalid-building-value');
  }

  const derivedUnitPriceNtd = buildingAreaSqMNet === null || buildingPriceNtd === null
    ? null
    : buildingPriceNtd / buildingAreaSqMNet;
  if (derivedUnitPriceNtd !== null && Math.abs(derivedUnitPriceNtd - officialUnitPriceNtd) / officialUnitPriceNtd > 0.05) {
    return excluded(id, 'unit-price-conflict');
  }

  const originalAddress = aliasValue(values, 'address');
  const location = locateAddress(context.doorplates, originalAddress);
  if (location.method === 'unresolved' || !location.coordinate) return excluded(id, 'location-unresolved');

  const district = location.normalizedAddress.match(/^[^市]+市([^區]+區)/)?.[1] ?? '';
  if (!district) return excluded(id, 'missing-district');

  const completionRaw = aliasValue(values, 'completionDate');
  const completionDate = completionRaw ? rocDateToIso(completionRaw) : null;
  if (completionRaw && !completionDate) return excluded(id, 'invalid-completion-date');

  return {
    kind: 'included',
    transaction: {
      id,
      transactionDate,
      sourceVersion: context.sourceVersion,
      originalAddress,
      location,
      district,
      ownership: 'freehold',
      buildingType,
      totalPriceNtd,
      totalAreaPing: buildingAreaSqM * PING_PER_SQUARE_METER,
      buildingPriceNtd,
      buildingAreaPing: buildingAreaSqMNet === null ? null : buildingAreaSqMNet * PING_PER_SQUARE_METER,
      parkingPriceNtd,
      parkingAreaPing: parkingEvidence.grade === 'A' ? parkingEvidence.officialAreaPing : null,
      buildingUnitPriceWan: derivedUnitPriceNtd === null ? null : derivedUnitPriceNtd * SQUARE_METERS_PER_PING / 10_000,
      parkingEvidence,
      floor,
      totalFloors,
      floorGroup: group,
      completionDate,
      notes,
      exclusionFlags: [],
      eligibility: transactionEligibility.eligibility,
      eligibilityReasons: transactionEligibility.reasons,
      originalPrimaryUse: aliasValue(values, 'primaryUse'),
      primaryUse: eligibility.primaryUse,
      transferredBuildingCount: eligibility.transferredBuildingCount,
    },
  };
}
