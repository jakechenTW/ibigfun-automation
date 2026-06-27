/**
 * Minimal cookie jar for the browserless fetch flow. Pure + unit-tested.
 * A jar is a plain name->value map so it serializes straight to JSON.
 */
import * as fs from 'node:fs';

export type Jar = Record<string, string>;

/** Merge `Set-Cookie` header values into the jar (name=value only). */
export function applySetCookies(jar: Jar, setCookies: string[]): void {
  for (const sc of setCookies) {
    const pair = sc.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

/** Serialize the jar into a `Cookie` request header. */
export function cookieHeader(jar: Jar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** Load a persisted jar; return {} if the file is missing or unreadable. */
export function loadJar(path: string): Jar {
  try {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Jar) : {};
  } catch {
    return {};
  }
}

/** Persist the jar as pretty JSON. */
export function saveJar(path: string, jar: Jar): void {
  fs.writeFileSync(path, JSON.stringify(jar, null, 2));
}
