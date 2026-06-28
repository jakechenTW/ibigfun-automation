# 投資房目標捷運範圍閘門 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict the `investment` profile to a user-defined 35-station MRT core of Taipei, excluding everything outside it; surface out-of-region and in-region-but-too-far as distinct audit counts rather than per-listing report entries.

**Architecture:** A new pure module `scripts/lib/region.ts` holds the 35-station allowlist and a `classifyRegion()` function. The enrich step (`finalizeWalk`) tags every listing with a `regionGate` value derived from the already-computed nearest station (`walk.stationZh`) and `withinWalk`. The aggregate `EnrichResult` gains two counts. Docs and the investment template tell the agent to drive the audit count line from those fields and stop listing the 前置排除 bucket per-listing. Fetch is untouched — the gate runs at enrich/evaluation.

**Tech Stack:** TypeScript (ESM, `.ts` imports), `tsx`, Node's built-in `node:test` + `node:assert/strict`. No new dependencies.

## Global Constraints

- Tests run from the repo root via `npm test`, which lists each test file explicitly in `package.json` — a new test file MUST be added to that list or it will not run.
- `.ts` import specifiers everywhere (e.g. `import { x } from './region.ts'`).
- Station names in the allowlist MUST exactly match `name_zh` values in `data/taipei_mrt_exits.csv` (verified: all 35 present).
- Profile scope: change `investment` only. Do NOT touch `owner-occupied`.
- Do not commit anything under `state/` or real `.env` contents.
- Mutually-exclusive precedence in classification: unreliable → `review`; else station-not-in-allowlist → `out-of-region` (regardless of distance); else `withinWalk` decides `in` vs `in-region-too-far`.

---

### Task 1: Region allowlist module (`region.ts`)

**Files:**
- Create: `scripts/lib/region.ts`
- Test: `scripts/lib/region.test.ts`
- Modify: `package.json:11` (add the new test file to the `test` script)

**Interfaces:**
- Produces: `REGION_ALLOWLIST: ReadonlySet<string>` (35 station `name_zh`); `type RegionGate = 'in' | 'out-of-region' | 'in-region-too-far' | 'review'`; `classifyRegion(stationZh: string | null, withinWalk: boolean | null): RegionGate`.
- Consumes (in test only): `loadExits` from `./mrt.ts`.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/region.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGION_ALLOWLIST, classifyRegion } from './region.ts';
import { loadExits } from './mrt.ts';

test('allowlist has exactly 35 stations', () => {
  assert.equal(REGION_ALLOWLIST.size, 35);
});

test('every allowlist station exists in the MRT exit dataset', () => {
  const names = new Set(loadExits('data/taipei_mrt_exits.csv').map((e) => e.nameZh));
  for (const s of REGION_ALLOWLIST) {
    assert.ok(names.has(s), `allowlist station not in MRT data: ${s}`);
  }
});

test('excluded stations are NOT in the allowlist (sanity)', () => {
  for (const s of ['圓山', '龍山寺', '後山埤', '南京三民', '松山', '萬隆', '劍南路', '科技大樓']) {
    assert.equal(REGION_ALLOWLIST.has(s), false, `should be excluded: ${s}`);
  }
});

test('in-allowlist + within walk -> in', () => {
  assert.equal(classifyRegion('大安', true), 'in');
});

test('out of allowlist -> out-of-region regardless of walk', () => {
  assert.equal(classifyRegion('後山埤', true), 'out-of-region');
  assert.equal(classifyRegion('後山埤', false), 'out-of-region');
});

test('in-allowlist but too far -> in-region-too-far', () => {
  assert.equal(classifyRegion('大安', false), 'in-region-too-far');
});

test('unreliable (withinWalk null) -> review, even if station present', () => {
  assert.equal(classifyRegion('大安', null), 'review');
  assert.equal(classifyRegion(null, null), 'review');
});

test('null station with a definite walk decision -> out-of-region', () => {
  assert.equal(classifyRegion(null, true), 'out-of-region');
});
```

- [ ] **Step 2: Add the test file to the runner and run it (verify it fails)**

Edit `package.json:11`: append ` scripts/lib/region.test.ts` to the end of the `"test"` command string (before the closing quote, space-separated like the others).

Run: `npm test -- 2>&1 | head -30`
Expected: FAIL — `Cannot find module './region.ts'` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib/region.ts`:

```ts
/**
 * Target-MRT region gate for the investment profile. The 35-station allowlist
 * is the human-described core of Taipei (see data/region-allowlist.md and
 * docs/profiles/investment.md). Membership is tested against the nearest
 * walking station the enrich step already picked.
 *
 * Precedence (mutually exclusive): unreliable walk -> review; else a station
 * outside the allowlist -> out-of-region (distance is irrelevant once outside);
 * else withinWalk decides in vs in-region-too-far.
 */
export type RegionGate = 'in' | 'out-of-region' | 'in-region-too-far' | 'review';

export const REGION_ALLOWLIST: ReadonlySet<string> = new Set([
  // 紅線（淡水信義線）石牌～象山，排除圓山
  '石牌', '明德', '芝山', '士林', '劍潭', '民權西路', '雙連', '中山',
  '台北車站', '台大醫院', '中正紀念堂', '東門', '大安森林公園', '大安',
  '信義安和', '象山',
  // 藍線（板南線）西門～永春
  '西門', '善導寺', '忠孝新生', '忠孝復興', '忠孝敦化', '國父紀念館',
  '市政府', '永春',
  // 綠線（松山新店線）台北小巨蛋～公館
  '台北小巨蛋', '南京復興', '松江南京', '北門', '小南門', '古亭', '台電大樓', '公館',
  // 橘線（中和新蘆線）台北市段獨有站
  '行天宮', '中山國小', '大橋頭',
]);

export function classifyRegion(
  stationZh: string | null,
  withinWalk: boolean | null,
): RegionGate {
  if (withinWalk === null) return 'review';
  if (!stationZh || !REGION_ALLOWLIST.has(stationZh)) return 'out-of-region';
  return withinWalk ? 'in' : 'in-region-too-far';
}
```

- [ ] **Step 4: Run the tests (verify they pass)**

Run: `npm test -- 2>&1 | tail -20`
Expected: PASS — all region tests green, no other test regressed.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/region.ts scripts/lib/region.test.ts package.json
git commit -m "feat(region): 35-station investment allowlist + classifyRegion"
```

---

### Task 2: Tag each listing with `regionGate` in enrich

**Files:**
- Modify: `scripts/lib/types.ts:92-107` (add `regionGate` to `EnrichedListing`)
- Modify: `scripts/lib/walk.ts:11-13,116-125` (import + populate `regionGate` in `finalizeWalk`)
- Test: `scripts/lib/walk.test.ts` (add `regionGate` assertions)

**Interfaces:**
- Consumes: `classifyRegion`, `RegionGate` from `./region.ts`.
- Produces: `EnrichedListing.regionGate: RegionGate` on every enriched listing.

- [ ] **Step 1: Write the failing test**

Append to `scripts/lib/walk.test.ts`. The shared `offline()` helper defaults the nearest candidate to `東門` (in allowlist):

```ts
import { classifyRegion } from './region.ts';

test('regionGate in: allowlist station within walk', () => {
  const e = finalizeWalk(offline({ candidates: [cand('東門', '4', 600)] }), [700]);
  assert.equal(e.regionGate, 'in');
});

test('regionGate out-of-region: nearest station not in allowlist', () => {
  const e = finalizeWalk(offline({ candidates: [cand('後山埤', '1', 600)] }), [700]);
  assert.equal(e.regionGate, 'out-of-region');
});

test('regionGate in-region-too-far: allowlist station but >10-min walk', () => {
  const e = finalizeWalk(offline({ candidates: [cand('東門', '4', 800)] }), [1000]);
  assert.equal(e.regionGate, 'in-region-too-far');
});

test('regionGate review: unreliable coordinate', () => {
  const e = finalizeWalk(offline({ coordConsistent: false }), [700]);
  assert.equal(e.regionGate, 'review');
});

test('regionGate matches classifyRegion of walk.stationZh + withinWalk', () => {
  const e = finalizeWalk(offline({ candidates: [cand('大安', '2', 600)] }), [650]);
  assert.equal(e.regionGate, classifyRegion(e.walk?.stationZh ?? null, e.withinWalk));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- 2>&1 | grep -A3 regionGate | head -30`
Expected: FAIL — `regionGate` is `undefined` (property not yet produced).

- [ ] **Step 3: Add the type field**

In `scripts/lib/types.ts`, inside `interface EnrichedListing` (after the `withinWalk` line at `:101`), add:

```ts
  /** Investment region gate from nearest station + withinWalk (see region.ts). */
  regionGate: RegionGate;
```

Add the import near the other type imports at the top of `types.ts`:

```ts
import type { RegionGate } from './region.ts';
```

- [ ] **Step 4: Populate it in `finalizeWalk`**

In `scripts/lib/walk.ts`, add to the imports (near `:13`):

```ts
import { classifyRegion } from './region.ts';
```

Then in the returned object of `finalizeWalk` (the `return { ...listingBase(o), ... }` block at `:116`), add a `regionGate` property:

```ts
    regionGate: classifyRegion(walk?.stationZh ?? null, withinWalk),
```

- [ ] **Step 5: Run tests (verify pass)**

Run: `npm test -- 2>&1 | tail -20`
Expected: PASS — new `regionGate` tests green; all prior `walk.test.ts` tests still pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/types.ts scripts/lib/walk.ts scripts/lib/walk.test.ts
git commit -m "feat(enrich): tag listings with regionGate"
```

---

### Task 3: Aggregate region counts into `EnrichResult`

**Files:**
- Modify: `scripts/lib/types.ts:110-119` (add two count fields to `EnrichResult`)
- Modify: `scripts/lib/steps.ts:78-97` (compute + emit the counts)

**Interfaces:**
- Consumes: `EnrichedListing.regionGate` from Task 2.
- Produces: `EnrichResult.outOfRegionCount: number`, `EnrichResult.inRegionTooFarCount: number` (written into `enriched.json`, read by the agent for the audit line).

Note: there is no `steps.test.ts`; `steps.ts` is verified by `npm test` type-checking plus the Task 6 e2e run. This task has no unit test of its own — its deliverable is the aggregate counts in the written artifact.

- [ ] **Step 1: Add the type fields**

In `scripts/lib/types.ts`, inside `interface EnrichResult` (after `hardExcludedCount: number;` at `:117`), add:

```ts
  outOfRegionCount: number; // regionGate === 'out-of-region'
  inRegionTooFarCount: number; // regionGate === 'in-region-too-far'
```

- [ ] **Step 2: Compute and emit the counts**

In `scripts/lib/steps.ts`, after the existing count lines (`:78-80`), add:

```ts
  const outOfRegionCount = enriched.filter((l) => l.regionGate === 'out-of-region').length;
  const inRegionTooFarCount = enriched.filter((l) => l.regionGate === 'in-region-too-far').length;
```

Add both to the `result` object literal (`:81-84`), alongside the existing counts:

```ts
    withinWalkCount, manualReviewCount, hardExcludedCount,
    outOfRegionCount, inRegionTooFarCount, listings: enriched,
```

Extend the summary log event (`:90-94`) so the gate is visible in the journal:

```ts
  logger.event('info', 'enrich.summary',
    `enriched ${enriched.length}: ${withinWalkCount} within-walk, ${manualReviewCount} manual-review, ` +
      `${hardExcludedCount} hard-excluded, ${outOfRegionCount} out-of-region, ${inRegionTooFarCount} too-far ` +
      `(ORS ${apiCalls}, cache ${cacheHits}, errors ${routeErrors})`,
    { count: enriched.length, withinWalk: withinWalkCount, manualReview: manualReviewCount,
      hardExcluded: hardExcludedCount, outOfRegion: outOfRegionCount, inRegionTooFar: inRegionTooFarCount,
      orsCalls: apiCalls, cacheHits, routeErrors });
```

- [ ] **Step 3: Verify the project still builds and tests pass**

Run: `npm test -- 2>&1 | tail -15`
Expected: PASS — no type errors from the new fields (TypeScript would flag a missing `EnrichResult` property at the `result` literal).

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/types.ts scripts/lib/steps.ts
git commit -m "feat(enrich): aggregate out-of-region / too-far counts"
```

---

### Task 4: Docs, template, and human-readable allowlist

**Files:**
- Create: `data/region-allowlist.md`
- Modify: `docs/reporting-rules.md` (add a "Region Gate" subsection after Walking-Distance Signals at `:36`)
- Modify: `docs/profiles/investment.md` (rewrite the walk hard-exclusion rule + 前置排除 bucket as region-gate counts)
- Modify: `templates/investment-notify-template.md` (audit count line; drop per-listing 前置排除 section)

This task is documentation; verification is human review (Task 5) + the e2e numbers (Task 6). No unit test.

- [ ] **Step 1: Create `data/region-allowlist.md`**

```markdown
# 投資房目標捷運範圍白名單

機器可讀的真實來源是 `scripts/lib/region.ts` 的 `REGION_ALLOWLIST`；本檔是人類參照，
兩者必須一致（`scripts/lib/region.test.ts` 斷言站數與 MRT 資料存在性）。

範圍規則（使用者定義，2026-06-28）：

- 紅線（淡水信義線）：石牌以北全排除、**圓山單站排除**，保留石牌～象山其餘站。
- 藍線（板南線）：龍山寺含以西排除、永春以東排除，保留西門～永春。
- 綠線（松山新店線）：台北小巨蛋以東排除、公館以南排除，保留小巨蛋～公館。
- 橘線（中和新蘆線）：台北市段全納（行天宮、中山國小、大橋頭；其餘轉乘站已由他線納入），跨新北段排除。
- 文湖線：純文湖站全排除；僅同時落在上述允許段的轉乘站算（大安、忠孝復興、南京復興）。

35 站：石牌、明德、芝山、士林、劍潭、民權西路、雙連、中山、台北車站、台大醫院、
中正紀念堂、東門、大安森林公園、大安、信義安和、象山、西門、善導寺、忠孝新生、
忠孝復興、忠孝敦化、國父紀念館、市政府、永春、台北小巨蛋、南京復興、松江南京、
北門、小南門、古亭、台電大樓、公館、行天宮、中山國小、大橋頭。

判斷以 enrich 算出的「走路最近站」(`walk.stationZh`) 比對白名單；分類見
`docs/reporting-rules.md`（Region Gate）。
```

- [ ] **Step 2: Add the Region Gate section to `docs/reporting-rules.md`**

Insert after the Walking-Distance Signals list (before `## Calculations` at `:37`):

```markdown
## Region Gate（目標捷運範圍，投資 profile）

投資 profile 將範圍限縮在 `data/region-allowlist.md` 的 35 站核心區。enrich 以
走路最近站 (`walk.stationZh`) 比對白名單，於每筆 listing 產出 `regionGate`
（`scripts/lib/region.ts`），口徑互斥、先判範圍再判遠近：

- `in`：最近站在白名單且 `withinWalk === true` → 進入評估。
- `out-of-region`：最近站不在白名單（不論遠近）→ 排除，僅計數。
- `in-region-too-far`：最近站在白名單但 `withinWalk === false` → 排除，僅計數。
- `review`：`withinWalk === null`（座標/路線不可靠）→ 不排除，送既有人工 triage。

`enriched.json` 彙總 `outOfRegionCount` 與 `inRegionTooFarCount`。投資報告「快速摘要」
須輸出一行稽核計數，兩個排除原因分開列，例如：
`本日新案 {count} 筆｜目標捷運站外 {outOfRegionCount} 筆｜站內走路過遠 {inRegionTooFarCount} 筆｜進入評估 {in 計} 筆（待人工確認 {manualReviewCount} 筆）`。
`out-of-region` 與 `in-region-too-far` 的物件不逐筆列出，只進此計數行；若 `進入評估`
異常為 0，視為白名單/資料異常的警訊。
```

- [ ] **Step 3: Rewrite the walk/前置排除 rules in `docs/profiles/investment.md`**

Replace the hard-exclusion-walk line in `## Criteria` (`investment.md:15-16`):

```markdown
- 區域閘門（硬排除）：`regionGate` 為 `out-of-region`（最近站不在目標白名單）或
  `in-region-too-far`（白名單站但可靠步行 >10 分）的物件一律排除，且**不逐筆列出**，
  只進「快速摘要」的稽核計數行（見 `docs/reporting-rules.md` Region Gate）。
  `regionGate === 'review'`（`withinWalk === null`）不排除，送人工 triage。
```

Replace the `前置排除` bucket line in `## Report Buckets` (`investment.md:32`):

```markdown
- `區域閘門（計數）`: `out-of-region` 與 `in-region-too-far` 物件不分桶逐列，只在
  快速摘要稽核計數行分別計數（目標捷運站外／站內走路過遠）。
```

Update the buckets sort/list note (`investment.md:54`, the "推薦、接近門檻、排除三桶" line) — leave the three priced buckets as-is; the region gate is upstream of them and only counted.

- [ ] **Step 4: Update `templates/investment-notify-template.md`**

In `### 快速摘要`, replace the `- 前置排除：{{hard_excluded_count}} 筆` line (`:9`) with:

```markdown
- 區域閘門｜目標捷運站外：{{out_of_region_count}} 筆・站內走路過遠：{{in_region_too_far_count}} 筆・待人工確認：{{manual_review_count}} 筆
```

Replace the explanatory bullet about 前置排除 (`:19`) with:

```markdown
- 區域閘門：最近捷運站不在目標白名單（目標捷運站外）或白名單站但可靠步行 >10 分（站內走路過遠）即排除，只計數不逐列（見 `data/region-allowlist.md`）
```

Delete the entire `### 前置排除` section (`:22-40`, from the `### 前置排除` heading through its closing `{{/if}}`). The 推薦／接近門檻／可疑／目標日排除 sections remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add data/region-allowlist.md docs/reporting-rules.md docs/profiles/investment.md templates/investment-notify-template.md
git commit -m "docs(investment): region-gate rules, counts, allowlist; drop 前置排除 listing"
```

---

### Task 5: E2E verification on existing fetched data (no login)

**Files:** none (verification only). Uses existing `state/runs/investment/2026-06-27/listings.json`.

This re-enriches an already-fetched date, so it needs no iBigFun login. ORS routing is served from `state/route-cache.json`.

- [ ] **Step 1: Full unit suite green**

Run: `npm test -- 2>&1 | tail -8`
Expected: all tests pass (`# fail 0`).

- [ ] **Step 2: Re-enrich the cached date**

Run: `npm run enrich -- --profile investment --date 2026-06-27 2>&1 | tail -15`
Expected: completes; summary log shows `out-of-region` and `too-far` counts.

- [ ] **Step 3: Inspect the gate distribution and counts**

Run:
```bash
node -e "const r=require('./state/runs/investment/2026-06-27/enriched.json'); const b={}; for(const l of r.listings){b[l.regionGate]=(b[l.regionGate]||0)+1;} console.log('count',r.count,'outOfRegion',r.outOfRegionCount,'tooFar',r.inRegionTooFarCount); console.log('gate distribution',b); console.log('sumExclusive', (b.in||0)+(b['out-of-region']||0)+(b['in-region-too-far']||0)+(b.review||0)===r.count);"
```
Expected: every listing has a `regionGate`; the four buckets sum to `count` (`sumExclusive true`); `outOfRegionCount`/`inRegionTooFarCount` match the distribution; `in` count is a plausible minority (core-only) of the ~78 all-Taipei listings.

- [ ] **Step 4: Spot-check correctness on two listings**

Run:
```bash
node -e "const r=require('./state/runs/investment/2026-06-27/enriched.json'); for(const g of ['in','out-of-region','in-region-too-far']){const l=r.listings.find(x=>x.regionGate===g); if(l) console.log(g,'->',l.walk&&l.walk.stationZh,'withinWalk',l.withinWalk,'|',l.addressOrArea);}"
```
Expected: the `in` example's station is in the allowlist with `withinWalk true`; the `out-of-region` example's station is NOT in the allowlist; the `in-region-too-far` example's station IS in the allowlist with `withinWalk false`. If any contradicts the allowlist, stop and debug `classifyRegion` before proceeding.

- [ ] **Step 5: Confirm no `state/` artifacts are staged**

Run: `git status --porcelain`
Expected: clean (re-enrich rewrote git-ignored `state/` files only; nothing to commit).

---

## Final integration (per session goal: local merge → push)

After all tasks pass and e2e is verified:

- [ ] Confirm full suite once more: `npm test`
- [ ] Merge the feature branch into `main` locally (fast-forward or `--no-ff` per repo convention).
- [ ] Push `main`.

---

## Self-Review

**Spec coverage:**
- 35-station allowlist → Task 1 (`region.ts`) + Task 4 (`data/region-allowlist.md`). ✓
- Nearest-station gate (方案 A) → Task 2 (`finalizeWalk` + `regionGate`). ✓
- Three exclusive states + `review` precedence → Task 1 `classifyRegion`, tested. ✓
- Audit count line, two distinct labels, count-only (no per-listing) → Task 3 (counts) + Task 4 (rules/template). ✓
- 圓山 single-station hole; 橘線 Taipei segment included → encoded in `REGION_ALLOWLIST` + `region-allowlist.md`; sanity test asserts 圓山 excluded. ✓
- Unreliable coord not hard-excluded → `review` branch + existing triage unchanged. ✓
- Fetch untouched → no fetch files in any task. ✓
- owner-occupied untouched → no owner-occupied files in any task. ✓

**Placeholder scan:** No TBD/TODO; every code/test step shows full content. ✓

**Type consistency:** `RegionGate` / `classifyRegion` / `REGION_ALLOWLIST` names identical across Tasks 1–3; `regionGate` field name consistent in `types.ts`, `walk.ts`, tests, and e2e scripts; `outOfRegionCount` / `inRegionTooFarCount` consistent in `types.ts`, `steps.ts`, docs, and template variables (`out_of_region_count` / `in_region_too_far_count`). ✓
