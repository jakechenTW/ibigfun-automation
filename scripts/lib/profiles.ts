import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunRange } from './range.ts';

export interface NamedFilterValue {
  id: string;
  nameZh: string;
}

export interface ProfileFetchFilters {
  enabled: boolean;
  description?: string;
  sourceUrl?: string;
  city?: NamedFilterValue;
  towns?: NamedFilterValue[];
  houseType?: NamedFilterValue;
  priceMaxWan?: number;
  floorMin?: number;
  mainPingMin?: number;
  ageMax?: number;
  parking?: string;
}

export interface Profile {
  id: string;
  displayName: string;
  notifyTask: string;
  ruleDocPath: string;
  templatePath: string;
  requiresFilterVerification: boolean;
  fetchFilters: ProfileFetchFilters;
  hardCriteria: Record<string, unknown>;
}

export interface RunContext {
  profile: Profile;
  range: RunRange;
}

const PROFILE_DIR = 'profiles';
const PROFILE_IDS = ['investment', 'owner-occupied'] as const;

export function availableProfileIds(): string[] {
  return [...PROFILE_IDS];
}

function availableList(): string {
  return availableProfileIds().join(', ');
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1];
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid profile: ${field} must be a non-empty string`);
  }
  return value;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`invalid profile: ${field} must be a boolean`);
  }
  return value;
}

function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid profile: ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseProfile(raw: unknown): Profile {
  const o = assertObject(raw, 'root');
  const fetchFilters = assertObject(o.fetchFilters, 'fetchFilters') as unknown as ProfileFetchFilters;
  const profile: Profile = {
    id: assertString(o.id, 'id'),
    displayName: assertString(o.displayName, 'displayName'),
    notifyTask: assertString(o.notifyTask, 'notifyTask'),
    ruleDocPath: assertString(o.ruleDocPath, 'ruleDocPath'),
    templatePath: assertString(o.templatePath, 'templatePath'),
    requiresFilterVerification: assertBoolean(o.requiresFilterVerification, 'requiresFilterVerification'),
    fetchFilters,
    hardCriteria: assertObject(o.hardCriteria, 'hardCriteria'),
  };
  if (typeof profile.fetchFilters.enabled !== 'boolean') {
    throw new Error('invalid profile: fetchFilters.enabled must be a boolean');
  }
  return profile;
}

export function loadProfile(id: string): Profile {
  if (!PROFILE_IDS.includes(id as any)) {
    throw new Error(`unknown profile "${id}"; available profiles: ${availableList()}`);
  }
  const file = path.join(PROFILE_DIR, `${id}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`failed to read profile "${id}": ${(e as Error).message}`);
  }
  const profile = parseProfile(parsed);
  if (profile.id !== id) {
    throw new Error(`invalid profile: file ${file} has id "${profile.id}"`);
  }
  for (const ref of [profile.ruleDocPath, profile.templatePath]) {
    if (!fs.existsSync(ref)) {
      throw new Error(`invalid profile "${id}": referenced file not found: ${ref}`);
    }
  }
  return profile;
}

export function resolveProfileFromArgs(argv: string[]): Profile {
  const id = flagValue(argv, '--profile');
  if (!id || id.startsWith('--')) {
    throw new Error(`--profile is required; available profiles: ${availableList()}`);
  }
  return loadProfile(id);
}

export function profileFlags(profile: Pick<Profile, 'id'>): string {
  return `--profile ${profile.id}`;
}
