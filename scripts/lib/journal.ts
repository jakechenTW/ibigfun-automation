import * as fs from 'node:fs';
import { journalPath, runDir } from './runpaths.ts';

export type Level = 'info' | 'warn' | 'error';

export interface JournalEvent {
  ts: string;
  step: string;
  level: Level;
  event: string;
  msg: string;
  data?: unknown;
}

export interface Logger {
  event(level: Level, event: string, msg: string, data?: unknown): void;
}

const SECRET_KEY = /cookie|password|passwd|account|authorization|session|token|secret/i;
const SNIPPET_MAX = 500;

/** Safety net: strip secret-looking keys and cap string length before logging. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > SNIPPET_MAX ? value.slice(0, SNIPPET_MAX) + '…' : value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

export function appendJournal(date: string, ev: JournalEvent): void {
  fs.mkdirSync(runDir(date), { recursive: true });
  const safe: JournalEvent = {
    ...ev,
    data: ev.data === undefined ? undefined : redact(ev.data),
  };
  fs.appendFileSync(journalPath(date), JSON.stringify(safe) + '\n');
}

export function readJournal(date: string): JournalEvent[] {
  const p = journalPath(date);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as JournalEvent);
}

/** Logger that appends redacted events to the run journal. */
export function journalLogger(date: string, step: string, nowFn: () => string): Logger {
  return {
    event(level, event, msg, data) {
      appendJournal(date, { ts: nowFn(), step, level, event, msg, data });
    },
  };
}

/** Logger that writes to console.error — preserves standalone-CLI behavior. */
export function consoleLogger(step: string): Logger {
  return {
    event(level, _event, msg) {
      const tag = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'info';
      console.error(`${tag} ${step}: ${msg}`);
    },
  };
}
