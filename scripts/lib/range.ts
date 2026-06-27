/**
 * Range resolution for the daily monitor CLIs. A run covers an inclusive date
 * range [from, to]; a single day is the range [d, d]. Pure (clock injected) so
 * it unit-tests offline. Throws Error(message) on bad input; each CLI maps that
 * to its own exit convention.
 */
import { isValidDateString, previousTaipeiDay, rangeLabel, daysBetween } from './date.ts';

export interface RunRange {
  from: string;
  to: string;
  label: string;
}

function flagPresent(argv: string[], name: string): boolean {
  return argv.some((a) => a === name || a.startsWith(`${name}=`));
}
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1];
}
function requireDate(raw: string | undefined, label: string): string {
  if (raw === undefined || raw.startsWith('--') || !isValidDateString(raw)) {
    throw new Error(`invalid ${label} "${raw ?? ''}"; expected YYYY-MM-DD.`);
  }
  return raw;
}

/**
 * Resolve --date / --from/--to into a RunRange.
 *  - --date <d>           → [d, d]   (shorthand for a single day)
 *  - --from <a> --to <b>  → [a, b], requires a <= b
 *  - none                 → [previousTaipeiDay, previousTaipeiDay]
 *  - --date with --from/--to, or only one of --from/--to → error
 */
export function resolveRange(argv: string[], now: Date): RunRange {
  const hasDate = flagPresent(argv, '--date');
  const hasFrom = flagPresent(argv, '--from');
  const hasTo = flagPresent(argv, '--to');

  if (hasDate && (hasFrom || hasTo)) {
    throw new Error('use --date alone, or --from/--to together (not both).');
  }
  if (hasFrom !== hasTo) {
    throw new Error('a range needs both --from and --to.');
  }

  if (hasDate) {
    const d = requireDate(flagValue(argv, '--date'), '--date');
    return { from: d, to: d, label: rangeLabel(d, d) };
  }
  if (hasFrom) {
    const from = requireDate(flagValue(argv, '--from'), '--from');
    const to = requireDate(flagValue(argv, '--to'), '--to');
    if (daysBetween(from, to) < 0) {
      throw new Error(`--from ${from} is after --to ${to}.`);
    }
    return { from, to, label: rangeLabel(from, to) };
  }
  const d = previousTaipeiDay(now);
  return { from: d, to: d, label: rangeLabel(d, d) };
}

/** CLI flags that reproduce a range: --date for a single day, else --from/--to. */
export function rangeFlags(r: RunRange): string {
  return r.from === r.to ? `--date ${r.from}` : `--from ${r.from} --to ${r.to}`;
}
