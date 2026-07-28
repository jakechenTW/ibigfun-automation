export interface NormalizedAddress {
  canonical: string;
  city: string | null;
  district: string | null;
  road: string | null;
  section: number | null;
  lane: number | null;
  alley: number | null;
  number: number | null;
  subNumber: number | null;
  numberRange: { min: number; max: number } | null;
}

const CHINESE_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, '○': 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 兩: 2,
};

const CHINESE_NUMBER = /^[零〇○一二三四五六七八九十百千兩]+$/;

function parseChineseNumber(token: string): number | null {
  if (!CHINESE_NUMBER.test(token)) return null;

  if (!/[十百千]/.test(token)) {
    return Number([...token].map((char) => CHINESE_DIGITS[char]).join(''));
  }

  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let current = 0;
  for (const char of token) {
    const unit = units[char];
    if (unit) {
      total += (current || 1) * unit;
      current = 0;
    } else {
      current = CHINESE_DIGITS[char];
    }
  }
  return total + current;
}

function normalizeText(input: string): string {
  const normalized = input.normalize('NFKC').replaceAll('臺', '台').replace(/\s+/g, '');
  return normalized.replace(/([零〇○一二三四五六七八九十百千兩]+)(?=(?:段|巷|弄|號|之|[~～至]))/g, (token) => {
    const parsed = parseChineseNumber(token);
    return parsed === null ? token : String(parsed);
  });
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Parse an official masked doorplate token, such as `1~30號`. */
export function parseDoorNumberRange(token: string): { min: number; max: number } | null {
  const normalized = normalizeText(token);
  const match = /^(\d+)(?:~|～|至)(\d+)號$/.exec(normalized);
  if (!match) return null;

  const min = parsePositiveNumber(match[1]);
  const max = parsePositiveNumber(match[2]);
  return min !== null && max !== null && min <= max ? { min, max } : null;
}

/** Returns the index key for a complete doorplate, excluding floor and unit suffixes. */
export function baseDoorplateKey(address: NormalizedAddress): string | null {
  if (!address.city || !address.district || !address.road || address.number === null) return null;
  return `${address.city}${address.district}${address.road}` +
    `${address.section === null ? '' : `${address.section}段`}` +
    `${address.lane === null ? '' : `${address.lane}巷`}` +
    `${address.alley === null ? '' : `${address.alley}弄`}` +
    `${address.number}號` +
    `${address.subNumber === null ? '' : `之${address.subNumber}`}`;
}

/**
 * Normalizes the address components used by the Taipei doorplate index without
 * guessing components from arbitrary marketing text.
 */
export function normalizeTaiwanAddress(input: string): NormalizedAddress {
  const canonical = normalizeText(input);
  let remainder = canonical;

  const cityMatch = /^([^市]+市)/.exec(remainder);
  const city = cityMatch?.[1] ?? null;
  if (city) remainder = remainder.slice(city.length);

  const districtMatch = /^([^區]+區)/.exec(remainder);
  const district = districtMatch?.[1] ?? null;
  if (district) remainder = remainder.slice(district.length);

  const roadMatch = /^(.+?(?:大道|路|街|道))/.exec(remainder);
  const road = roadMatch?.[1] ?? null;
  if (road) remainder = remainder.slice(road.length);

  const sectionMatch = /^(\d+)段/.exec(remainder);
  const section = parsePositiveNumber(sectionMatch?.[1]);
  if (sectionMatch) remainder = remainder.slice(sectionMatch[0].length);

  const laneMatch = /^(\d+)巷/.exec(remainder);
  const lane = parsePositiveNumber(laneMatch?.[1]);
  if (laneMatch) remainder = remainder.slice(laneMatch[0].length);

  const alleyMatch = /^(\d+)弄/.exec(remainder);
  const alley = parsePositiveNumber(alleyMatch?.[1]);
  if (alleyMatch) remainder = remainder.slice(alleyMatch[0].length);

  const numberRange = parseDoorNumberRange(remainder);
  const numberMatch = numberRange ? null : /^(\d+)(?:號(?:之(\d+))?|之(\d+)號)/.exec(remainder);
  const number = parsePositiveNumber(numberMatch?.[1]);
  const subNumber = parsePositiveNumber(numberMatch?.[2] ?? numberMatch?.[3]);

  return {
    canonical,
    city,
    district,
    road,
    section,
    lane,
    alley,
    number,
    subNumber,
    numberRange,
  };
}
