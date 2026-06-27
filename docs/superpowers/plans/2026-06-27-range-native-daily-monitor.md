# Range-Native Daily Monitor + Headless Worker Prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the daily iBigFun pipeline from one-date-per-run to an inclusive date range `[from, to]` (single day = the range `[d, d]`), emitting one merged report + one notification, and add a committed headless worker prompt with a `pipeline fail` escape hatch.

**Architecture:** Introduce a pure range core (`rangeLabel` + `resolveRange`), key the run record / artifacts by a *label* (`<date>` for one day, `<from>_<to>` for a span), pass the range through fetch (one query over `add_date..add_date_max` + cross-day dedup), enrich (tenure anchored at `to`), and notify (details file by label). Add `pipeline fail` for headless failures and a committed `prompts/daily-run.md`.

**Tech Stack:** TypeScript ESM run via `tsx`; tests via `node:test` + `node:assert/strict`; zero new dependencies (node builtins + fs only). ESM imports use explicit `.ts` extensions.

## Global Constraints

- **Zero new dependencies.** node builtins (`fs`, `path`, `child_process`) only. ESM imports use explicit `.ts` extensions (e.g. `from './date.ts'`).
- **Tests:** `node:test` + `node:assert/strict`. Every NEW `*.test.ts` file MUST be appended to the `"test"` script in `package.json` (it lists files explicitly — a new file not listed never runs).
- **Per-task gate is `npm test`.** `npm test` does NOT run `tsc`; it loads only the listed test files. Each task MUST leave `npm test` green.
- **Whole-tree `npx tsc --noEmit` is intentionally RED from Task 2 through Task 5** because downstream callers (especially `scripts/pipeline.ts`, `scripts/fetch.ts`, `scripts/enrich.ts`) still reference old signatures. It is rewired and **restored to green at the end of Task 6**, and MUST stay green through Tasks 7–8. **Do NOT edit `pipeline.ts` / `fetch.ts` / `enrich.ts` to chase `tsc` before Task 6** — that causes conflicts with Task 6's rewrite. Within a task, only the files that task names may change.
- **Label rule (single source):** `rangeLabel(from, to) = from === to ? from : \`${from}_${to}\``. Never inline this rule anywhere else; always call `rangeLabel`.
- **Single-day behavior must stay byte-identical to today:** default run (no flags) → `[previousTaipeiDay, previousTaipeiDay]` → label `<date>` → artifacts `state/listings-<date>.json`, `state/enriched-<date>.json`, `reports/<date>.md`, run dir `state/runs/<date>/`, and `add_date === add_date_max === <date>` in the fetch body.
- **Canonical notify task string is fixed:** `每日 iBigFun 投資房源監測` (the `NOTIFY_TASK` constant). Do not change it.
- **Safety (per `AGENTS.md`):** never print `IBIGFUN_ACCOUNT` / `IBIGFUN_PASSWORD`; everything written to the journal already passes `redact()`; the `pipeline fail` details file is built ONLY from the (already-redacted) journal tail + the operator-supplied reason; `state/` and `reports/` are git-ignored — never commit them.

---

### Task 1: Range core — `rangeLabel`, `resolveRange`, `rangeFlags`

Pure, additive. Nothing else depends on it yet, so the tree stays fully green.

**Files:**
- Modify: `scripts/lib/date.ts` (add `rangeLabel`)
- Create: `scripts/lib/range.ts`
- Create: `scripts/lib/range.test.ts`
- Modify: `scripts/lib/date.test.ts` (add a `rangeLabel` case)
- Modify: `package.json` (add `range.test.ts` to the `"test"` script)

**Interfaces:**
- Consumes: `isValidDateString`, `previousTaipeiDay`, `daysBetween` from `./date.ts`.
- Produces:
  - `rangeLabel(from: string, to: string): string` (in `date.ts`)
  - `interface RunRange { from: string; to: string; label: string }`
  - `resolveRange(argv: string[], now: Date): RunRange` — throws `Error(message)` on bad input
  - `rangeFlags(r: RunRange): string`

- [ ] **Step 1: Write the failing test** — create `scripts/lib/range.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRange, rangeFlags } from './range.ts';

// 2026-06-27T01:00:00Z is 09:00 in Asia/Taipei → previous Taipei day = 2026-06-26.
const NOW = new Date('2026-06-27T01:00:00Z');

test('no flags → previous Taipei day as a single-day range', () => {
  assert.deepEqual(resolveRange([], NOW), {
    from: '2026-06-26', to: '2026-06-26', label: '2026-06-26',
  });
});

test('--date is a single-day range (label is the bare date)', () => {
  assert.deepEqual(resolveRange(['--date', '2026-06-20'], NOW), {
    from: '2026-06-20', to: '2026-06-20', label: '2026-06-20',
  });
});

test('--date=VALUE form is accepted', () => {
  assert.equal(resolveRange(['--date=2026-06-20'], NOW).label, '2026-06-20');
});

test('--from/--to make a multi-day range with a from_to label', () => {
  assert.deepEqual(resolveRange(['--from', '2026-06-20', '--to', '2026-06-25'], NOW), {
    from: '2026-06-20', to: '2026-06-25', label: '2026-06-20_2026-06-25',
  });
});

test('--from === --to collapses to a single-day label', () => {
  assert.equal(resolveRange(['--from', '2026-06-20', '--to', '2026-06-20'], NOW).label, '2026-06-20');
});

test('rejects --date together with --from/--to', () => {
  assert.throws(() => resolveRange(['--date', '2026-06-20', '--from', '2026-06-20', '--to', '2026-06-21'], NOW), /not both/);
});

test('rejects only one of --from/--to', () => {
  assert.throws(() => resolveRange(['--from', '2026-06-20'], NOW), /both --from and --to/);
});

test('rejects a reversed range', () => {
  assert.throws(() => resolveRange(['--from', '2026-06-25', '--to', '2026-06-20'], NOW), /after --to/);
});

test('rejects a malformed date', () => {
  assert.throws(() => resolveRange(['--date', '2026-6-1'], NOW), /invalid --date/);
});

test('rejects --date with a missing value', () => {
  assert.throws(() => resolveRange(['--date'], NOW), /invalid --date/);
});

test('rangeFlags reproduces single-day (--date) and range (--from/--to)', () => {
  assert.equal(rangeFlags({ from: '2026-06-26', to: '2026-06-26', label: '2026-06-26' }), '--date 2026-06-26');
  assert.equal(
    rangeFlags({ from: '2026-06-20', to: '2026-06-25', label: '2026-06-20_2026-06-25' }),
    '--from 2026-06-20 --to 2026-06-25',
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test scripts/lib/range.test.ts`
Expected: FAIL (`Cannot find module './range.ts'`).

- [ ] **Step 3: Add `rangeLabel` to `scripts/lib/date.ts`** — append after `daysBetween`:

```ts
/** On-disk label for a run: the date itself for a single day, else `from_to`. */
export function rangeLabel(from: string, to: string): string {
  return from === to ? from : `${from}_${to}`;
}
```

- [ ] **Step 4: Create `scripts/lib/range.ts`:**

```ts
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
```

- [ ] **Step 5: Add a `rangeLabel` case to `scripts/lib/date.test.ts`** (append; keep existing imports — add `rangeLabel` to the import from `./date.ts`):

```ts
test('rangeLabel: bare date for a single day, from_to for a span', () => {
  assert.equal(rangeLabel('2026-06-26', '2026-06-26'), '2026-06-26');
  assert.equal(rangeLabel('2026-06-20', '2026-06-25'), '2026-06-20_2026-06-25');
});
```

- [ ] **Step 6: Register the new test file** — in `package.json`, append ` scripts/lib/range.test.ts` to the end of the `"test"` script string.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --import tsx --test scripts/lib/range.test.ts scripts/lib/date.test.ts`
Expected: PASS (all).

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/range.ts scripts/lib/range.test.ts scripts/lib/date.ts scripts/lib/date.test.ts package.json
git commit -m "feat: range core (rangeLabel, resolveRange, rangeFlags)"
```

---

### Task 2: Key the run record by range — `manifest.ts` + `run.ts` (+ path param renames)

Replace the manifest's single `targetDate` with `from`/`to` and add a run-level `failure` field; key paths via `rangeLabel`. After this task, `npx tsc --noEmit` is red (pipeline still calls old signatures) — that is expected; `npm test` stays green.

**Files:**
- Modify: `scripts/lib/manifest.ts`
- Modify: `scripts/lib/run.ts:22`
- Modify: `scripts/lib/runpaths.ts` (rename param `date` → `label`, cosmetic)
- Modify: `scripts/lib/journal.ts` (rename param `date` → `label`, cosmetic)
- Test: `scripts/lib/manifest.test.ts`, `scripts/lib/run.test.ts`

**Interfaces:**
- Consumes: `rangeLabel` from `./date.ts`.
- Produces:
  - `interface Manifest { from: string; to: string; createdAt; updatedAt; notify: NotifyParams | null; steps; failure: { reason: string; where: string } | null }`
  - `createManifest(from: string, to: string, now: string): Manifest`
  - `readManifest(label: string): Manifest | null`
  - `loadOrCreateManifest(from: string, to: string, now: string): Manifest`
  - `writeManifest(m: Manifest, now: string): void` (unchanged signature; resolves dir via `rangeLabel(m.from, m.to)`)

- [ ] **Step 1: Update `manifest.test.ts` to the new shape (failing).** Apply these edits:
  - Remove the **duplicate** `import { planNextSteps } from './manifest.ts';` at line 31 (it is already imported on line 5 — this is a pre-existing `tsc` error that must go).
  - Replace every `createManifest('2026-06-26', X)` with `createManifest('2026-06-26', '2026-06-26', X)`, and `createManifest(date, X)` (the round-trip test) with `createManifest(date, date, X)`.
  - In the first test, replace `assert.equal(m.targetDate, '2026-06-26');` with:
    ```ts
    assert.equal(m.from, '2026-06-26');
    assert.equal(m.to, '2026-06-26');
    assert.equal(m.failure, null);
    ```
  - In the round-trip test, replace `assert.equal(back!.targetDate, date);` with `assert.equal(back!.from, date);` and add `assert.equal(back!.to, date);`.
  - Append a new range round-trip test:
    ```ts
    test('a multi-day range writes under a from_to label and round-trips', () => {
      const from = '0004-04-04', to = '0004-04-06', label = '0004-04-04_0004-04-06';
      try {
        const m = createManifest(from, to, '2026-06-27T00:00:00.000Z');
        writeManifest(m, '2026-06-27T00:01:00.000Z');
        assert.ok(fs.existsSync(`state/runs/${label}/manifest.json`));
        const back = readManifest(label);
        assert.equal(back!.from, from);
        assert.equal(back!.to, to);
      } finally {
        fs.rmSync(runDir(label), { recursive: true, force: true });
      }
    });
    ```

- [ ] **Step 2: Update `run.test.ts` to the new `createManifest` signature (failing).** Replace each `createManifest(<date>, <now>)` with `createManifest(<date>, <date>, <now>)`. (Do not change any other assertions.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import tsx --test scripts/lib/manifest.test.ts scripts/lib/run.test.ts`
Expected: FAIL (type/shape mismatch — `from`/`to` undefined).

- [ ] **Step 4: Edit `scripts/lib/manifest.ts`.** Apply:
  - Add to the imports at the top: `import { rangeLabel } from './date.ts';`
  - Replace the `Manifest` interface (lines 31-37) with:
    ```ts
    export interface Manifest {
      from: string;
      to: string;
      createdAt: string;
      updatedAt: string;
      notify: NotifyParams | null;
      steps: Record<StepName, StepState>;
      failure: { reason: string; where: string } | null;
    }
    ```
  - Replace `createManifest` (lines 46-54) with:
    ```ts
    export function createManifest(from: string, to: string, now: string): Manifest {
      return {
        from, to, createdAt: now, updatedAt: now, notify: null, failure: null,
        steps: {
          fetch: emptyStep('script'), enrich: emptyStep('script'),
          report: emptyStep('agent'), notify: emptyStep('script'),
        },
      };
    }
    ```
  - Replace `readManifest` (lines 56-60) with:
    ```ts
    export function readManifest(label: string): Manifest | null {
      const p = manifestPath(label);
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest;
    }
    ```
  - Replace `writeManifest` (lines 62-69) with:
    ```ts
    export function writeManifest(m: Manifest, now: string): void {
      m.updatedAt = now;
      const label = rangeLabel(m.from, m.to);
      fs.mkdirSync(runDir(label), { recursive: true });
      const final = manifestPath(label);
      const tmp = final + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
      fs.renameSync(tmp, final);
    }
    ```
  - Replace `loadOrCreateManifest` (lines 71-73) with:
    ```ts
    export function loadOrCreateManifest(from: string, to: string, now: string): Manifest {
      return readManifest(rangeLabel(from, to)) ?? createManifest(from, to, now);
    }
    ```

- [ ] **Step 5: Edit `scripts/lib/run.ts:22`.** Add `import { rangeLabel } from './date.ts';` to the imports, then replace line 22:
  ```ts
  const logger = journalLogger(rangeLabel(m.from, m.to), name, now);
  ```

- [ ] **Step 6: Rename path params for honesty (cosmetic, no behavior change).**
  - In `scripts/lib/runpaths.ts`, rename the parameter `date` → `label` in all three functions and update the JSDoc to `state/runs/<label>/`:
    ```ts
    import * as path from 'node:path';

    /** Per-run directory: state/runs/<label>/ (under the git-ignored state/). */
    export function runDir(label: string): string {
      return path.join('state', 'runs', label);
    }
    export function manifestPath(label: string): string {
      return path.join(runDir(label), 'manifest.json');
    }
    export function journalPath(label: string): string {
      return path.join(runDir(label), 'journal.jsonl');
    }
    ```
  - In `scripts/lib/journal.ts`, rename the parameter `date` → `label` in `appendJournal`, `readJournal`, and `journalLogger` (signatures and bodies). No caller breaks (positional args). The bodies just pass `label` to `runDir`/`journalPath` instead of `date`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --import tsx --test scripts/lib/manifest.test.ts scripts/lib/run.test.ts scripts/lib/journal.test.ts`
Expected: PASS (all).

- [ ] **Step 8: Confirm the rest of the suite still passes**

Run: `npm test`
Expected: PASS. (Whole-tree `tsc` is red now — expected; do not fix it here.)

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/manifest.ts scripts/lib/manifest.test.ts scripts/lib/run.ts scripts/lib/run.test.ts scripts/lib/runpaths.ts scripts/lib/journal.ts
git commit -m "feat: key the run record by date range (from/to + failure field)"
```

---

### Task 3: Fetch over a range + cross-day dedup — `api.ts`, `http.ts`, `extract.ts`

One fetch query over `add_date..add_date_max`; dedup listing rows by id (keep first) before the history pool. `npx tsc --noEmit` stays red (steps.ts/pipeline still old); `npm test` green.

**Files:**
- Modify: `scripts/lib/api.ts:101-120` (`buildSearchBody`)
- Modify: `scripts/lib/http.ts:165-174` (`fetchPage`) — and the `CollectDeps` it satisfies
- Modify: `scripts/lib/extract.ts` (`collectListings` signature + dedup)
- Test: `scripts/lib/api.test.ts`, `scripts/lib/extract.test.ts`

**Interfaces:**
- Produces:
  - `buildSearchBody(from: string, to: string, page?: number): string`
  - `CollectDeps.fetchPage: (from: string, to: string, page: number) => Promise<SearchListResponse>`
  - `collectListings(range: { from: string; to: string }, deps?: CollectDeps, logger?: Logger): Promise<{ listings: Listing[]; dropped: number; duplicates: number }>`

- [ ] **Step 1: Update `api.test.ts` (failing).** Replace the first test and add a range case:
```ts
test('buildSearchBody maps a single day to equal add_date / add_date_max', () => {
  const b = buildSearchBody('2026-06-26', '2026-06-26', 1);
  assert.match(b, /(^|&)add_date=2026-06-26(&|$)/);
  assert.match(b, /(^|&)add_date_max=2026-06-26(&|$)/);
});

test('buildSearchBody maps a range to add_date=from, add_date_max=to', () => {
  const b = buildSearchBody('2026-06-20', '2026-06-25', 1);
  assert.match(b, /(^|&)add_date=2026-06-20(&|$)/);
  assert.match(b, /(^|&)add_date_max=2026-06-25(&|$)/);
});
```
Also update the two other `buildSearchBody('2026-06-26', N)` calls (the "keeps the captured filter" test and the "defaults to page 1" test) to pass both dates: `buildSearchBody('2026-06-26', '2026-06-26', 2)` and `buildSearchBody('2026-06-26', '2026-06-26')`.

- [ ] **Step 2: Update `extract.test.ts` (failing).** Apply:
  - Change every `collectListings('2026-06-26', ...)` / `collectListings('2026-06-27', ...)` call to pass a range object, e.g. `collectListings({ from: '2026-06-26', to: '2026-06-26' }, ...)`.
  - Change every `fetchPage` mock from `async (_d, p) => ...` to `async (_from, _to, p) => ...` (now three params). For the zero-arg mocks (`fetchPage: async () => page(...)`) no change is needed.
  - Add a cross-day dedup test:
    ```ts
    test('collectListings dedupes repeated listing ids within a range (keeps first)', async () => {
      const events: string[] = [];
      const logger = { event: (_l: string, ev: string) => { events.push(ev); } };
      const pages: Record<number, SearchListResponse> = {
        1: page([item(1), item(2)], 40),
        2: page([item(2), item(3)], 40), // id 2 repeats across pages
      };
      const { listings, duplicates } = await collectListings(
        { from: '2026-06-20', to: '2026-06-25' },
        okDeps({ fetchPage: async (_f, _t, p) => pages[p], fetchOnMarketHistory: async (id) => [on(id)] }),
        logger as any,
      );
      assert.deepEqual(listings.map((l) => l.id), [1, 2, 3]);
      assert.equal(duplicates, 1);
      assert.ok(events.includes('fetch.dedup'));
    });
    ```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import tsx --test scripts/lib/api.test.ts scripts/lib/extract.test.ts`
Expected: FAIL.

- [ ] **Step 4: Edit `buildSearchBody` in `scripts/lib/api.ts`.** Change the signature and the two `add_date` lines:
```ts
/** Build the URL-encoded /api/search/list POST body for a date range + page. */
export function buildSearchBody(from: string, to: string, page = 1): string {
  const p = new URLSearchParams();
  p.set('page', String(page));
  p.set('expand', '0');
  p.set('method', 'all_case');
  p.set('on_market', '1');
  p.set('city', '1');
  p.set('price_segment[min_val]', '');
  p.set('price_segment[max_val]', '2500');
  p.set('floor_segment[min_val]', '2');
  p.set('floor_segment[max_val]', '4');
  p.set('total_floor[min_val]', '');
  p.set('total_floor[max_val]', '5');
  p.set('add_date', from);
  p.set('add_date_max', to);
  for (const s of SOURCE_WEB) p.append('source_web[]', s);
  for (const s of SOURCE) p.append('source[]', s);
  p.set('exclude_land', '1');
  return p.toString();
}
```

- [ ] **Step 5: Edit `fetchPage` in `scripts/lib/http.ts:165-174`:**
```ts
async function fetchPage(from: string, to: string, page: number): Promise<SearchListResponse> {
  return withRelogin(async () => {
    const r = await rawPostForm(SEARCH_LIST_URL, buildSearchBody(from, to, page), 'https://www.ibigfun.com/lists/latest');
    applySetCookies(getJar(), r.setCookies);
    if (looksLikeSignin(r)) return { kicked: true };
    const parsed = JSON.parse(r.text) as SearchListResponse;
    assertApiOk('/api/search/list', r.status, parsed.status);
    return { kicked: false, value: parsed };
  });
}
```
(`defaultDeps()` already returns `{ ..., fetchPage, ... }` — the new signature flows through once `CollectDeps` is updated in the next step.)

- [ ] **Step 6: Edit `scripts/lib/extract.ts`.** Apply:
  - Update the `CollectDeps.fetchPage` type (line 19):
    ```ts
    fetchPage: (from: string, to: string, page: number) => Promise<SearchListResponse>;
    ```
  - Change the `collectListings` signature (lines 38-42) and its body. Replace the function header and the "Gather all listing rows" block (through the `items.push` loop) with:
    ```ts
    export async function collectListings(
      range: { from: string; to: string },
      deps: CollectDeps = defaultDeps(),
      logger: Logger = consoleLogger('fetch'),
    ): Promise<{ listings: Listing[]; dropped: number; duplicates: number }> {
      await deps.ensureSession();

      // 1) Gather all listing rows across pages, deduping repeated ids (keep first).
      const first = await deps.fetchPage(range.from, range.to, 1);
      const pages = Math.min(pageCount(first.total_records, first.per_page), MAX_PAGES);
      const items: ListItem[] = [];
      const seen = new Set<number>();
      let duplicates = 0;
      for (let p = 1; p <= Math.max(pages, 1); p++) {
        const res = p === 1 ? first : await deps.fetchPage(range.from, range.to, p);
        if (!res.data || res.data.length === 0) break;
        for (const it of res.data) {
          if (seen.has(it.id)) { duplicates++; continue; }
          seen.add(it.id);
          items.push(it);
        }
      }
      if (duplicates > 0) {
        logger.event('info', 'fetch.dedup',
          `dropped ${duplicates} duplicate listing id(s) within range`, { duplicates });
      }
    ```
  - Leave the history-pool section (`let dropped = 0; const listings = await runPool(...)`) unchanged.
  - Change the final `return` (lines 89) to include `duplicates`:
    ```ts
    return { listings, dropped, duplicates };
    ```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --import tsx --test scripts/lib/api.test.ts scripts/lib/extract.test.ts scripts/lib/http.test.ts`
Expected: PASS (all).

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/api.ts scripts/lib/api.test.ts scripts/lib/http.ts scripts/lib/extract.ts scripts/lib/extract.test.ts
git commit -m "feat: fetch a date range in one query with cross-day dedup"
```

---

### Task 4: Range-aware steps + result types — `steps.ts`, `types.ts`

`fetchStep`/`enrichStep` take a `RunRange`; artifacts keyed by `label`; tenure anchored at `to`; result docs carry `from`/`to`. `tsc` still red (pipeline/fetch/enrich); `npm test` green.

**Files:**
- Modify: `scripts/lib/types.ts:49-55` (`FetchResult`), `:108-117` (`EnrichResult`)
- Modify: `scripts/lib/steps.ts`

**Interfaces:**
- Consumes: `RunRange` from `./range.ts`; `collectListings(range, ...)` returning `{ listings, dropped, duplicates }`; `finalizeWalk(o, routed, anchorDate)`.
- Produces:
  - `fetchStep(range: RunRange, logger: Logger): Promise<StepOutput>`
  - `enrichStep(range: RunRange, logger: Logger): Promise<StepOutput>`
  - `FetchResult { from; to; fetchedAt; count; listings }`, `EnrichResult { from; to; enrichedAt; count; withinWalkCount; manualReviewCount; hardExcludedCount; listings }`

There are no unit tests for `steps.ts`; this task is verified by `npm test` staying green plus a guarded grep (Step 4).

- [ ] **Step 1: Edit `scripts/lib/types.ts`.**
  - Replace `FetchResult` (lines 49-55):
    ```ts
    /** Output document written to state/listings-<label>.json and stdout. */
    export interface FetchResult {
      from: string;
      to: string;
      fetchedAt: string;
      count: number;
      listings: Listing[];
    }
    ```
  - Replace the `targetDate` line in `EnrichResult` (line 110) — change `targetDate: string;` to:
    ```ts
      from: string;
      to: string;
    ```

- [ ] **Step 2: Edit `scripts/lib/steps.ts`.**
  - Add the import: `import type { RunRange } from './range.ts';`
  - Replace the `enrichStep` signature and the date-dependent lines:
    - Header (line 19): `export async function enrichStep(range: RunRange, logger: Logger): Promise<StepOutput> {`
    - Input path (line 20): `const inPath = path.join('state', \`listings-${range.label}.json\`);`
    - The not-found message (line 22): `\`${inPath} not found. Run the fetch step for ${range.label} first.\``
    - `finalizeWalk` call (line 73): `enriched.push(finalizeWalk(o, routed, range.to));`
    - The `result` object (lines 79-82): replace `targetDate: date,` with `from: range.from, to: range.to,`
    - Output path (line 86): `const outPath = path.join('state', \`enriched-${range.label}.json\`);`
  - Replace the `fetchStep` function (lines 100-113) with:
    ```ts
    export async function fetchStep(range: RunRange, logger: Logger): Promise<StepOutput> {
      loadEnv();
      const { listings, dropped, duplicates } = await collectListings(range, undefined, logger);
      const result: FetchResult = {
        from: range.from,
        to: range.to,
        fetchedAt: new Date().toISOString(),
        count: listings.length,
        listings,
      };
      fs.mkdirSync('state', { recursive: true });
      const outPath = path.join('state', `listings-${range.label}.json`);
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
      return { summary: { listings: listings.length, historyDropped: dropped, duplicates }, artifacts: [outPath] };
    }
    ```

- [ ] **Step 3: Verify no other code constructs these result types with `targetDate`.**

Run: `git grep -n "targetDate" -- 'scripts/**/*.ts' | grep -v '\.test\.ts'`
Expected: the only remaining hits are `scripts/lib/tenure.ts` and `scripts/lib/walk.ts`, where `targetDate` is a **function parameter** (the anchor date), NOT a field of `FetchResult`/`EnrichResult`. If any other file builds a `FetchResult`/`EnrichResult` literal with `targetDate`, update it to `from`/`to`.

- [ ] **Step 4: Confirm the suite still passes**

Run: `npm test`
Expected: PASS. (Whole-tree `tsc` still red — expected.)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/types.ts scripts/lib/steps.ts
git commit -m "feat: range-aware fetch/enrich steps (label artifacts, tenure anchored at to)"
```

---

### Task 5: Notify by details-file + fail-details renderer — `notify.ts`

Generalize notify to take an explicit details-file path (decouples it from the date), and add a pure `renderFailDetails`. `tsc` still red (pipeline); `npm test` green.

**Files:**
- Modify: `scripts/lib/notify.ts`
- Test: `scripts/lib/notify.test.ts`

**Interfaces:**
- Consumes: `NotifyParams` from `./manifest.ts`; `JournalEvent` from `./journal.ts`; `RunRange` from `./range.ts`.
- Produces:
  - `composeNotifyArgs(p: NotifyParams, detailsFile: string): string[]`
  - `composeNotifyCommand(p: NotifyParams, detailsFile: string): string`
  - `runNotify(p: NotifyParams, detailsFile: string): { exitCode: number; stderr: string }`
  - `renderFailDetails(range: RunRange, reason: string, tail: JournalEvent[]): string`

- [ ] **Step 1: Update `notify.test.ts` (failing).** Replace the two existing tests' detail argument and add a `renderFailDetails` test:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeNotifyArgs, composeNotifyCommand, renderFailDetails, NOTIFY_TASK } from './notify.ts';

const params = { tool: 'claude', status: 'warn', title: '3 件待覆核' } as const;

test('composeNotifyArgs builds the canonical argv with the given details file', () => {
  assert.deepEqual(composeNotifyArgs(params, 'reports/2026-06-26.md'), [
    '--tool', 'claude',
    '--status', 'warn',
    '--task', NOTIFY_TASK,
    '--title', '3 件待覆核',
    '--details-file', 'reports/2026-06-26.md',
  ]);
});

test('composeNotifyCommand quotes args with spaces for safe display', () => {
  const cmd = composeNotifyCommand(params, 'reports/2026-06-26.md');
  assert.ok(cmd.startsWith('ai-notify --tool claude --status warn'));
  assert.ok(cmd.includes("--task '每日 iBigFun 投資房源監測'"));
  assert.ok(cmd.includes("--title '3 件待覆核'"));
  assert.ok(cmd.includes('--details-file reports/2026-06-26.md'));
});

test('renderFailDetails includes the range, reason, and journal tail lines', () => {
  const range = { from: '2026-06-20', to: '2026-06-25', label: '2026-06-20_2026-06-25' };
  const tail = [
    { ts: '2026-06-27T00:00:00.000Z', step: 'fetch', level: 'error', event: 'step.error', msg: 'fetch failed: boom' },
  ] as const;
  const md = renderFailDetails(range, 'login blocked', tail as any);
  assert.ok(md.includes('2026-06-20_2026-06-25'));
  assert.ok(md.includes('2026-06-20 → 2026-06-25'));
  assert.ok(md.includes('login blocked'));
  assert.ok(md.includes('fetch:step.error fetch failed: boom'));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test scripts/lib/notify.test.ts`
Expected: FAIL (`renderFailDetails` not exported; arg mismatch).

- [ ] **Step 3: Rewrite `scripts/lib/notify.ts`:**
```ts
import { spawnSync } from 'node:child_process';
import type { NotifyParams } from './manifest.ts';
import type { JournalEvent } from './journal.ts';
import type { RunRange } from './range.ts';

export const NOTIFY_TASK = '每日 iBigFun 投資房源監測';

/** Canonical ai-notify argv (see AGENTS.md "Canonical Notification Command"). */
export function composeNotifyArgs(p: NotifyParams, detailsFile: string): string[] {
  return [
    '--tool', p.tool,
    '--status', p.status,
    '--task', NOTIFY_TASK,
    '--title', p.title,
    '--details-file', detailsFile,
  ];
}

function shellQuote(arg: string): string {
  return /[^A-Za-z0-9_./-]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}

/** Human-readable command string for --dry-run / journaling. Display only. */
export function composeNotifyCommand(p: NotifyParams, detailsFile: string): string {
  return 'ai-notify ' + composeNotifyArgs(p, detailsFile).map(shellQuote).join(' ');
}

/** Execute ai-notify for real; returns its exit code + stderr. */
export function runNotify(p: NotifyParams, detailsFile: string): { exitCode: number; stderr: string } {
  const r = spawnSync('ai-notify', composeNotifyArgs(p, detailsFile), { encoding: 'utf8' });
  if (r.error) return { exitCode: 1, stderr: r.error.message };
  return { exitCode: r.status ?? 1, stderr: r.stderr ?? '' };
}

/**
 * Markdown body for a fail notification. Built ONLY from the operator reason
 * and the (already redact()-ed) journal tail — never raw secrets.
 */
export function renderFailDetails(range: RunRange, reason: string, tail: JournalEvent[]): string {
  const lines = [
    `# 監測中斷 ${range.label}`,
    ``,
    `- 區間: ${range.from} → ${range.to}`,
    `- 原因: ${reason}`,
    ``,
    `## journal (最後 ${tail.length} 筆)`,
    ...tail.map((e) => `- ${e.ts} [${e.level}] ${e.step}:${e.event} ${e.msg}`),
  ];
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test scripts/lib/notify.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the suite still passes**

Run: `npm test`
Expected: PASS. (`tsc` still red — expected; Task 6 closes it.)

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/notify.ts scripts/lib/notify.test.ts
git commit -m "feat: notify by details-file + renderFailDetails for fail notifications"
```

---

### Task 6: Rewire the orchestrator + CLIs to ranges — `pipeline.ts`, `fetch.ts`, `enrich.ts`

Thread `RunRange` through `run` / `status` / `mark`; update the standalone `fetch`/`enrich` CLIs. **This task restores whole-tree `npx tsc --noEmit` to green.**

**Files:**
- Modify: `scripts/pipeline.ts`
- Modify: `scripts/fetch.ts`
- Modify: `scripts/enrich.ts`

**Interfaces:**
- Consumes: `resolveRange`, `rangeFlags`, `RunRange` from `./lib/range.ts`; the Task 2/4/5 signatures.

- [ ] **Step 1: Edit `scripts/pipeline.ts`.**
  - Replace the date import line (line 17) — remove it (no longer needed):
    delete `import { previousTaipeiDay, isValidDateString } from './lib/date.ts';`
  - Add after the manifest import block:
    ```ts
    import { resolveRange, rangeFlags, type RunRange } from './lib/range.ts';
    ```
  - Replace `resolveDate` (lines 42-50) with:
    ```ts
    function resolveRangeOrExit(argv: string[]): RunRange {
      try {
        return resolveRange(argv, new Date());
      } catch (e) {
        fail((e as Error).message);
      }
    }
    ```
  - In `cmdRun`, replace `const date = resolveDate(argv);` with `const range = resolveRangeOrExit(argv);`, then replace `loadOrCreateManifest(date, now())` with `loadOrCreateManifest(range.from, range.to, now())`. Replace the report-step `console.error(...)` block (lines 74-79) with:
    ```ts
        console.error(
          `\n■ report is an agent step — it cannot be auto-run.\n` +
          `  Do the agent work (triage, estimate, evaluate, write reports/${range.label}.md), then run:\n` +
          `    npm run pipeline -- mark report --status ok --artifact reports/${range.label}.md \\\n` +
          `      --status-notify <ok|warn|fail> --title "<short>" --tool <codex|claude>\n` +
          `  Then re-run: npm run pipeline -- run ${rangeFlags(range)}\n`);
    ```
    In the `notify` branch, replace `composeNotifyCommand(m.notify, date)` with `composeNotifyCommand(m.notify, \`reports/${range.label}.md\`)` and `runNotify(m.notify as NotifyParams, date)` with `runNotify(m.notify as NotifyParams, \`reports/${range.label}.md\`)`.
    In the script-step branch, replace `(logger) => fn(date, logger)` with `(logger) => fn(range, logger)`.
    Replace the failure/ok messages' `${date}` with `${range.label}` (the `status --date ...` hint becomes `status ${rangeFlags(range)}`), and the final line `Run ${date} reached...` with `Run ${range.label} reached...`.
  - In `cmdStatus`, replace `const date = resolveDate(argv);` with `const range = resolveRangeOrExit(argv);`, `readManifest(date)` with `readManifest(range.label)`, the absent-run message and header `${date}` with `${range.label}`, and `readJournal(date)` with `readJournal(range.label)`. After the `for (const name of STEP_ORDER)` loop, add:
    ```ts
      if (m.failure) console.error(`  FAILED: ${m.failure.reason} (at ${m.failure.where})`);
    ```
  - In `cmdMark`, replace `const date = resolveDate(argv);` with `const range = resolveRangeOrExit(argv);`, `readManifest(date) ?? loadOrCreateManifest(date, now())` with `readManifest(range.label) ?? loadOrCreateManifest(range.from, range.to, now())`, `journalLogger(date, step, now)` with `journalLogger(range.label, step, now)`, and the final message `${date}` with `${range.label}`.
  - Update the header docstring usage block to mention `[--date <d> | --from <d> --to <d>]` and that a single day is the default.

- [ ] **Step 2: Edit `scripts/fetch.ts`.**
  - Replace the date import (line 16) `import { previousTaipeiDay, isValidDateString } from './lib/date.ts';` with `import { resolveRange, type RunRange } from './lib/range.ts';`
  - Replace `resolveTargetDate` (lines 21-33) with:
    ```ts
    /** Resolve --date / --from/--to; map a bad range to a BlockedError (exit 2). */
    function resolveRangeOrThrow(argv: string[]): RunRange {
      try {
        return resolveRange(argv, new Date());
      } catch (e) {
        throw new BlockedError((e as Error).message);
      }
    }
    ```
  - Replace `main` (lines 35-40) with:
    ```ts
    async function main(): Promise<void> {
      const range = resolveRangeOrThrow(process.argv.slice(2));
      const { artifacts } = await fetchStep(range, consoleLogger('fetch'));
      console.error(`Wrote listings to ${artifacts![0]}`);
      process.stdout.write(fs.readFileSync(artifacts![0], 'utf8'));
    }
    ```

- [ ] **Step 3: Edit `scripts/enrich.ts`.**
  - Replace the date import (line 25) `import { previousTaipeiDay, isValidDateString } from './lib/date.ts';` with `import { resolveRange, rangeFlags, type RunRange } from './lib/range.ts';`
  - Delete `resolveTargetDate` (lines 34-42).
  - Replace `main` (lines 44-53) with:
    ```ts
    async function main(): Promise<void> {
      let range: RunRange;
      try {
        range = resolveRange(process.argv.slice(2), new Date());
      } catch (e) {
        fail((e as Error).message);
      }
      const inPath = `state/listings-${range.label}.json`;
      if (!fs.existsSync(inPath)) {
        fail(`${inPath} not found. Run "npm run fetch -- ${rangeFlags(range)}" first.`);
      }
      const { artifacts } = await enrichStep(range, consoleLogger('enrich'));
      console.error(`Wrote enriched listings to ${artifacts![0]}`);
      process.stdout.write(fs.readFileSync(artifacts![0], 'utf8'));
    }
    ```
    (`fail` returns `never`, so `range` is definitely assigned after the try/catch.)

- [ ] **Step 4: Verify the whole tree type-checks**

Run: `npx tsc --noEmit`
Expected: PASS (no output). If anything is red, it is a real wiring gap to fix here — this is the task that closes the type-check.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS (all listed files).

- [ ] **Step 6: Smoke-test the CLI wiring offline (no network, no send).**

Run:
```bash
npm run pipeline -- status --date 2099-09-09
npm run pipeline -- status --from 2099-09-08 --to 2099-09-09
npm run pipeline -- run --date 2099-09-09 --from 2099-09-09 --to 2099-09-09 ; echo "exit=$?"
```
Expected: the two `status` calls print `No run found for 2099-09-09 …` and `… 2099-09-08_2099-09-09 …` respectively (exit 0); the `run` call prints `BAD INPUT: use --date alone, or --from/--to together (not both).` and `exit=2`.

- [ ] **Step 7: Commit**

```bash
git add scripts/pipeline.ts scripts/fetch.ts scripts/enrich.ts
git commit -m "feat: thread date ranges through pipeline/fetch/enrich CLIs"
```

---

### Task 7: Failure escape hatch — `pipeline fail`

A first-class command the headless worker calls on any unrecoverable error before `report`: record the run-level failure, write a safe details file from the journal tail, and send one `status=fail` notification (reusing `notify.ts`). Includes `--dry-run` for offline verification.

**Files:**
- Modify: `scripts/pipeline.ts`

**Interfaces:**
- Consumes: `renderFailDetails`, `runNotify`, `composeNotifyCommand` from `./lib/notify.ts`; `readJournal` from `./lib/journal.ts`; `runDir` from `./lib/runpaths.ts`; `NotifyParams` from `./lib/manifest.ts`.

- [ ] **Step 1: Add imports to `scripts/pipeline.ts`.**
  - At the top, add: `import * as fs from 'node:fs';` and `import * as path from 'node:path';`
  - Add `runDir` to the runpaths import (create the import if absent): `import { runDir } from './lib/runpaths.ts';`
  - Add `readJournal` to the existing journal import (it already imports `readJournal, journalLogger`).
  - Add `renderFailDetails` to the notify import: `import { composeNotifyCommand, runNotify, renderFailDetails } from './lib/notify.ts';`

- [ ] **Step 2: Add the `cmdFail` function** (place it after `cmdMark`):
```ts
async function cmdFail(argv: string[]): Promise<void> {
  const range = resolveRangeOrExit(argv);
  const reason = flag(argv, '--reason');
  if (!reason || reason.startsWith('--')) fail('fail requires --reason "<short>".');
  const tool = flag(argv, '--tool') ?? 'claude';
  if (tool !== 'codex' && tool !== 'claude') fail('--tool must be codex|claude.');
  const title = flag(argv, '--title') ?? '每日監測中斷';
  const dryRun = has(argv, '--dry-run');

  const m = readManifest(range.label) ?? loadOrCreateManifest(range.from, range.to, now());
  if (m.steps.notify.status === 'ok') {
    console.error('notify already sent for this run; not sending a fail notification.');
    process.exit(0);
  }
  m.failure = { reason, where: 'pipeline fail' };
  writeManifest(m, now());

  const tail = readJournal(range.label).slice(-20);
  const detailsFile = path.join(runDir(range.label), 'fail-details.md');
  fs.mkdirSync(runDir(range.label), { recursive: true });
  fs.writeFileSync(detailsFile, renderFailDetails(range, reason, tail));

  const params: NotifyParams = { tool, status: 'fail', title };
  if (dryRun) {
    console.error(`[dry-run] wrote ${detailsFile}; would send:\n  ${composeNotifyCommand(params, detailsFile)}`);
    process.exit(0);
  }
  journalLogger(range.label, 'notify', now).event('error', 'run.fail', `run failed: ${reason}`, { reason });
  const { exitCode, stderr } = runNotify(params, detailsFile);
  journalLogger(range.label, 'notify', now).event(exitCode === 0 ? 'info' : 'error', 'notify.sent',
    `fail notification ai-notify exited ${exitCode}`, { exitCode, stderr });
  if (exitCode !== 0) { console.error(`✗ fail notification failed: ${stderr.trim()}`); process.exit(1); }
  console.error(`✓ fail notification sent for ${range.label} (${reason}).`);
}
```

- [ ] **Step 3: Register the command in `main`.** Replace the dispatch block:
```ts
  if (cmd === 'run') return cmdRun(rest);
  if (cmd === 'status') return cmdStatus(rest);
  if (cmd === 'mark') return cmdMark(rest);
  if (cmd === 'fail') return cmdFail(rest);
  fail(`unknown command "${cmd ?? ''}"; expected run|status|mark|fail.`);
```
Also add a `fail` line to the header docstring's command list.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Smoke-test `fail --dry-run` offline (writes details, does not send).**

Run:
```bash
npm run pipeline -- fail --date 2099-09-09 --reason "smoke test" --dry-run ; echo "exit=$?"
cat state/runs/2099-09-09/fail-details.md
npm run pipeline -- fail --date 2099-09-09 ; echo "exit=$?"
rm -rf state/runs/2099-09-09
```
Expected: the first call prints `[dry-run] wrote state/runs/2099-09-09/fail-details.md; would send: ai-notify --tool claude --status fail …` and `exit=0`; the `cat` shows a markdown body containing `監測中斷 2099-09-09`, `原因: smoke test`; the third call (no `--reason`) prints `BAD INPUT: fail requires --reason "<short>".` and `exit=2`.

- [ ] **Step 6: Full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/pipeline.ts
git commit -m "feat: pipeline fail — headless failure notification from journal tail"
```

---

### Task 8: Worker prompt + docs — `prompts/daily-run.md`, `AGENTS.md`

The committed, range-agnostic headless worker prompt, plus doc updates. No code/tests change; verified by `npm test` + `tsc` staying green and a read-through.

**Files:**
- Create: `prompts/daily-run.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Create `prompts/daily-run.md`:**

````markdown
# Daily iBigFun Monitor — Worker Prompt (headless, autonomous)

你是每日 iBigFun 投資房源監測 agent，以 headless 自動方式執行。**全程不得停下來問人**——沒有人在看。判斷規則以 `AGENTS.md` 與 `docs/reporting-rules.md` 為準；本檔釘死「精確指令」與「headless 失敗/續跑政策」。

## 監測區間（由 trigger 注入）

Trigger 會在訊息裡告訴你要監測的區間。把它對應成 pipeline 參數，**你不自行計算日期**：

- 給了起訖（from / to）→ `--from <from> --to <to>`
- 給了單一日期 → `--date <date>`
- 沒給 → 省略參數，pipeline 自動用「前一個台北日」（最常見的夜跑）

下文用 `[範圍參數]` 代表上面對應出來的參數（可能是空字串）。

## 動手前先讀

`AGENTS.md` 與 `docs/reporting-rules.md`——估價、評估、走路距離三角定位、可疑物件判斷都以它們為準。

## 執行流程（指令照抄）

1. 跑 orchestrator：

   ```
   npm run pipeline -- run [範圍參數]
   ```

   它會跑 fetch + enrich，然後**停在 agent `report` 步**並印出需求；已經 ok 的步會被 skip（重跑＝自動續跑）。若它印出 `report` 步的需求，繼續第 2 步；若它以非 0 結束（fetch/enrich 失敗），跳到「Headless 失敗政策」。

2. 親手完成 `report` 步：對 `state/enriched-<label>.json` 做 `withinWalk:null` 三角定位、估價、評估、跨日彙整，依 `docs/reporting-rules.md` 與報告模板寫出**一份**合併報告到 orchestrator 指定的 `reports/<label>.md`。

3. 標記完成（會自動觸發 notify，idempotent）：

   ```
   npm run pipeline -- mark report --status ok --artifact reports/<label>.md \
     --status-notify <ok|warn|fail> --title "<short>" --tool claude
   npm run pipeline -- run [範圍參數]
   ```

   第二行重跑會把 `notify` 步送出。完成。

## status 對應

- `warn`：有推薦、接近門檻、資料偏舊、登入 fallback，或有任何 manual-review 項。
- `ok`：乾淨、無推薦、資料新鮮。
- `fail`：監測無法完成（見下）。

## Headless 失敗政策（沒有人在看）

- 登入被 CAPTCHA / 2FA / 帳號風控擋住：**絕不繞過**。走失敗逃生口。
- 任何 fetch / enrich 不可恢復的錯誤（pipeline 以非 0 結束）：走失敗逃生口，不要無限重試。
- **部分失敗不是 fail**：例如 ORS 路由全掛時，受影響物件標記為 manual-review、照常出 `warn`，不要當成 fail（`AGENTS.md`：走路距離不可靠者永不自動排除）。
- 失敗逃生口（唯一一條）：

  ```
  npm run pipeline -- fail [範圍參數] --reason "<短原因>" --tool claude
  ```

  它會記錄 run-level 失敗、用安全的 journal tail 組一份 details，送出**一則** `status=fail` 通知，然後停。送出前可先加 `--dry-run` 檢查要送的內容。

## 完成判準

報告已寫且 `notify` 記為 `ok`，**或**失敗逃生口已送出 `fail`。事後都可用 `npm run pipeline -- status [範圍參數]` 與 journal 檢視——不會有靜默失敗。

## 安全（完整清單見 `AGENTS.md`）

不印 `IBIGFUN_ACCOUNT` / `IBIGFUN_PASSWORD`；不 commit `state/`、`reports/`；不繞過登入控制。
````

- [ ] **Step 2: Update `AGENTS.md`.** Make these edits:
  - In the **Tooling** section, under the `npm run pipeline` bullet, change the run description to note ranges. Replace the line beginning `npm run pipeline -- run [--date <target>]` with:
    ```
    - `npm run pipeline -- run [--date <target> | --from <a> --to <b>]` — thin
      orchestrator over fetch → enrich → report → notify. A run covers an
      inclusive date range; a single day is the default (previous Taipei day) and
      uses the bare date as its label. A multi-day range uses the label
      `<from>_<to>`. One run per label is recorded under `state/runs/<label>/`;
      artifacts are `state/listings-<label>.json`, `state/enriched-<label>.json`,
      `reports/<label>.md`. A whole range is fetched in **one** query
      (`add_date`/`add_date_max`), deduped by listing id, and emitted as **one**
      merged report + **one** notification. Already-ok steps are skipped, so
      re-running resumes.
    ```
  - Add a new bullet after the `mark report` bullet:
    ```
    - `npm run pipeline -- fail [--date <d> | --from <a> --to <b>] --reason "<short>"
      [--tool <codex|claude>] [--dry-run]` — headless failure escape hatch: marks
      the run failed, writes a safe details file from the (redacted) journal tail,
      and sends one `status=fail` notification. `--dry-run` writes the details and
      prints the composed command without sending.
    ```
  - Add a bullet to the **Source-Of-Truth Map**:
    ```
    - `prompts/daily-run.md`: the committed headless worker prompt for the daily
      automated run (range-agnostic; the trigger injects the date range).
    ```

- [ ] **Step 3: Verify nothing regressed**

Run: `npm test && npx tsc --noEmit`
Expected: PASS (both).

- [ ] **Step 4: Commit**

```bash
git add prompts/daily-run.md AGENTS.md
git commit -m "docs: headless worker prompt + range/fail docs in AGENTS.md"
```

---

## Self-Review (controller, before final review)

- **Spec coverage:** range output as one digest (T3 dedup + T4 label artifacts + T6 one report path + notify one send); label rule `<date>`/`<from>_<to>` (T1 `rangeLabel`, used everywhere); dedup deterministic keep-first (T3); CLI `--from/--to` + `--date` shorthand + default (T1 `resolveRange`, T6 wiring); `pipeline fail` (T7) reusing `notify.ts` with journal-tail details (T5 `renderFailDetails`); two-layer prompt (T8 `prompts/daily-run.md`, range-agnostic); safety (journal redaction reused; fail details from redacted tail). All spec sections map to a task.
- **Single-day regression:** default path resolves `[d,d]` → label `<date>` → identical artifacts and `add_date===add_date_max` (Global Constraints + T1/T3/T6 smokes).
- **tsc window:** intentionally red T2–T5; restored at T6 Step 4 (`tsc --noEmit` green) and re-verified T7/T8. Implementers are told not to touch `pipeline.ts`/`fetch.ts`/`enrich.ts` before T6.
- **Type consistency:** `RunRange { from,to,label }` used identically in `range.ts`, `steps.ts`, `notify.ts`, `pipeline.ts`. `collectListings` returns `{ listings, dropped, duplicates }` (T3) consumed in `fetchStep` (T4). `composeNotifyArgs(p, detailsFile)` (T5) called with a details path in `pipeline.ts` (T6/T7).
