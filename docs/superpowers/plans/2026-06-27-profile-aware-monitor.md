# Profile-Aware Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make iBigFun monitoring profile-aware so each run explicitly uses one profile and stores artifacts under `state/runs/<profile>/<label>/`.

**Architecture:** Add a small profile registry/loader, thread the loaded profile through run context, and keep the current fetch -> enrich -> agent report -> notify pipeline. Profile JSON owns machine-readable metadata and future fetch filters; profile docs/templates own agent-facing report rules.

**Tech Stack:** Node.js, TypeScript ESM, `node:test`, JSON profile files, Markdown docs/templates.

---

## File Structure

- Create `scripts/lib/profiles.ts`: profile types, profile id parsing, profile loading, referenced-file validation, and run-context construction.
- Create `scripts/lib/profiles.test.ts`: profile loader and CLI flag tests.
- Create `profiles/investment.json`: current investment profile metadata.
- Create `profiles/owner-occupied.json`: self-use profile metadata and URL-derived filters, with coded mappings marked unverified.
- Create `docs/profiles/investment.md`: investment-specific rules moved out of generic framing.
- Create `docs/profiles/owner-occupied.md`: self-use rules and notification behavior.
- Create `templates/investment-notify-template.md`: copy of the current investment notification template.
- Create `templates/owner-occupied-notify-template.md`: compact self-use notification template.
- Modify `scripts/lib/runpaths.ts` and `scripts/lib/runpaths.test.ts`: profile-scoped artifact paths.
- Modify `scripts/lib/manifest.ts` and `scripts/lib/manifest.test.ts`: persist `profileId` and read/write manifests through profile-scoped paths.
- Modify `scripts/lib/journal.ts`, `scripts/lib/journal.test.ts`, `scripts/lib/run.ts`, and `scripts/lib/run.test.ts`: profile-scoped journal paths via manifest profile id.
- Modify `scripts/lib/steps.ts`, `scripts/fetch.ts`, and `scripts/enrich.ts`: require `--profile`, load profile, use profile-scoped paths.
- Modify `scripts/lib/notify.ts` and `scripts/lib/notify.test.ts`: use profile-specific `notifyTask`.
- Modify `scripts/pipeline.ts`: require profile, include profile docs/templates in report-step instructions, and use profile-scoped paths.
- Modify `package.json`: add `scripts/lib/profiles.test.ts` to `npm test`.
- Modify `AGENTS.md`, `README.md`, `docs/reporting-rules.md`, `docs/fetching.md`, and `prompts/daily-run.md`: document profile-aware operation.

## Global Constraints

- Do not enable profile-driven fetch filters in this implementation. `fetchFilters.enabled` exists but is `false` for both committed profiles.
- Keep `buildSearchBody(from, to, page)` behavior unchanged. Existing `api.test.ts` must remain green.
- Missing or unknown `--profile` is a bad input error with exit code 2.
- Validate profile docs/templates before any network call or artifact write.
- Existing generated `state/` data is git-ignored; tests must clean their throwaway run directories.

### Task 1: Profile Loader And Profile Files

**Files:**
- Create: `scripts/lib/profiles.ts`
- Create: `scripts/lib/profiles.test.ts`
- Create: `profiles/investment.json`
- Create: `profiles/owner-occupied.json`
- Create: `docs/profiles/investment.md`
- Create: `docs/profiles/owner-occupied.md`
- Create: `templates/investment-notify-template.md`
- Create: `templates/owner-occupied-notify-template.md`
- Modify: `package.json`

- [ ] **Step 1: Add the failing profile loader tests**

Create `scripts/lib/profiles.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableProfileIds,
  loadProfile,
  resolveProfileFromArgs,
  profileFlags,
  type Profile,
} from './profiles.ts';

test('availableProfileIds lists committed profiles in stable order', () => {
  assert.deepEqual(availableProfileIds(), ['investment', 'owner-occupied']);
});

test('loadProfile validates and returns investment metadata', () => {
  const p = loadProfile('investment');
  assert.equal(p.id, 'investment');
  assert.equal(p.displayName, 'iBigFun 投資房源監測');
  assert.equal(p.notifyTask, '每日 iBigFun 投資房源監測');
  assert.equal(p.ruleDocPath, 'docs/profiles/investment.md');
  assert.equal(p.templatePath, 'templates/investment-notify-template.md');
  assert.equal(p.fetchFilters.enabled, false);
});

test('loadProfile keeps owner-occupied coded filters readable and unverified', () => {
  const p = loadProfile('owner-occupied');
  assert.equal(p.id, 'owner-occupied');
  assert.equal(p.requiresFilterVerification, true);
  assert.equal(p.fetchFilters.enabled, false);
  assert.equal(p.fetchFilters.city?.nameZh, '台北市');
  assert.deepEqual(p.fetchFilters.towns?.map((t) => t.id), ['1', '4', '6', '8', '9']);
  assert.ok(p.fetchFilters.towns?.every((t) => t.nameZh === '待驗證'));
  assert.equal(p.fetchFilters.houseType?.id, '17');
  assert.equal(p.fetchFilters.priceMaxWan, 7000);
  assert.equal(p.fetchFilters.floorMin, 7);
  assert.equal(p.fetchFilters.mainPingMin, 30);
  assert.equal(p.fetchFilters.ageMax, 25);
  assert.equal(p.fetchFilters.parking, '平面');
});

test('loadProfile rejects an unknown id with available ids', () => {
  assert.throws(
    () => loadProfile('missing'),
    /unknown profile "missing"; available profiles: investment, owner-occupied/,
  );
});

test('resolveProfileFromArgs requires --profile', () => {
  assert.throws(
    () => resolveProfileFromArgs(['--date', '2026-06-26']),
    /--profile is required; available profiles: investment, owner-occupied/,
  );
});

test('resolveProfileFromArgs accepts --profile value and --profile=value', () => {
  assert.equal(resolveProfileFromArgs(['--profile', 'investment']).id, 'investment');
  assert.equal(resolveProfileFromArgs(['--profile=owner-occupied']).id, 'owner-occupied');
});

test('resolveProfileFromArgs rejects a missing flag value', () => {
  assert.throws(
    () => resolveProfileFromArgs(['--profile', '--date', '2026-06-26']),
    /--profile is required; available profiles: investment, owner-occupied/,
  );
});

test('profileFlags reproduces the selected profile flag', () => {
  const p = { id: 'owner-occupied' } as Profile;
  assert.equal(profileFlags(p), '--profile owner-occupied');
});
```

- [ ] **Step 2: Add the test file to `package.json`**

In `package.json`, append `scripts/lib/profiles.test.ts` to the `test` script after `scripts/lib/runpaths.test.ts`:

```json
"test": "node --import tsx --test scripts/lib/date.test.ts scripts/lib/parse.test.ts scripts/lib/geo.test.ts scripts/lib/finance.test.ts scripts/lib/exclude.test.ts scripts/lib/mrt.test.ts scripts/lib/districts.test.ts scripts/lib/enrich-offline.test.ts scripts/lib/walk.test.ts scripts/lib/history.test.ts scripts/lib/relogin.test.ts scripts/lib/tenure.test.ts scripts/lib/cookies.test.ts scripts/lib/api.test.ts scripts/lib/map.test.ts scripts/lib/http.test.ts scripts/lib/extract.test.ts scripts/lib/manifest.test.ts scripts/lib/journal.test.ts scripts/lib/run.test.ts scripts/lib/notify.test.ts scripts/lib/range.test.ts scripts/lib/runpaths.test.ts scripts/lib/profiles.test.ts"
```

- [ ] **Step 3: Run the new test and confirm it fails**

Run: `node --import tsx --test scripts/lib/profiles.test.ts`

Expected: FAIL with an import error for `./profiles.ts`.

- [ ] **Step 4: Create profile JSON files**

Create `profiles/investment.json`:

```json
{
  "id": "investment",
  "displayName": "iBigFun 投資房源監測",
  "notifyTask": "每日 iBigFun 投資房源監測",
  "ruleDocPath": "docs/profiles/investment.md",
  "templatePath": "templates/investment-notify-template.md",
  "requiresFilterVerification": false,
  "fetchFilters": {
    "enabled": false,
    "description": "Uses the existing captured investment search request shape in scripts/lib/api.ts."
  },
  "hardCriteria": {
    "profile": "investment"
  }
}
```

Create `profiles/owner-occupied.json`:

```json
{
  "id": "owner-occupied",
  "displayName": "iBigFun 自住房源監測",
  "notifyTask": "每日 iBigFun 自住房源監測",
  "ruleDocPath": "docs/profiles/owner-occupied.md",
  "templatePath": "templates/owner-occupied-notify-template.md",
  "requiresFilterVerification": true,
  "fetchFilters": {
    "enabled": false,
    "sourceUrl": "https://www.ibigfun.com/lists/latest?page=1&expand=0&method=all_case&on_market=1&city=1&town=1%2C4%2C6%2C8%2C9&price_segment=%2C7000&house_type=17&floor_segment=7%2C&main_ping_number=30%2C&house_age_segment=%2C25&parking=%E5%B9%B3%E9%9D%A2",
    "city": { "id": "1", "nameZh": "台北市" },
    "towns": [
      { "id": "1", "nameZh": "待驗證" },
      { "id": "4", "nameZh": "待驗證" },
      { "id": "6", "nameZh": "待驗證" },
      { "id": "8", "nameZh": "待驗證" },
      { "id": "9", "nameZh": "待驗證" }
    ],
    "houseType": { "id": "17", "nameZh": "待驗證" },
    "priceMaxWan": 7000,
    "floorMin": 7,
    "mainPingMin": 30,
    "ageMax": 25,
    "parking": "平面"
  },
  "hardCriteria": {
    "priceMaxWan": 7000,
    "floorMin": 7,
    "mainPingMin": 30,
    "ageMax": 25,
    "parkingIncludes": "平面"
  }
}
```

- [ ] **Step 5: Create profile docs**

Create `docs/profiles/investment.md`:

```md
# Investment Profile

Use this profile for rental-yield-oriented investment screening.

## Criteria

- Mortgage assumption: 80% loan-to-value, 2.6% annual interest, 30-year principal and interest repayment.
- Recommended listing: below market by at least 10% and rent coverage at least 1.0.
- Near-threshold listing: rent coverage at least 0.8.
- Market discount percentage: `(market_unit_price - listing_unit_price) / market_unit_price * 100`.
- Rent coverage: `estimated_monthly_rent / monthly_mortgage_payment`.

## Estimation

- Prefer iBigFun real-price data when available.
- Otherwise use comparable transactions matched on area, age, floor, and property type.
- If only stale, weak, timed-out, or cross-site data is available, do not label the listing recommended.
- Estimate rent from comparable rental listings for the same area and property type.

## Report Buckets

- `推薦物件`: meets discount and rent-coverage thresholds with usable data.
- `接近門檻候選`: rent coverage is at least 0.8 or the listing is promising but needs manual confirmation.
- `前置排除`: objective reliable walking-distance exclusion.
- `可疑/待查`: suspicious or likely-auction listings that should be down-ranked.
- `目標日排除物件`: remaining listings worth summarizing under the investment rules.
```

Create `docs/profiles/owner-occupied.md`:

```md
# Owner-Occupied Profile

Use this profile for self-use screening. The goal is to notify on homes worth personally reviewing, not to estimate rental yield.

## Source Filter

The first profile version is based on this saved iBigFun URL:

`https://www.ibigfun.com/lists/latest?page=1&expand=0&method=all_case&on_market=1&city=1&town=1%2C4%2C6%2C8%2C9&price_segment=%2C7000&house_type=17&floor_segment=7%2C&main_ping_number=30%2C&house_age_segment=%2C25&parking=%E5%B9%B3%E9%9D%A2`

The numeric `town` and `house_type` mappings are not considered verified until `profiles/owner-occupied.json` replaces `待驗證` with names confirmed from iBigFun.

## Hard Criteria

- City: 台北市.
- District ids: `1`, `4`, `6`, `8`, `9`; names require verification.
- Total price: <= 7000 萬.
- Floor: >= 7.
- Main ping: >= 30.
- Age: <= 25 years.
- Parking: includes `平面`.

Room, living-room, and bathroom counts are displayed but are not hard criteria in this first profile.

## Agent Judgment

- Put strong matches in `符合條件`.
- Put close matches or listings with missing fields in `候選/需確認`.
- Summarize exclusions by count and main reason instead of listing every excluded property.
- Treat suspicious, likely-auction, low-information, or blocked-detail listings as risk notes or exclusion reasons.
- Walking distance is a preference and sorting signal, not a hard exclusion, unless this profile later adds an explicit walking threshold.

## Notification Status

- Use `warn` when there is any match, candidate, manual review, stale data, or unverified coded filter mapping.
- Use `ok` only when there are no matches or candidates and coded filter mappings are verified.
- Use `fail` only when the monitor cannot complete.
```

- [ ] **Step 6: Create profile templates**

Copy `templates/daily-notify-template.md` to `templates/investment-notify-template.md` unchanged.

Create `templates/owner-occupied-notify-template.md`:

```md
## iBigFun 每日自住房源監測 - {{date}}

**結論：{{conclusion}}**

### 快速摘要

- Profile：owner-occupied
- 新刊登物件：{{new_listing_count}} 筆
- 符合條件：{{matched_count}} 筆
- 候選/需確認：{{candidate_count}} 筆
- 排除：{{excluded_count}} 筆
- 主要排除原因：{{main_exclusion_reasons}}
- Filter 對照狀態：{{filter_verification_status}}
- 自住條件：總價 <= 7000 萬、7 樓以上、主建物 >= 30 坪、屋齡 <= 25 年、平面車位

### 符合條件

{{#if matched}}

{{#each matched}}

#### {{rank}}. [{{title}}]({{url}}) ｜ {{match_summary}}

- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
- 亮點：{{strengths}}
- 需確認：{{manual_checks}}

{{/each}}

{{else}}

- 無符合自住條件且值得立即查看的物件。

{{/if}}

### 候選/需確認

{{#if candidates}}

{{#each candidates}}

#### {{rank}}. [{{title}}]({{url}}) ｜ {{candidate_reason}}

- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
- 需確認：{{manual_checks}}

{{/each}}

{{else}}

- 無候選物件。

{{/if}}

### 排除摘要

- 排除筆數：{{excluded_count}} 筆
- 主要原因：{{main_exclusion_reasons}}

### 規則來源

- Profile config：`profiles/owner-occupied.json`
- Profile rules：`docs/profiles/owner-occupied.md`
- 共通規則：`docs/reporting-rules.md`
```

- [ ] **Step 7: Implement `scripts/lib/profiles.ts`**

Create `scripts/lib/profiles.ts`:

```ts
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
```

- [ ] **Step 8: Run the new profile tests**

Run: `node --import tsx --test scripts/lib/profiles.test.ts`

Expected: PASS.

- [ ] **Step 9: Run the full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 10: Commit Task 1**

```bash
git add package.json scripts/lib/profiles.ts scripts/lib/profiles.test.ts profiles/investment.json profiles/owner-occupied.json docs/profiles/investment.md docs/profiles/owner-occupied.md templates/investment-notify-template.md templates/owner-occupied-notify-template.md
git commit -m "feat: add monitor profiles"
```

### Task 2: Profile-Scoped Run Paths

**Files:**
- Modify: `scripts/lib/runpaths.ts`
- Modify: `scripts/lib/runpaths.test.ts`

- [ ] **Step 1: Replace run path tests with profile-scoped expectations**

Replace `scripts/lib/runpaths.test.ts` with:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDir, manifestPath, journalPath, listingsPath, enrichedPath, reportPath } from './runpaths.ts';

test('all run paths resolve under state/runs/<profile>/<label>/ for a single-day label', () => {
  const P = 'owner-occupied';
  const L = '2026-06-26';
  assert.equal(runDir(P, L), 'state/runs/owner-occupied/2026-06-26');
  assert.equal(manifestPath(P, L), 'state/runs/owner-occupied/2026-06-26/manifest.json');
  assert.equal(journalPath(P, L), 'state/runs/owner-occupied/2026-06-26/journal.jsonl');
  assert.equal(listingsPath(P, L), 'state/runs/owner-occupied/2026-06-26/listings.json');
  assert.equal(enrichedPath(P, L), 'state/runs/owner-occupied/2026-06-26/enriched.json');
  assert.equal(reportPath(P, L), 'state/runs/owner-occupied/2026-06-26/report.md');
});

test('all run paths resolve under state/runs/<profile>/<label>/ for a range label', () => {
  const P = 'investment';
  const L = '2026-06-20_2026-06-25';
  assert.equal(listingsPath(P, L), 'state/runs/investment/2026-06-20_2026-06-25/listings.json');
  assert.equal(enrichedPath(P, L), 'state/runs/investment/2026-06-20_2026-06-25/enriched.json');
  assert.equal(reportPath(P, L), 'state/runs/investment/2026-06-20_2026-06-25/report.md');
});
```

- [ ] **Step 2: Run the path test and confirm it fails**

Run: `node --import tsx --test scripts/lib/runpaths.test.ts`

Expected: FAIL with function arity or path mismatch errors.

- [ ] **Step 3: Update `scripts/lib/runpaths.ts`**

Replace `scripts/lib/runpaths.ts` with:

```ts
import * as path from 'node:path';

/** Per-run directory: state/runs/<profile>/<label>/ (under git-ignored state/). */
export function runDir(profileId: string, label: string): string {
  return path.join('state', 'runs', profileId, label);
}
export function manifestPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'manifest.json');
}
export function journalPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'journal.jsonl');
}
export function listingsPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'listings.json');
}
export function enrichedPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'enriched.json');
}
export function reportPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'report.md');
}
```

- [ ] **Step 4: Run the path test**

Run: `node --import tsx --test scripts/lib/runpaths.test.ts`

Expected: PASS.

- [ ] **Step 5: Run TypeScript to expose downstream call sites**

Run: `npx tsc --noEmit`

Expected: FAIL with call sites still passing only `label` to run path helpers. Those are fixed in later tasks.

- [ ] **Step 6: Commit Task 2**

```bash
git add scripts/lib/runpaths.ts scripts/lib/runpaths.test.ts
git commit -m "feat: scope run paths by profile"
```

### Task 3: Manifest And Journal Profile Scope

**Files:**
- Modify: `scripts/lib/manifest.ts`
- Modify: `scripts/lib/manifest.test.ts`
- Modify: `scripts/lib/journal.ts`
- Modify: `scripts/lib/journal.test.ts`
- Modify: `scripts/lib/run.ts`
- Modify: `scripts/lib/run.test.ts`

- [ ] **Step 1: Update manifest tests for `profileId`**

In `scripts/lib/manifest.test.ts`, change `createManifest` calls to include a profile id and replace cleanup paths. The first test should start:

```ts
test('createManifest seeds all four steps as pending with correct kinds', () => {
  const m = createManifest('investment', '2026-06-26', '2026-06-26', '2026-06-27T00:00:00.000Z');
  assert.deepEqual(STEP_ORDER, ['fetch', 'enrich', 'report', 'notify']);
  assert.equal(m.profileId, 'investment');
  assert.equal(m.from, '2026-06-26');
  assert.equal(m.to, '2026-06-26');
```

Update the write/read test body to:

```ts
const profileId = 'investment';
const date = '0004-04-04';
try {
  const m = createManifest(profileId, date, date, '2026-06-27T00:00:00.000Z');
  setStep(m, 'fetch', { status: 'ok', summary: { listings: 5 } });
  writeManifest(m, '2026-06-27T00:01:00.000Z');
  const back = readManifest(profileId, date);
  assert.equal(back!.profileId, profileId);
  assert.equal(back!.from, date);
  assert.equal(back!.to, date);
  assert.equal(back!.updatedAt, '2026-06-27T00:01:00.000Z');
  assert.equal(back!.steps.fetch.status, 'ok');
  assert.deepEqual(back!.steps.fetch.summary, { listings: 5 });
  assert.equal(fs.existsSync(`state/runs/${profileId}/${date}/manifest.json.tmp`), false);
} finally {
  fs.rmSync(runDir(profileId, date), { recursive: true, force: true });
}
```

Replace the multi-day test with:

```ts
test('a multi-day range writes under a profile/from_to label and round-trips', () => {
  const profileId = 'owner-occupied';
  const from = '0004-04-04', to = '0004-04-06', label = '0004-04-04_0004-04-06';
  try {
    const m = createManifest(profileId, from, to, '2026-06-27T00:00:00.000Z');
    writeManifest(m, '2026-06-27T00:01:00.000Z');
    assert.ok(fs.existsSync(`state/runs/${profileId}/${label}/manifest.json`));
    const back = readManifest(profileId, label);
    assert.equal(back!.profileId, profileId);
    assert.equal(back!.from, from);
    assert.equal(back!.to, to);
  } finally {
    fs.rmSync(runDir(profileId, label), { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Update journal tests for profile-scoped journals**

In `scripts/lib/journal.test.ts`, update the round-trip test body to:

```ts
const profileId = 'investment';
const date = '0002-02-02';
try {
  appendJournal(profileId, date, { ts: 't1', step: 'fetch', level: 'info', event: 'step.start', msg: 'go' });
  appendJournal(profileId, date, { ts: 't2', step: 'fetch', level: 'error', event: 'history.drop',
    msg: 'boom', data: { cookie: 'secret', listingId: 5 } });
  const evs = readJournal(profileId, date);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].event, 'step.start');
  assert.deepEqual(evs[1].data, { cookie: '[redacted]', listingId: 5 });
} finally {
  fs.rmSync(runDir(profileId, date), { recursive: true, force: true });
}
```

Update the long-message test the same way with `profileId = 'owner-occupied'`.

- [ ] **Step 3: Run focused tests and confirm failures**

Run: `node --import tsx --test scripts/lib/manifest.test.ts scripts/lib/journal.test.ts`

Expected: FAIL because implementation signatures still use label-only paths.

- [ ] **Step 4: Update `scripts/lib/manifest.ts`**

Change the interfaces and functions as follows:

```ts
export interface Manifest {
  profileId: string;
  from: string;
  to: string;
  createdAt: string;
  updatedAt: string;
  notify: NotifyParams | null;
  steps: Record<StepName, StepState>;
  failure: { reason: string; where: string } | null;
}

export function createManifest(profileId: string, from: string, to: string, now: string): Manifest {
  return {
    profileId, from, to, createdAt: now, updatedAt: now, notify: null, failure: null,
    steps: {
      fetch: emptyStep('script'), enrich: emptyStep('script'),
      report: emptyStep('agent'), notify: emptyStep('script'),
    },
  };
}

export function readManifest(profileId: string, label: string): Manifest | null {
  const p = manifestPath(profileId, label);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest;
}

export function writeManifest(m: Manifest, now: string): void {
  m.updatedAt = now;
  const label = rangeLabel(m.from, m.to);
  fs.mkdirSync(runDir(m.profileId, label), { recursive: true });
  const final = manifestPath(m.profileId, label);
  const tmp = final + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, final);
}

export function loadOrCreateManifest(profileId: string, from: string, to: string, now: string): Manifest {
  return readManifest(profileId, rangeLabel(from, to)) ?? createManifest(profileId, from, to, now);
}
```

- [ ] **Step 5: Update `scripts/lib/journal.ts`**

Change journal functions to accept profile id and label:

```ts
export function appendJournal(profileId: string, label: string, ev: JournalEvent): void {
  fs.mkdirSync(runDir(profileId, label), { recursive: true });
  const msg = ev.msg.length > SNIPPET_MAX ? ev.msg.slice(0, SNIPPET_MAX) + '…' : ev.msg;
  const safe: JournalEvent = {
    ...ev,
    msg,
    data: ev.data === undefined ? undefined : redact(ev.data),
  };
  fs.appendFileSync(journalPath(profileId, label), JSON.stringify(safe) + '\n');
}

export function readJournal(profileId: string, label: string): JournalEvent[] {
  const p = journalPath(profileId, label);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as JournalEvent);
}

export function journalLogger(profileId: string, label: string, step: string, nowFn: () => string): Logger {
  return {
    event(level, event, msg, data) {
      appendJournal(profileId, label, { ts: nowFn(), step, level, event, msg, data });
    },
  };
}
```

- [ ] **Step 6: Update `scripts/lib/run.ts`**

Change the logger creation inside `runStep`:

```ts
const logger = journalLogger(m.profileId, rangeLabel(m.from, m.to), name, now);
```

- [ ] **Step 7: Replace `scripts/lib/run.test.ts`**

Replace `scripts/lib/run.test.ts` with:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createManifest } from './manifest.ts';
import { readJournal } from './journal.ts';
import { runDir } from './runpaths.ts';
import { runStep } from './run.ts';

// Deterministic clock: returns a new ISO timestamp each call, 1s apart.
function fakeClock() {
  let t = Date.parse('2026-06-27T00:00:00.000Z');
  return () => { const s = new Date(t).toISOString(); t += 1000; return s; };
}

test('runStep marks ok, records summary/artifacts, journals start+end', async () => {
  const profileId = 'investment';
  const date = '0003-03-03';
  try {
    const m = createManifest(profileId, date, date, 'seed');
    const status = await runStep(m, 'fetch',
      async () => ({
        summary: { listings: 3 },
        artifacts: [`state/runs/${profileId}/${date}/listings.json`],
      }),
      fakeClock());
    assert.equal(status, 'ok');
    assert.equal(m.steps.fetch.status, 'ok');
    assert.equal(m.steps.fetch.attempt, 1);
    assert.deepEqual(m.steps.fetch.summary, { listings: 3 });
    assert.deepEqual(m.steps.fetch.artifacts, [`state/runs/${profileId}/${date}/listings.json`]);
    assert.equal(typeof m.steps.fetch.durationMs, 'number');
    const events = readJournal(profileId, date).map((e) => e.event);
    assert.ok(events.includes('step.start'));
    assert.ok(events.includes('step.end'));
  } finally {
    fs.rmSync(runDir(profileId, date), { recursive: true, force: true });
  }
});

test('runStep marks failed and captures the error on throw', async () => {
  const profileId = 'owner-occupied';
  const date = '0003-03-04';
  try {
    const m = createManifest(profileId, date, date, 'seed');
    const status = await runStep(m, 'enrich',
      async () => { throw new Error('ORS exploded'); },
      fakeClock());
    assert.equal(status, 'failed');
    assert.equal(m.steps.enrich.status, 'failed');
    assert.equal(m.steps.enrich.error!.message, 'ORS exploded');
    assert.equal(m.steps.enrich.error!.where, 'enrich');
    const events = readJournal(profileId, date).map((e) => e.event);
    assert.ok(events.includes('step.error'));
  } finally {
    fs.rmSync(runDir(profileId, date), { recursive: true, force: true });
  }
});
```

- [ ] **Step 8: Run focused tests**

Run: `node --import tsx --test scripts/lib/manifest.test.ts scripts/lib/journal.test.ts scripts/lib/run.test.ts`

Expected: PASS.

- [ ] **Step 9: Run TypeScript to identify remaining path call sites**

Run: `npx tsc --noEmit`

Expected: FAIL in `steps.ts`, `fetch.ts`, `enrich.ts`, `pipeline.ts`, and notify/pipeline call sites that have not yet been profile-wired.

- [ ] **Step 10: Commit Task 3**

```bash
git add scripts/lib/manifest.ts scripts/lib/manifest.test.ts scripts/lib/journal.ts scripts/lib/journal.test.ts scripts/lib/run.ts scripts/lib/run.test.ts
git commit -m "feat: persist profile in run manifests and journals"
```

### Task 4: Profile-Aware Fetch And Enrich Steps

**Files:**
- Modify: `scripts/lib/steps.ts`
- Modify: `scripts/fetch.ts`
- Modify: `scripts/enrich.ts`

- [ ] **Step 1: Update `scripts/lib/steps.ts` signatures and paths**

Change imports:

```ts
import type { RunContext } from './profiles.ts';
```

Change function signatures:

```ts
export async function enrichStep(ctx: RunContext, logger: Logger): Promise<StepOutput> {
  const { profile, range } = ctx;
```

```ts
export async function fetchStep(ctx: RunContext, logger: Logger): Promise<StepOutput> {
  const { profile, range } = ctx;
```

Change path usage inside `enrichStep`:

```ts
const inPath = listingsPath(profile.id, range.label);
...
fs.mkdirSync(runDir(profile.id, range.label), { recursive: true });
...
const outPath = enrichedPath(profile.id, range.label);
```

Change path usage inside `fetchStep`:

```ts
fs.mkdirSync(runDir(profile.id, range.label), { recursive: true });
const outPath = listingsPath(profile.id, range.label);
```

Keep `collectListings(range, undefined, logger)` unchanged.

- [ ] **Step 2: Update standalone fetch CLI**

In `scripts/fetch.ts`, import `resolveProfileFromArgs`:

```ts
import { resolveProfileFromArgs } from './lib/profiles.ts';
```

Inside `main`, resolve profile and call the step with context:

```ts
const argv = process.argv.slice(2);
const profile = resolveProfileFromArgs(argv);
const range = resolveRangeOrThrow(argv);
const { artifacts } = await fetchStep({ profile, range }, consoleLogger('fetch'));
```

In the catch handler, map missing/unknown profile errors to exit code 2. Replace the current catch block with:

```ts
main().catch((err) => {
  if (err instanceof BlockedError) {
    console.error(`BLOCKED: ${err.message}`);
    process.exit(2);
  }
  const msg = (err as Error).message;
  if (msg.includes('--profile') || msg.includes('unknown profile') || msg.includes('invalid profile')) {
    console.error(`BAD INPUT: ${msg}`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Update standalone enrich CLI**

In `scripts/enrich.ts`, import `resolveProfileFromArgs`:

```ts
import { resolveProfileFromArgs } from './lib/profiles.ts';
```

Inside `main`, resolve profile and use profile-scoped paths:

```ts
const argv = process.argv.slice(2);
const profile = resolveProfileFromArgs(argv);
let range: RunRange;
try {
  range = resolveRange(argv, new Date());
} catch (e) {
  fail((e as Error).message);
}
const inPath = listingsPath(profile.id, range.label);
if (!fs.existsSync(inPath)) {
  fail(`${inPath} not found. Run "npm run fetch -- --profile ${profile.id} ${rangeFlags(range)}" first.`);
}
const { artifacts } = await enrichStep({ profile, range }, consoleLogger('enrich'));
```

Change the catch handler to:

```ts
main().catch((err) => {
  const msg = (err as Error).message;
  if (msg.includes('--profile') || msg.includes('unknown profile') || msg.includes('invalid profile')) {
    console.error(`BAD INPUT: ${msg}`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Run TypeScript**

Run: `npx tsc --noEmit`

Expected: FAIL only in `pipeline.ts`, `notify.ts`, and tests that have not yet been profile-wired. If `steps.ts`, `fetch.ts`, or `enrich.ts` still appear, fix their path/helper calls in this task.

- [ ] **Step 5: Run relevant tests**

Run: `npm test`

Expected: Existing tests that do not execute the changed CLIs pass. If TypeScript-only errors remain outside pipeline/notify, fix them before committing.

- [ ] **Step 6: Commit Task 4**

```bash
git add scripts/lib/steps.ts scripts/fetch.ts scripts/enrich.ts
git commit -m "feat: require profiles for fetch and enrich artifacts"
```

### Task 5: Profile-Specific Notify

**Files:**
- Modify: `scripts/lib/notify.ts`
- Modify: `scripts/lib/notify.test.ts`

- [ ] **Step 1: Replace notify tests**

Replace `scripts/lib/notify.test.ts` with:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeNotifyArgs, composeNotifyCommand, renderFailDetails } from './notify.ts';

const params = { tool: 'claude', status: 'warn', title: '3 件待覆核' } as const;
const investmentTask = '每日 iBigFun 投資房源監測';
const ownerTask = '每日 iBigFun 自住房源監測';

test('composeNotifyArgs builds argv with the profile task and details file', () => {
  assert.deepEqual(composeNotifyArgs(params, investmentTask, 'state/runs/investment/2026-06-26/report.md'), [
    '--tool', 'claude',
    '--status', 'warn',
    '--task', investmentTask,
    '--title', '3 件待覆核',
    '--details-file', 'state/runs/investment/2026-06-26/report.md',
  ]);
});

test('composeNotifyCommand quotes args with spaces for safe display', () => {
  const cmd = composeNotifyCommand(params, ownerTask, 'state/runs/owner-occupied/2026-06-26/report.md');
  assert.ok(cmd.startsWith('ai-notify --tool claude --status warn'));
  assert.ok(cmd.includes("--task '每日 iBigFun 自住房源監測'"));
  assert.ok(cmd.includes("--title '3 件待覆核'"));
  assert.ok(cmd.includes('--details-file state/runs/owner-occupied/2026-06-26/report.md'));
});

test('renderFailDetails includes the profile, range, reason, and journal tail lines', () => {
  const range = { from: '2026-06-20', to: '2026-06-25', label: '2026-06-20_2026-06-25' };
  const tail = [
    { ts: '2026-06-27T00:00:00.000Z', step: 'fetch', level: 'error', event: 'step.error', msg: 'fetch failed: boom' },
  ] as const;
  const md = renderFailDetails('owner-occupied', range, 'login blocked', tail as any);
  assert.ok(md.includes('owner-occupied'));
  assert.ok(md.includes('2026-06-20_2026-06-25'));
  assert.ok(md.includes('2026-06-20 → 2026-06-25'));
  assert.ok(md.includes('login blocked'));
  assert.ok(md.includes('fetch:step.error fetch failed: boom'));
});
```

- [ ] **Step 2: Run notify test and confirm it fails**

Run: `node --import tsx --test scripts/lib/notify.test.ts`

Expected: FAIL because `composeNotifyArgs` still has the old signature and `NOTIFY_TASK` still exists.

- [ ] **Step 3: Update `scripts/lib/notify.ts`**

Remove `NOTIFY_TASK`. Change the functions:

```ts
export function composeNotifyArgs(p: NotifyParams, task: string, detailsFile: string): string[] {
  return [
    '--tool', p.tool,
    '--status', p.status,
    '--task', task,
    '--title', p.title,
    '--details-file', detailsFile,
  ];
}

export function composeNotifyCommand(p: NotifyParams, task: string, detailsFile: string): string {
  return 'ai-notify ' + composeNotifyArgs(p, task, detailsFile).map(shellQuote).join(' ');
}

export function runNotify(p: NotifyParams, task: string, detailsFile: string): { exitCode: number; stderr: string } {
  const r = spawnSync('ai-notify', composeNotifyArgs(p, task, detailsFile), { encoding: 'utf8' });
  if (r.error) return { exitCode: 1, stderr: r.error.message };
  return { exitCode: r.status ?? 1, stderr: r.stderr ?? '' };
}

export function renderFailDetails(profileId: string, range: RunRange, reason: string, tail: JournalEvent[]): string {
  const lines = [
    `# 監測中斷 ${range.label}`,
    ``,
    `- Profile: ${profileId}`,
    `- 區間: ${range.from} → ${range.to}`,
    `- 原因: ${reason}`,
    ``,
    `## journal (最後 ${tail.length} 筆)`,
    ...tail.map((e) => `- ${e.ts} [${e.level}] ${e.step}:${e.event} ${e.msg}`),
  ];
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run notify test**

Run: `node --import tsx --test scripts/lib/notify.test.ts`

Expected: PASS.

- [ ] **Step 5: Run TypeScript**

Run: `npx tsc --noEmit`

Expected: FAIL only in `pipeline.ts`, which still calls the old notify signatures.

- [ ] **Step 6: Commit Task 5**

```bash
git add scripts/lib/notify.ts scripts/lib/notify.test.ts
git commit -m "feat: notify with profile-specific task"
```

### Task 6: Profile-Aware Pipeline

**Files:**
- Modify: `scripts/pipeline.ts`

- [ ] **Step 1: Update imports**

In `scripts/pipeline.ts`, add:

```ts
import { resolveProfileFromArgs, profileFlags, type Profile } from './lib/profiles.ts';
```

- [ ] **Step 2: Add profile-aware bad-input range/profile resolver**

Replace `resolveRangeOrExit` with:

```ts
function resolveProfileOrExit(argv: string[]): Profile {
  try {
    return resolveProfileFromArgs(argv);
  } catch (e) {
    fail((e as Error).message);
  }
}

function resolveRangeOrExit(argv: string[]): RunRange {
  try {
    return resolveRange(argv, new Date());
  } catch (e) {
    fail((e as Error).message);
  }
}
```

- [ ] **Step 3: Update `cmdRun` profile resolution and manifest loading**

At the top of `cmdRun`:

```ts
const profile = resolveProfileOrExit(argv);
const range = resolveRangeOrExit(argv);
```

Change manifest load/create:

```ts
const m = loadOrCreateManifest(profile.id, range.from, range.to, now());
```

Change the report-step message to:

```ts
console.error(
  `\n■ report is an agent step — it cannot be auto-run.\n` +
  `  Profile: ${profile.id} (${profile.displayName})\n` +
  `  Read: AGENTS.md, docs/reporting-rules.md, ${profile.ruleDocPath}\n` +
  `  Template: ${profile.templatePath}\n` +
  `  Do the agent work, write ${reportPath(profile.id, range.label)}, then run:\n` +
  `    npm run pipeline -- mark report ${profileFlags(profile)} ${rangeFlags(range)} --status ok --artifact ${reportPath(profile.id, range.label)} \\\n` +
  `      --status-notify <ok|warn|fail> --title "<short>" --tool <codex|claude>\n` +
  `  Then re-run: npm run pipeline -- run ${profileFlags(profile)} ${rangeFlags(range)}\n`
);
```

Change fetch/enrich step calls:

```ts
const status = await runStep(m, item.step, (logger) => fn({ profile, range }, logger), now);
```

- [ ] **Step 4: Update notify branch**

Inside the notify branch, replace dry-run and send calls:

```ts
console.error(`[dry-run] would send:\n  ${composeNotifyCommand(m.notify, profile.notifyTask, reportPath(profile.id, range.label))}`);
```

```ts
const { exitCode, stderr } = runNotify(m.notify as NotifyParams, profile.notifyTask, reportPath(profile.id, range.label));
```

- [ ] **Step 5: Update `cmdStatus`**

Resolve profile and read profile-scoped manifest:

```ts
const profile = resolveProfileOrExit(argv);
const range = resolveRangeOrExit(argv);
const m = readManifest(profile.id, range.label);
if (!m) { console.error(`No run found for ${profile.id}/${range.label} (state/runs/${profile.id}/${range.label}/ absent).`); process.exit(0); }
console.error(`Run ${profile.id}/${range.label}  (updated ${m.updatedAt})`);
```

Read journal tail:

```ts
const tail = readJournal(profile.id, range.label).slice(-12);
```

- [ ] **Step 6: Update `cmdMark`**

Resolve profile before range:

```ts
const profile = resolveProfileOrExit(argv);
const range = resolveRangeOrExit(argv);
const m = readManifest(profile.id, range.label) ?? loadOrCreateManifest(profile.id, range.from, range.to, now());
```

Update journal mark call:

```ts
journalLogger(profile.id, range.label, step, now).event('info', 'step.mark', `marked ${step} ${status}`,
  { artifact, notify: step === 'report' ? m.notify : undefined });
```

Update console output:

```ts
console.error(`✓ marked ${step} ${status} for ${profile.id}/${range.label}.`);
```

- [ ] **Step 7: Update `cmdFail`**

Resolve profile and use profile-scoped paths:

```ts
const profile = resolveProfileOrExit(argv);
const range = resolveRangeOrExit(argv);
...
const m = readManifest(profile.id, range.label) ?? loadOrCreateManifest(profile.id, range.from, range.to, now());
...
const tail = readJournal(profile.id, range.label).slice(-20);
const detailsFile = path.join(runDir(profile.id, range.label), 'fail-details.md');
fs.mkdirSync(runDir(profile.id, range.label), { recursive: true });
fs.writeFileSync(detailsFile, renderFailDetails(profile.id, range, reason, tail));
...
console.error(`[dry-run] wrote ${detailsFile}; would send:\n  ${composeNotifyCommand(params, profile.notifyTask, detailsFile)}`);
...
journalLogger(profile.id, range.label, 'notify', now).event('error', 'run.fail', `run failed: ${reason}`, { reason });
const { exitCode, stderr } = runNotify(params, profile.notifyTask, detailsFile);
journalLogger(profile.id, range.label, 'notify', now).event(exitCode === 0 ? 'info' : 'error', 'notify.sent',
  `fail notification ai-notify exited ${exitCode}`, { exitCode, stderr });
...
console.error(`✓ fail notification sent for ${profile.id}/${range.label} (${reason}).`);
```

- [ ] **Step 8: Run TypeScript**

Run: `npx tsc --noEmit`

Expected: PASS. If it fails, fix any remaining old path, journal, manifest, step, or notify call signatures.

- [ ] **Step 9: Run the full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 10: Smoke-test required profile errors**

Run: `npm run pipeline -- status --date 2099-01-01`

Expected: exits with code 2 and prints `BAD INPUT: --profile is required; available profiles: investment, owner-occupied`.

Run: `npm run pipeline -- status --profile missing --date 2099-01-01`

Expected: exits with code 2 and prints `BAD INPUT: unknown profile "missing"; available profiles: investment, owner-occupied`.

- [ ] **Step 11: Smoke-test profile-scoped fail dry-run**

Run:

```bash
npm run pipeline -- fail --profile owner-occupied --date 2099-09-09 --reason "smoke test" --tool codex --dry-run
```

Expected: prints a dry-run `ai-notify` command containing `--task '每日 iBigFun 自住房源監測'` and writes `state/runs/owner-occupied/2099-09-09/fail-details.md`.

- [ ] **Step 12: Commit Task 6**

```bash
git add scripts/pipeline.ts
git commit -m "feat: make pipeline profile-aware"
```

### Task 7: Documentation And Runbook Update

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/reporting-rules.md`
- Modify: `docs/fetching.md`
- Modify: `prompts/daily-run.md`
- Modify: `templates/daily-notify-template.md`

- [ ] **Step 1: Update `AGENTS.md` terminology and commands**

Change the opening sentence to:

```md
This repository monitors iBigFun property listings through explicit profiles,
prepares a profile-specific Markdown report, and sends a concise notification.
```

In Daily Run Sequence, require profile selection before date:

```md
2. Identify the target profile explicitly (`investment` or `owner-occupied`).
   Do not infer a profile. Compute the target date: the previous calendar day
   in `Asia/Taipei` unless the user supplied a range/date.
```

Update command examples to include `--profile <profile>` and paths to
`state/runs/<profile>/<label>/...`.

Update canonical notification command to:

```bash
ai-notify --tool <codex|claude> --status <ok|warn|fail> \
  --task "<profile notifyTask>" --title "<short title>" \
  --details-file state/runs/<profile>/<label>/report.md
```

- [ ] **Step 2: Update `README.md`**

Change the description to:

```md
Workspace for monitoring iBigFun property listings through explicit profiles,
preparing profile-specific Markdown reports, and sending concise notifications.
```

Add a short profile section:

```md
## Profiles

Every run requires `--profile <id>`.

- `investment`: current rental-yield investment monitor.
- `owner-occupied`: self-use monitor based on the saved iBigFun search criteria.

Run artifacts live under `state/runs/<profile>/<label>/`.
```

- [ ] **Step 3: Update `docs/reporting-rules.md`**

Keep shared rules and add a top-level profile pointer near the top:

```md
## Profile Rules

Shared rules live in this file. Profile-specific decision thresholds live in:

- `docs/profiles/investment.md`
- `docs/profiles/owner-occupied.md`
```

Move or replace the investment-only criteria section with a pointer:

```md
## Investment Criteria

Investment-specific thresholds and estimation rules are owned by
`docs/profiles/investment.md`.
```

Do not delete walking-distance triage, suspicious-listing judgment, source visibility, null rendering, or notification safety rules.

- [ ] **Step 4: Update `docs/fetching.md`**

Add this note under the request body:

```md
The first profile-aware implementation keeps this captured request shape for all
profiles. Profile JSON files may document desired filters, but fetch does not
apply them until `fetchFilters.enabled` is deliberately wired and tested.
```

Update output paths to `state/runs/<profile>/<label>/listings.json`.

- [ ] **Step 5: Update `prompts/daily-run.md`**

Change the monitoring input section to require a profile:

```md
## 監測 profile 與區間（由 trigger 注入）

Trigger 必須提供 profile，例如 `investment` 或 `owner-occupied`。你不得自行猜測 profile。

下文用 `[profile 參數]` 代表 `--profile <profile>`，用 `[範圍參數]` 代表日期或區間參數。
```

Update all pipeline commands to include `[profile 參數]` before `[範圍參數]`.

- [ ] **Step 6: Update stale template references**

Keep `templates/daily-notify-template.md` as a backward-compatible pointer:

```md
# Deprecated Template

Use profile-specific templates instead:

- `templates/investment-notify-template.md`
- `templates/owner-occupied-notify-template.md`
```

- [ ] **Step 7: Grep for stale investment-only command wording**

Run:

```bash
rg -n "state/runs/<label>|reports/|每日 iBigFun 投資房源監測|npm run pipeline -- run \\[範圍參數\\]|npm run fetch -- --date" AGENTS.md README.md docs prompts templates scripts
```

Expected: remaining `每日 iBigFun 投資房源監測` occurrences are in `profiles/investment.json`, `docs/profiles/investment.md`, `templates/investment-notify-template.md`, tests, or examples that explicitly refer to the investment profile. No stale `state/runs/<label>` remains in user-facing docs except when contrasting old and new paths in specs/plans.

- [ ] **Step 8: Run full verification**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 9: Commit Task 7**

```bash
git add AGENTS.md README.md docs/reporting-rules.md docs/fetching.md prompts/daily-run.md templates/daily-notify-template.md
git commit -m "docs: document profile-aware monitor runs"
```

### Task 8: Final Verification

**Files:**
- No planned edits unless verification exposes an issue.

- [ ] **Step 1: Check working tree**

Run: `git status --short`

Expected: no uncommitted changes.

- [ ] **Step 2: Run full tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 3: Run type-check**

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 4: Run CLI bad-input smoke tests**

Run:

```bash
npm run pipeline -- status --date 2099-01-01
```

Expected: exit code 2 with `BAD INPUT: --profile is required; available profiles: investment, owner-occupied`.

Run:

```bash
npm run pipeline -- status --profile missing --date 2099-01-01
```

Expected: exit code 2 with `BAD INPUT: unknown profile "missing"; available profiles: investment, owner-occupied`.

- [ ] **Step 5: Run profile-scoped dry-run smoke**

Run:

```bash
npm run pipeline -- fail --profile owner-occupied --date 2099-09-09 --reason "smoke test" --tool codex --dry-run
```

Expected:

- prints an `ai-notify` command with `--task '每日 iBigFun 自住房源監測'`
- writes `state/runs/owner-occupied/2099-09-09/fail-details.md`
- fail details include `Profile: owner-occupied`

- [ ] **Step 6: Remove smoke state**

Run:

```bash
rm -rf state/runs/owner-occupied/2099-09-09
```

Expected: throwaway smoke output removed. Do not remove other `state/` contents.

- [ ] **Step 7: Final status**

Run: `git status --short`

Expected: clean working tree.

## Self-Review Notes

- **Spec coverage:** Profile loader and files are Task 1; profile-scoped artifacts are Tasks 2-4 and 6; explicit `--profile` is Tasks 1, 4, and 6; profile-specific notify task is Task 5; owner-occupied URL criteria are Task 1; fetch filters remain disabled in Tasks 1 and 4; docs/prompt/runbook updates are Task 7; final verification is Task 8.
- **Scope check:** The plan does not implement a report generator, scoring engine, multi-profile run, or profile-driven fetch filters.
- **Type consistency:** The run context type is `RunContext { profile, range }`; path helpers use `(profileId, label)` consistently; notify helpers use `(params, task, detailsFile)` consistently; manifests include `profileId`.
