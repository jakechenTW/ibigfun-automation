/**
 * Parse the numeric value out of iBigFun's display strings.
 * Examples: "1588萬" -> 1588, "17.61坪" -> 17.61, "90.2萬/坪" -> 90.2,
 * "無車位" -> null. Pure and unit-tested.
 */

/** First number in `s` (commas stripped), or null if none. */
export function firstNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Total price in 萬 (ten-thousands), e.g. "1588萬" -> 1588. */
export const parseWan = firstNumber;
/** Ping (坪), e.g. "17.61坪" -> 17.61. */
export const parsePing = firstNumber;
/** Unit price in 萬/坪, e.g. "90.2萬/坪" -> 90.2. */
export const parseUnitPrice = firstNumber;
/** Generic number, e.g. age "49.4" -> 49.4. */
export const parseNumber = firstNumber;

/** Convert a 萬 value to NTD (×10,000), or null. */
export function wanToNtd(wan: number | null): number | null {
  return wan == null ? null : wan * 10000;
}
