/**
 * Date helpers for the iBigFun monitor.
 *
 * The report targets the previous calendar day in Asia/Taipei (UTC+8, no DST),
 * per the "Report Date" rule in AGENTS.md. These functions are pure so they can
 * be unit-tested without a clock or a browser.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) of `now` as seen in Asia/Taipei. */
export function taipeiDateString(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Previous calendar day in Asia/Taipei, as YYYY-MM-DD. */
export function previousTaipeiDay(now: Date): string {
  const [y, m, d] = taipeiDateString(now).split('-').map(Number);
  // Treat the Taipei calendar date as a UTC midnight, then step back one day.
  // Pure calendar arithmetic — timezone offset/DST never enters in.
  const prev = new Date(Date.UTC(y, m - 1, d) - DAY_MS);
  return prev.toISOString().slice(0, 10);
}

/** True only for a real, zero-padded YYYY-MM-DD date. */
export function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** Whole calendar days from `fromYMD` to `toYMD` (negative if reversed). */
export function daysBetween(fromYMD: string, toYMD: string): number {
  const [fy, fm, fd] = fromYMD.split('-').map(Number);
  const [ty, tm, td] = toYMD.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS);
}
