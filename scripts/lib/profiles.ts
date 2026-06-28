import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunRange } from './range.ts';
import type { FetchMap, FetchValue } from './api.ts';

export interface Profile {
  id: string;
  displayName: string;
  fetch: FetchMap;
}

export interface RunContext {
  profile: Profile;
  range: RunRange;
}

const PROFILE_DIR = 'profiles';

/** Folder names under profiles/ that contain a profile.json, sorted. */
export function availableProfileIds(): string[] {
  if (!fs.existsSync(PROFILE_DIR)) return [];
  return fs
    .readdirSync(PROFILE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PROFILE_DIR, d.name, 'profile.json')))
    .map((d) => d.name)
    .sort();
}

function availableList(): string {
  return availableProfileIds().join(', ');
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1];
}

/** Collect repeated `--set k=v` / `--unset k` flags in argv order. */
function collectFlags(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] != null) out.push(argv[i + 1]);
    else if (argv[i].startsWith(`${name}=`)) out.push(argv[i].slice(name.length + 1));
  }
  return out;
}

function fetchPath(raw: string): string[] {
  if (!raw.startsWith('fetch.')) {
    throw new Error('--set/--unset paths must start with "fetch." (e.g. --set fetch.price_segment.max=3000)');
  }
  return raw.slice('fetch.'.length).split('.');
}

function parseValue(v: string): string | string[] {
  return v.includes(',') ? v.split(',') : v;
}

/** Apply ad-hoc --set fetch.* / --unset fetch.* overrides to a fetch map.
 *  Pure: returns a deep-cloned, modified copy. */
export function applyFetchOverrides(fetch: FetchMap, argv: string[]): FetchMap {
  const out: FetchMap = JSON.parse(JSON.stringify(fetch));
  for (const raw of collectFlags(argv, '--unset')) {
    const [head, sub] = fetchPath(raw);
    if (sub == null) delete out[head];
    else if (out[head] && typeof out[head] === 'object' && !Array.isArray(out[head])) {
      delete (out[head] as Record<string, unknown>)[sub];
    }
  }
  for (const raw of collectFlags(argv, '--set')) {
    const eq = raw.indexOf('=');
    if (eq === -1) throw new Error(`--set needs key=value, got "${raw}"`);
    const [head, sub] = fetchPath(raw.slice(0, eq));
    const value = parseValue(raw.slice(eq + 1));
    if (sub == null) {
      out[head] = value;
    } else {
      const cur = out[head];
      const base = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>) : {};
      out[head] = { ...base, [sub]: value } as FetchValue;
    }
  }
  return out;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid profile: ${field} must be a non-empty string`);
  }
  return value;
}

function assertFetch(value: unknown): FetchMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid profile: fetch must be an object');
  }
  return value as FetchMap;
}

export function loadProfile(id: string): Profile {
  const dir = path.join(PROFILE_DIR, id);
  const file = path.join(dir, 'profile.json');
  if (!fs.existsSync(file)) {
    throw new Error(`unknown profile "${id}"; available profiles: ${availableList()}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`failed to read profile "${id}": ${(e as Error).message}`);
  }
  const o = parsed as Record<string, unknown>;
  const profile: Profile = {
    id,
    displayName: assertString(o.displayName, 'displayName'),
    fetch: assertFetch(o.fetch),
  };
  for (const f of ['evaluation.md', 'notify-template.md']) {
    if (!fs.existsSync(path.join(dir, f))) {
      throw new Error(`invalid profile "${id}": missing ${f}`);
    }
  }
  return profile;
}

export function resolveProfileFromArgs(argv: string[]): Profile {
  const id = flagValue(argv, '--profile');
  if (!id || id.startsWith('--')) {
    throw new Error(`--profile is required; available profiles: ${availableList()}`);
  }
  const profile = loadProfile(id);
  return { ...profile, fetch: applyFetchOverrides(profile.fetch, argv) };
}

export function profileFlags(profile: Pick<Profile, 'id'>): string {
  return `--profile ${profile.id}`;
}
