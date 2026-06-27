# Consolidate Run Artifacts Under `state/runs/<label>/` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Co-locate every per-run artifact (`listings`, `enriched`, `report`) under `state/runs/<label>/` alongside the existing `manifest.json`/`journal.jsonl`/`fail-details.md`, so one run = one folder.

**Architecture:** Add path helpers (`listingsPath`/`enrichedPath`/`reportPath`) to `runpaths.ts` as the single source, then swap every producer/consumer (`steps.ts`, `enrich.ts`, `pipeline.ts`) to use them, then update docs. Filenames drop the redundant `<label>` (the directory carries it). `state/route-cache.json` stays shared.

**Tech Stack:** TypeScript ESM via `tsx`; tests `node:test` + `node:assert/strict`; zero new dependencies; explicit `.ts` import extensions.

## Global Constraints

- **Zero new dependencies**; node builtins only; ESM imports use explicit `.ts` extensions.
- **New layout:** `state/runs/<label>/{listings.json, enriched.json, report.md}` (plus the existing `manifest.json`, `journal.jsonl`, `fail-details.md`). Filenames carry NO `<label>` (the dir does).
- **`state/route-cache.json` stays shared** at `state/` — it is cross-run, not per-run. Do NOT move it.
- **No content/shape changes** to any artifact — only file locations.
- **Path rule (single source):** only `runpaths.ts` assembles run-artifact paths. Every other file calls `listingsPath`/`enrichedPath`/`reportPath`/`runDir` — never concatenates `state/...` or `reports/...` for these artifacts.
- **`npm test` AND `npx tsc --noEmit` stay GREEN at every task** (this change is additive helpers + self-contained path swaps — there is no intentional red-tsc window).
- New `*.test.ts` files MUST be added to the `"test"` script in `package.json`.
- **Safety (per `AGENTS.md`):** `state/` (incl. `state/runs/`) stays git-ignored; never commit `state/`; `redact()`/secret handling untouched.

---

### Task 1: Path helpers + tests — `runpaths.ts`

Purely additive. Tree stays green.

**Files:**
- Modify: `scripts/lib/runpaths.ts`
- Create: `scripts/lib/runpaths.test.ts`
- Modify: `package.json` (register the new test file)

**Interfaces:**
- Consumes: existing `runDir(label)`.
- Produces: `listingsPath(label: string): string`, `enrichedPath(label: string): string`, `reportPath(label: string): string`.

- [ ] **Step 1: Write the failing test** — create `scripts/lib/runpaths.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDir, manifestPath, journalPath, listingsPath, enrichedPath, reportPath } from './runpaths.ts';

test('all run paths resolve under state/runs/<label>/ for a single-day label', () => {
  const L = '2026-06-26';
  assert.equal(runDir(L), 'state/runs/2026-06-26');
  assert.equal(manifestPath(L), 'state/runs/2026-06-26/manifest.json');
  assert.equal(journalPath(L), 'state/runs/2026-06-26/journal.jsonl');
  assert.equal(listingsPath(L), 'state/runs/2026-06-26/listings.json');
  assert.equal(enrichedPath(L), 'state/runs/2026-06-26/enriched.json');
  assert.equal(reportPath(L), 'state/runs/2026-06-26/report.md');
});

test('all run paths resolve under state/runs/<label>/ for a range label', () => {
  const L = '2026-06-20_2026-06-25';
  assert.equal(listingsPath(L), 'state/runs/2026-06-20_2026-06-25/listings.json');
  assert.equal(enrichedPath(L), 'state/runs/2026-06-20_2026-06-25/enriched.json');
  assert.equal(reportPath(L), 'state/runs/2026-06-20_2026-06-25/report.md');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test scripts/lib/runpaths.test.ts`
Expected: FAIL (`listingsPath`/`enrichedPath`/`reportPath` not exported).

- [ ] **Step 3: Add the helpers to `scripts/lib/runpaths.ts`** — append after `journalPath`:

```ts
export function listingsPath(label: string): string {
  return path.join(runDir(label), 'listings.json');
}
export function enrichedPath(label: string): string {
  return path.join(runDir(label), 'enriched.json');
}
export function reportPath(label: string): string {
  return path.join(runDir(label), 'report.md');
}
```

- [ ] **Step 4: Register the new test file** — in `package.json`, append ` scripts/lib/runpaths.test.ts` to the end of the `"test"` script string.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test scripts/lib/runpaths.test.ts`
Expected: PASS (both).

- [ ] **Step 6: Confirm suite + typecheck green**

Run: `npm test && npx tsc --noEmit`
Expected: PASS (both, no output from tsc).

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/runpaths.ts scripts/lib/runpaths.test.ts package.json
git commit -m "feat: add listingsPath/enrichedPath/reportPath run-dir helpers"
```

---

### Task 2: Thread helpers through writers/readers — `steps.ts`, `enrich.ts`, `pipeline.ts`, `types.ts`

Swap every artifact path to the run-dir helpers. Tree stays green.

**Files:**
- Modify: `scripts/lib/steps.ts`
- Modify: `scripts/enrich.ts`
- Modify: `scripts/pipeline.ts`
- Modify: `scripts/lib/types.ts` (doc comments only)

**Interfaces:**
- Consumes: `runDir`, `listingsPath`, `enrichedPath` (steps/enrich), `reportPath` (pipeline) from `./runpaths.ts` / `./lib/runpaths.ts`.

- [ ] **Step 1: Edit `scripts/lib/steps.ts`.**
  - Add to imports (top of file): change `import * as path from 'node:path';` line region to also import the helpers:
    ```ts
    import { runDir, listingsPath, enrichedPath } from './runpaths.ts';
    ```
    (Keep the existing `import * as path from 'node:path';` — it is still used elsewhere? After these edits `path` is no longer used in steps.ts; if `npx tsc --noEmit`/lint flags it as unused, REMOVE the `path` import. Verify in Step 5.)
  - In `enrichStep`:
    - Line 21: `const inPath = path.join('state', \`listings-${range.label}.json\`);` → `const inPath = listingsPath(range.label);`
    - Line 85: `fs.mkdirSync('state', { recursive: true });` → `fs.mkdirSync(runDir(range.label), { recursive: true });` (creates `state/runs/<label>/` and, recursively, `state/` — so the subsequent `saveCache` to `state/route-cache.json` still works; `saveCache` also mkdirs `state/` itself).
    - Line 87: `const outPath = path.join('state', \`enriched-${range.label}.json\`);` → `const outPath = enrichedPath(range.label);`
  - In `fetchStep`:
    - Line 111: `fs.mkdirSync('state', { recursive: true });` → `fs.mkdirSync(runDir(range.label), { recursive: true });`
    - Line 112: `const outPath = path.join('state', \`listings-${range.label}.json\`);` → `const outPath = listingsPath(range.label);`

- [ ] **Step 2: Edit `scripts/enrich.ts`.**
  - Update the module doc comment (lines 4 and 8-9): change `Reads state/listings-<date>.json` → `Reads state/runs/<label>/listings.json` and `Writes state/enriched-<date>.json and stdout.` → `Writes state/runs/<label>/enriched.json and stdout.`
  - Add to imports: `import { listingsPath } from './lib/runpaths.ts';`
  - Line 41: `const inPath = \`state/listings-${range.label}.json\`;` → `const inPath = listingsPath(range.label);`
  - Line 43 message is fine as-is (it interpolates `${inPath}` + `rangeFlags(range)`).

- [ ] **Step 3: Edit `scripts/pipeline.ts`.**
  - Line 31: extend the runpaths import: `import { runDir, reportPath } from './lib/runpaths.ts';`
  - In `cmdRun`'s report-step block, replace lines 78-82 with:
    ```ts
        console.error(
          `\n■ report is an agent step — it cannot be auto-run.\n` +
          `  Do the agent work (triage, estimate, evaluate, write ${reportPath(range.label)}), then run:\n` +
          `    npm run pipeline -- mark report ${rangeFlags(range)} --status ok --artifact ${reportPath(range.label)} \\\n` +
          `      --status-notify <ok|warn|fail> --title "<short>" --tool <codex|claude>\n` +
          `  Then re-run: npm run pipeline -- run ${rangeFlags(range)}\n`);
    ```
    (Note: this also adds the previously-missing `${rangeFlags(range)}` to the printed `mark report` command — consistent with the worker prompt.)
  - Line 88 (dry-run notify): `composeNotifyCommand(m.notify, \`reports/${range.label}.md\`)` → `composeNotifyCommand(m.notify, reportPath(range.label))`
  - Line 92 (real notify): `runNotify(m.notify as NotifyParams, \`reports/${range.label}.md\`)` → `runNotify(m.notify as NotifyParams, reportPath(range.label))`

- [ ] **Step 4: Edit `scripts/lib/types.ts` doc comments.**
  - Line 49: `/** Output document written to state/listings-<label>.json and stdout. */` → `/** Output document written to state/runs/<label>/listings.json and stdout. */`
  - Line 109: `/** Output document written to state/enriched-<label>.json and stdout. */` → `/** Output document written to state/runs/<label>/enriched.json and stdout. */`

- [ ] **Step 5: Typecheck + full suite.**

Run: `npx tsc --noEmit && npm test`
Expected: PASS (both). If tsc reports `path` unused in `steps.ts`, remove the now-unused `import * as path from 'node:path';` from `steps.ts` and re-run.

- [ ] **Step 6: Offline functional smoke — the report-step message uses the new path.**

Run (creates a fake run with fetch+enrich already ok, so `run` reaches the report step without any network):
```bash
npm run pipeline -- mark fetch --date 2099-09-09 --status ok
npm run pipeline -- mark enrich --date 2099-09-09 --status ok
npm run pipeline -- run --date 2099-09-09
rm -rf state/runs/2099-09-09
```
Expected: the `run` output's report-step block references `state/runs/2099-09-09/report.md` (in both the "write …" line and the `--artifact …` line) and `mark report --date 2099-09-09`. No `reports/2099-09-09.md` anywhere.

- [ ] **Step 7: Grep — no old artifact-path writers remain in code.**

Run: `git grep -nE "state/listings-|state/enriched-|reports/\\\$\\{|reports/<label>|listings-\\\$\\{range|enriched-\\\$\\{range" -- 'scripts/**/*.ts'`
Expected: NO matches (every code reference now goes through the helpers; comments updated). `state/route-cache.json` references are fine and expected to remain.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/steps.ts scripts/enrich.ts scripts/pipeline.ts scripts/lib/types.ts
git commit -m "feat: write listings/enriched/report under state/runs/<label>/"
```

---

### Task 3: Docs — `AGENTS.md`, `prompts/daily-run.md`, stragglers

Update every doc path reference to the consolidated layout. No code/tests change.

**Files:**
- Modify: `AGENTS.md`
- Modify: `prompts/daily-run.md`
- Modify: any other doc with a stale path (found via grep in Step 1)

- [ ] **Step 1: Find all doc references.**

Run: `git grep -nE "state/listings-|state/enriched-|reports/<|reports/YYYY|reports/\\\$|state/listings|state/enriched" -- '*.md' 'docs/**/*.md'`
Note every hit; each gets updated in the steps below (and Step 4 re-greps to confirm none remain except the shared `state/route-cache.json`).

- [ ] **Step 2: Edit `AGENTS.md`.** Update these references (search-and-replace by meaning; keep surrounding wording):
  - Daily Run Sequence step 3: `writes state/listings-<target>.json` → `writes state/runs/<label>/listings.json`.
  - Daily Run Sequence step 4: `writes state/enriched-<target>.json` → `writes state/runs/<label>/enriched.json`.
  - Daily Run Sequence step 9: `Write reports/YYYY-MM-DD.md (target date in the filename)` → `Write state/runs/<label>/report.md`.
  - Tooling `npm run fetch` bullet: `writes normalized listings to state/listings-<target>.json` → `… to state/runs/<label>/listings.json`.
  - Tooling `npm run enrich` bullet: `→ state/enriched-<target>.json` → `→ state/runs/<label>/enriched.json`.
  - Tooling `npm run pipeline -- run` bullet: `artifacts are state/listings-<label>.json, state/enriched-<label>.json, reports/<label>.md` → `artifacts are state/runs/<label>/{listings.json, enriched.json, report.md}`.
  - `mark report` sub-bullet: `--artifact reports/<label>.md` → `--artifact state/runs/<label>/report.md`.
  - Report Date section: `write reports/<target>.md` → `write state/runs/<label>/report.md`.
  - Canonical Notification Command example: `--details-file reports/YYYY-MM-DD.md` → `--details-file state/runs/<label>/report.md`.
  - Safety Rules: the line `Generated reports under reports/ and local state under state/ are git-ignored` → `Generated reports and local run state under state/ (incl. state/runs/<label>/) are git-ignored` (the report now lives under `state/`).

- [ ] **Step 3: Edit `prompts/daily-run.md`.**
  - Step 2 line: `對 state/enriched-<label>.json 做 …` → `對 state/runs/<label>/enriched.json 做 …`; `寫出**一份**合併報告到 orchestrator 指定的 reports/<label>.md` → `… 到 orchestrator 指定的 state/runs/<label>/report.md`.
  - Step 3 mark command: `--artifact reports/<label>.md` → `--artifact state/runs/<label>/report.md`.

- [ ] **Step 4: Update any straggler docs** found in Step 1 (e.g. `docs/fetching.md`, `docs/automation-state.md`) where they state where files are written — change `state/listings-<…>.json` / `state/enriched-<…>.json` / `reports/<…>.md` to the consolidated `state/runs/<label>/…` paths. Leave references to `state/route-cache.json` unchanged.

- [ ] **Step 5: Verify nothing regressed + no stale code/doc paths remain.**

Run:
```bash
npm test && npx tsc --noEmit
git grep -nE "state/listings-|state/enriched-|reports/<label>|reports/YYYY-MM-DD" -- 'scripts/**/*.ts' '*.md' 'docs/**/*.md'
```
Expected: tests + tsc green; the grep returns NO matches (all updated). (`state/route-cache.json` and historical spec/plan docs under `docs/superpowers/` may legitimately still mention old paths — those are historical records; do NOT rewrite committed spec/plan history. Limit doc edits to `AGENTS.md`, `prompts/daily-run.md`, and active operator docs under `docs/` like `fetching.md`/`automation-state.md`.)

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md prompts/daily-run.md docs
git commit -m "docs: point all run-artifact paths at state/runs/<label>/"
```

---

## Self-Review

- **Spec coverage:** new layout (T1 helpers + T2 writers), report moved into run dir + notify points there (T2 pipeline), filenames drop label (T1 helpers), route-cache stays shared (T2 leaves `saveCache`/CACHE_PATH untouched), docs updated (T3). All spec sections map to a task.
- **No red-tsc window:** T1 additive; T2 swaps are self-contained and compile; each task ends green.
- **Type/name consistency:** `listingsPath`/`enrichedPath`/`reportPath` defined in T1, consumed by exact name in T2 (`steps.ts`, `enrich.ts`, `pipeline.ts`).
- **Placeholder scan:** none — every step has concrete code/commands.
- **Single-source path rule** enforced by the T2 Step 7 grep (no inlined artifact paths remain in code).
