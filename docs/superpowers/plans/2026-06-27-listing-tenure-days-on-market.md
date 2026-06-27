# Listing Tenure (Days on Market) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, per listing, how long the property has actually been on the market (across all sources, including delisted records) and whether its price ever changed — sourced from iBigFun's inline 刊登紀錄 table.

**Architecture:** `fetch`/`extract.ts` parses the inline `table.sub-table` 刊登紀錄 per listing row into raw `listingHistory`. `enrich` derives a deterministic `tenure` summary (`daysOnMarket`, `firstListedDate`, `priceTrend`, …) via a new pure `computeTenure`. The notify template gets a 🕒 line composed by the agent from `tenure`. No new scraping requests — the table is already in the list-page DOM.

**Tech Stack:** TypeScript (ESM, `.ts` imports), `tsx`, Node's built-in `node:test`, Playwright (`page.$$eval`).

## Global Constraints

- Pure logic lives in `scripts/lib/*.ts` and is unit-tested with `node:test` + `node:assert/strict`; intra-package imports use explicit `.ts` extensions (e.g. `from './date.ts'`).
- `npm test` runs only the files listed in `package.json`'s `test` script — every new `*.test.ts` MUST be appended there or it never runs.
- Type correctness of files NOT imported by tests (e.g. `extract.ts`) is verified with `npx tsc --noEmit`; it is clean today and must stay clean.
- Numbers stay deterministic and in `enrich`; the agent never computes days/price math. Presentation rules live in `docs/reporting-rules.md`; the template (`templates/daily-notify-template.md`) is filled by the agent from enriched JSON.
- This feature is **information-only**: do NOT change any recommend / near-threshold / hard-exclusion / suspicious threshold or sorting.
- Date strings are `YYYY-MM-DD`; lexicographic comparison equals chronological comparison.
- DOM facts verified live 2026-06-27: 20 listing rows ↔ 20 `table.sub-table`; each listing's history table is in a following sibling `tr.review-data` before the next `a.subject_href` row; sub-table header cells are `<th>`, data rows are `<td>`×4 = `[總價, 案件名稱(link when active), 來源, 刊登日]`; delisted rows have no link in the name cell and text begins `(下架)`; prices may contain commas (`"1,588"`); sub-table `<a>` elements are class-less (`a.subject_href` count inside a sub-table is 0).

---

### Task 1: `daysBetween` calendar-day helper

**Files:**
- Modify: `scripts/lib/date.ts`
- Test: `scripts/lib/date.test.ts`

**Interfaces:**
- Produces: `daysBetween(fromYMD: string, toYMD: string): number` — whole calendar days from `fromYMD` to `toYMD` (positive when `toYMD` is later). Assumes both are valid `YYYY-MM-DD`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/lib/date.test.ts`:

```ts
import { daysBetween } from './date.ts';

test('daysBetween counts whole calendar days, crossing months', () => {
  assert.equal(daysBetween('2026-06-26', '2026-06-26'), 0);
  assert.equal(daysBetween('2026-06-05', '2026-06-26'), 21);
  assert.equal(daysBetween('2025-09-07', '2026-06-26'), 292);
  assert.equal(daysBetween('2026-06-26', '2026-06-05'), -21); // reversed -> negative
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test scripts/lib/date.test.ts`
Expected: FAIL — `daysBetween` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `scripts/lib/date.ts`, add (reuse the existing `DAY_MS` constant at top of file):

```ts
/** Whole calendar days from `fromYMD` to `toYMD` (negative if reversed). */
export function daysBetween(fromYMD: string, toYMD: string): number {
  const [fy, fm, fd] = fromYMD.split('-').map(Number);
  const [ty, tm, td] = toYMD.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test scripts/lib/date.test.ts`
Expected: PASS (all date tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/date.ts scripts/lib/date.test.ts
git commit -m "feat: add daysBetween calendar-day helper"
```

---

### Task 2: Extract inline 刊登紀錄 into `listingHistory`

**Files:**
- Modify: `scripts/lib/types.ts` (add `ListingHistoryEntry`, add `listingHistory` to `Listing`)
- Create: `scripts/lib/history.ts` (`RawHistoryRow`, `normalizeHistory`)
- Create: `scripts/lib/history.test.ts`
- Modify: `scripts/lib/config.ts` (add `historyTable` selector)
- Modify: `scripts/lib/extract.ts` (parse sub-table; pass through)
- Modify: `scripts/lib/walk.test.ts` and `scripts/lib/enrich-offline.test.ts` (fixture literals gain `listingHistory: []`)
- Modify: `package.json` (add `history.test.ts` to the `test` script)

**Interfaces:**
- Consumes: `isValidDateString` from `./date.ts`.
- Produces:
  - `interface ListingHistoryEntry { date: string; source: string; price: string | null; active: boolean }`
  - `Listing.listingHistory: ListingHistoryEntry[]`
  - `interface RawHistoryRow { price: string | null; source: string | null; date: string | null; active: boolean }`
  - `normalizeHistory(rows: RawHistoryRow[]): ListingHistoryEntry[]`

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/history.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistory, type RawHistoryRow } from './history.ts';

const rows: RawHistoryRow[] = [
  { price: '1588', source: '樂屋網', date: '2026-06-26', active: true },
  { price: '1,588', source: '591', date: '2026-06-05', active: false }, // delisted
  { price: '1588', source: '  ', date: '2026-06-12', active: true },     // blank source
  { price: '1588', source: '591', date: '案件名稱', active: true },       // header / junk date
  { price: '', source: '好房網', date: '2026-04-04', active: false },     // empty price -> null
];

test('keeps only valid-date rows and normalizes fields', () => {
  const out = normalizeHistory(rows);
  assert.equal(out.length, 4); // the "案件名稱" junk-date row is dropped
  assert.deepEqual(out[0], { date: '2026-06-26', source: '樂屋網', price: '1588', active: true });
  assert.equal(out[1].active, false);          // delisted preserved
  assert.equal(out[1].price, '1,588');         // comma kept (parsed later)
  assert.equal(out[2].source, '');             // blank source trimmed to ''
  assert.equal(out[3].price, null);            // empty price -> null
});

test('empty input yields empty array', () => {
  assert.deepEqual(normalizeHistory([]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test scripts/lib/history.test.ts`
Expected: FAIL — `./history.ts` cannot be found.

- [ ] **Step 3: Add the type, then `history.ts`**

In `scripts/lib/types.ts`, add the entry interface above `Listing` and a field on `Listing`:

```ts
/** One row of iBigFun's 刊登紀錄: this property's appearance on one source/date. */
export interface ListingHistoryEntry {
  date: string; // "2026-06-05"
  source: string; // "樂屋網" | "591" | …; "" when blank
  price: string | null; // raw token, e.g. "1588" / "1,588"; null when absent
  active: boolean; // false = a (下架) record
}
```

Add to the `Listing` interface (after `realPriceUrl`):

```ts
  /** Cross-source posting history from iBigFun's 刊登紀錄 (incl. delisted); [] if none. */
  listingHistory: ListingHistoryEntry[];
```

Create `scripts/lib/history.ts`:

```ts
/**
 * Normalize the raw rows read from a listing's inline 刊登紀錄 (`table.sub-table`)
 * into `ListingHistoryEntry[]`. Pure: the DOM reading happens in extract.ts; this
 * just drops non-date rows (header / junk) and trims. Price keeps its raw token
 * (commas and all) — parse.ts handles the number later, in enrich.
 */
import type { ListingHistoryEntry } from './types.ts';
import { isValidDateString } from './date.ts';

/** A history row as read straight from the sub-table DOM. */
export interface RawHistoryRow {
  price: string | null;
  source: string | null;
  date: string | null;
  active: boolean;
}

export function normalizeHistory(rows: RawHistoryRow[]): ListingHistoryEntry[] {
  return rows
    .filter((r) => r.date != null && isValidDateString(r.date))
    .map((r) => ({
      date: r.date as string,
      source: (r.source ?? '').trim(),
      price: r.price && r.price.trim() ? r.price.trim() : null,
      active: r.active,
    }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test scripts/lib/history.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the selector and wire extraction**

In `scripts/lib/config.ts`, inside `SELECTORS.list` (after `realPriceLink`), add:

```ts
    // The listing's inline 刊登紀錄 (posting history) table. Lives in a following
    // sibling `tr.review-data` before the next listing row; class-less <a> inside,
    // so it never matches `titleLink`. Verified against live DOM 2026-06-27.
    historyTable: 'table.sub-table',
```

In `scripts/lib/extract.ts`:

1. Add imports near the top:

```ts
import { normalizeHistory, type RawHistoryRow } from './history.ts';
```

2. Add `historyRows` to the `RawCard` interface (after `realPriceUrl`):

```ts
  historyRows: RawHistoryRow[];
```

3. In `toListing`, add to the returned object (after `realPriceUrl`):

```ts
    listingHistory: normalizeHistory(r.historyRows),
```

4. Replace the body of `extractListingsOnPage`'s `page.$$eval` so it pairs each listing row with its sibling history table. Replace the whole `const raw: RawCard[] = await page.$$eval(...)` call with:

```ts
  const raw: RawCard[] = await page.$$eval(
    SELECTORS.list.cardRow,
    (rows, s) => {
      const txt = (el: Element | null) =>
        el ? (el as HTMLElement).innerText.trim() || null : null;
      const lines = (el: Element | null) =>
        el
          ? (el as HTMLElement).innerText
              .split('\n')
              .map((x) => x.trim())
              .filter(Boolean)
          : [];
      const parseHistory = (sub: Element) =>
        Array.from(sub.querySelectorAll('tr'))
          .filter((tr) => !tr.querySelector('th')) // skip the header row
          .map((tr) => {
            const c = tr.querySelectorAll('td');
            if (c.length < 4) return null;
            return {
              price: (c[0] as HTMLElement).innerText.trim() || null,
              source: (c[2] as HTMLElement).innerText.trim() || null,
              date: (c[3] as HTMLElement).innerText.trim() || null,
              active: !!c[1].querySelector('a'),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);

      const out = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.querySelector(s.titleLink)) continue;
        // The history table sits in a sibling row before the next listing row.
        let historyRows: ReturnType<typeof parseHistory> = [];
        for (let j = i + 1; j < rows.length; j++) {
          if (rows[j].querySelector(s.titleLink)) break;
          const sub = rows[j].querySelector(s.historyTable);
          if (sub) {
            historyRows = parseHistory(sub);
            break;
          }
        }
        const subj = r.querySelector(s.titleLink) as HTMLAnchorElement | null;
        const map = r.querySelector(s.mapLink) as HTMLAnchorElement | null;
        const real = r.querySelector(s.realPriceLink) as HTMLAnchorElement | null;
        const trainIcon = r.querySelector(s.nearbyStationIcon);
        const tds = Array.from(r.querySelectorAll(':scope > td'));
        const td = (k: number) => tds[k] ?? null;
        out.push({
          title: txt(subj) ?? '',
          url: subj ? subj.href : null,
          addressOrArea: txt(map),
          nearbyStation:
            trainIcon && trainIcon.parentElement
              ? trainIcon.parentElement.innerText.trim() || null
              : null,
          mapHref: map ? map.getAttribute('href') : null,
          publishedDate: txt(td(s.td.date)),
          priceLines: lines(td(s.td.price)),
          pingLines: lines(td(s.td.ping)),
          landFloor: lines(td(s.td.landFloor)),
          typePattern: lines(td(s.td.typePattern)),
          ageParking: lines(td(s.td.ageParking)),
          realPriceUrl: real ? real.href : null,
          historyRows,
        });
      }
      return out;
    },
    SELECTORS.list,
  );
  return raw.map(toListing);
```

5. Update the two test fixtures so they still type-check. In `scripts/lib/walk.test.ts`, add `listingHistory: [],` to the object returned by `offline(...)` (e.g. right after `realPriceUrl: null,`). In `scripts/lib/enrich-offline.test.ts`, add `listingHistory: [],` to the object returned by `listing(...)` (after `realPriceUrl: null,`).

6. In `package.json`, append `scripts/lib/history.test.ts` to the `test` script's file list (before `scripts/lib/relogin.test.ts` is fine).

- [ ] **Step 6: Run the full suite and the typecheck**

Run: `npm test`
Expected: PASS, including the new `history.test.ts`.

Run: `npx tsc --noEmit`
Expected: no output (clean) — confirms `extract.ts`, `config.ts`, and the fixtures type-check with the new `listingHistory` field.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/types.ts scripts/lib/history.ts scripts/lib/history.test.ts \
  scripts/lib/config.ts scripts/lib/extract.ts scripts/lib/walk.test.ts \
  scripts/lib/enrich-offline.test.ts package.json
git commit -m "feat: extract iBigFun 刊登紀錄 into listingHistory"
```

---

### Task 3: Derive `tenure` in enrichment

**Files:**
- Modify: `scripts/lib/types.ts` (add `ListingTenure`, add `tenure` to `EnrichedListing`)
- Create: `scripts/lib/tenure.ts` (`computeTenure`)
- Create: `scripts/lib/tenure.test.ts`
- Modify: `scripts/lib/walk.ts` (`finalizeWalk` takes `targetDate`, sets `tenure`)
- Modify: `scripts/enrich.ts` (pass `targetDate` to `finalizeWalk`)
- Modify: `scripts/lib/walk.test.ts` (two tenure assertions)
- Modify: `package.json` (add `tenure.test.ts` to the `test` script)

**Interfaces:**
- Consumes: `ListingHistoryEntry`, `Listing.listingHistory` (Task 2); `firstNumber` from `./parse.ts`; `daysBetween` (Task 1) and `isValidDateString` from `./date.ts`.
- Produces:
  - `interface ListingTenure { firstListedDate: string | null; daysOnMarket: number | null; recordCount: number; sourceCount: number; priceTrend: 'flat' | 'dropped' | 'raised' | 'unknown'; firstPrice: number | null; latestPrice: number | null }`
  - `EnrichedListing.tenure: ListingTenure`
  - `computeTenure(history: ListingHistoryEntry[], targetDate: string): ListingTenure`
  - `finalizeWalk(o: OfflineEnriched, routed: (number | null)[] | null, targetDate?: string): EnrichedListing` (new optional 3rd param; defaults to `''` → `daysOnMarket` null)

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/tenure.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTenure } from './tenure.ts';
import type { ListingHistoryEntry } from './types.ts';

const e = (date: string, price: string | null, source = '591', active = true): ListingHistoryEntry => ({
  date, price, source, active,
});

test('earliest date (incl. delisted) drives firstListedDate and daysOnMarket', () => {
  const t = computeTenure(
    [e('2026-06-26', '1588', '樂屋網'), e('2026-06-05', '1,588', '591', false), e('2025-09-07', '1588', '591', false)],
    '2026-06-26',
  );
  assert.equal(t.firstListedDate, '2025-09-07');
  assert.equal(t.daysOnMarket, 292);
  assert.equal(t.recordCount, 3);
  assert.equal(t.sourceCount, 2); // 樂屋網, 591
  assert.equal(t.priceTrend, 'flat');
  assert.equal(t.firstPrice, 1588);
  assert.equal(t.latestPrice, 1588);
});

test('priceTrend dropped uses earliest vs latest by date', () => {
  const t = computeTenure([e('2026-01-01', '1680'), e('2026-03-01', '1588')], '2026-03-10');
  assert.equal(t.priceTrend, 'dropped');
  assert.equal(t.firstPrice, 1680);
  assert.equal(t.latestPrice, 1588);
});

test('priceTrend raised', () => {
  const t = computeTenure([e('2026-01-01', '1500'), e('2026-02-01', '1588')], '2026-02-10');
  assert.equal(t.priceTrend, 'raised');
});

test('no parseable prices -> unknown trend, null prices', () => {
  const t = computeTenure([e('2026-01-01', null), e('2026-02-01', '')], '2026-02-10');
  assert.equal(t.priceTrend, 'unknown');
  assert.equal(t.firstPrice, null);
  assert.equal(t.latestPrice, null);
});

test('empty history -> all null/zero/unknown', () => {
  const t = computeTenure([], '2026-06-26');
  assert.deepEqual(t, {
    firstListedDate: null, daysOnMarket: null, recordCount: 0,
    sourceCount: 0, priceTrend: 'unknown', firstPrice: null, latestPrice: null,
  });
});

test('invalid targetDate -> daysOnMarket null but rest computed', () => {
  const t = computeTenure([e('2025-09-07', '1588')], '');
  assert.equal(t.firstListedDate, '2025-09-07');
  assert.equal(t.daysOnMarket, null);
  assert.equal(t.recordCount, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test scripts/lib/tenure.test.ts`
Expected: FAIL — `./tenure.ts` cannot be found.

- [ ] **Step 3: Add the type, then `tenure.ts`**

In `scripts/lib/types.ts`, add above `EnrichedListing`:

```ts
/** Deterministic "how long on market" summary derived from `listingHistory`. */
export interface ListingTenure {
  firstListedDate: string | null; // earliest date across all records (incl. 下架)
  daysOnMarket: number | null; // targetDate − firstListedDate; null if no history / bad date
  recordCount: number; // total history rows
  sourceCount: number; // distinct non-empty sources
  priceTrend: 'flat' | 'dropped' | 'raised' | 'unknown';
  firstPrice: number | null; // earliest record's price (萬)
  latestPrice: number | null; // latest record's price (萬)
}
```

Add to the `EnrichedListing` interface (after `hardExclusion`):

```ts
  tenure: ListingTenure;
```

Create `scripts/lib/tenure.ts`:

```ts
/**
 * Derive a deterministic "days on market" summary from a listing's 刊登紀錄.
 * firstListedDate = earliest record overall (including 下架), so it reflects how
 * long the property has been shopped around. Pure and unit-tested.
 */
import type { ListingHistoryEntry, ListingTenure } from './types.ts';
import { firstNumber } from './parse.ts';
import { daysBetween, isValidDateString } from './date.ts';

const EMPTY: ListingTenure = {
  firstListedDate: null,
  daysOnMarket: null,
  recordCount: 0,
  sourceCount: 0,
  priceTrend: 'unknown',
  firstPrice: null,
  latestPrice: null,
};

export function computeTenure(
  history: ListingHistoryEntry[],
  targetDate: string,
): ListingTenure {
  if (history.length === 0) return { ...EMPTY };

  const sorted = [...history].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const firstListedDate = sorted[0].date;
  const daysOnMarket = isValidDateString(targetDate)
    ? Math.max(0, daysBetween(firstListedDate, targetDate))
    : null;
  const sourceCount = new Set(history.map((h) => h.source).filter(Boolean)).size;

  const priced = sorted
    .map((h) => firstNumber(h.price))
    .filter((n): n is number => n != null);
  let priceTrend: ListingTenure['priceTrend'] = 'unknown';
  let firstPrice: number | null = null;
  let latestPrice: number | null = null;
  if (priced.length > 0) {
    firstPrice = priced[0];
    latestPrice = priced[priced.length - 1];
    priceTrend =
      latestPrice < firstPrice ? 'dropped' : latestPrice > firstPrice ? 'raised' : 'flat';
  }

  return {
    firstListedDate,
    daysOnMarket,
    recordCount: history.length,
    sourceCount,
    priceTrend,
    firstPrice,
    latestPrice,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test scripts/lib/tenure.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `tenure` into `finalizeWalk` and `enrich.ts`**

In `scripts/lib/walk.ts`:

1. Add the import:

```ts
import { computeTenure } from './tenure.ts';
```

2. Change the `finalizeWalk` signature to accept `targetDate` (default `''`):

```ts
export function finalizeWalk(
  o: OfflineEnriched,
  routed: (number | null)[] | null,
  targetDate = '',
): EnrichedListing {
```

3. In `finalizeWalk`'s returned object, add `tenure` (after `hardExclusion`):

```ts
    hardExclusion: { excluded: reasons.length > 0, reasons },
    tenure: computeTenure(o.listingHistory, targetDate),
```

In `scripts/enrich.ts`, pass the target date — change the call inside the loop:

```ts
    enriched.push(finalizeWalk(o, routed, targetDate));
```

(`targetDate` is already in scope at the top of `main`.)

- [ ] **Step 6: Add tenure assertions to `walk.test.ts`**

The existing `offline()` helper already has `listingHistory: []` (Task 2), so all current `finalizeWalk(...)` calls still compile via the default `targetDate`. Append two tests at the end of `scripts/lib/walk.test.ts`:

```ts
test('finalizeWalk computes tenure from listingHistory + targetDate', () => {
  const o = offline({
    listingHistory: [
      { date: '2026-06-26', source: '樂屋網', price: '1588', active: true },
      { date: '2025-09-07', source: '591', price: '1588', active: false },
    ],
  });
  const e = finalizeWalk(o, [700], '2026-06-26');
  assert.equal(e.tenure.firstListedDate, '2025-09-07');
  assert.equal(e.tenure.daysOnMarket, 292);
  assert.equal(e.tenure.priceTrend, 'flat');
});

test('finalizeWalk tenure is empty when there is no history', () => {
  const e = finalizeWalk(offline({}), [700], '2026-06-26');
  assert.equal(e.tenure.recordCount, 0);
  assert.equal(e.tenure.daysOnMarket, null);
});
```

- [ ] **Step 7: Register the new test and run everything**

In `package.json`, append `scripts/lib/tenure.test.ts` to the `test` script's file list.

Run: `npm test`
Expected: PASS — full suite including `tenure.test.ts` and the updated `walk.test.ts`.

Run: `npx tsc --noEmit`
Expected: clean — confirms `enrich.ts`, `walk.ts`, and `types.ts` type-check with `tenure` required on `EnrichedListing`.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/types.ts scripts/lib/tenure.ts scripts/lib/tenure.test.ts \
  scripts/lib/walk.ts scripts/lib/walk.test.ts scripts/enrich.ts package.json
git commit -m "feat: derive listing tenure (days-on-market, price trend) in enrich"
```

---

### Task 4: Render the 🕒 tenure line (template + rules + docs)

**Files:**
- Modify: `templates/daily-notify-template.md` (add `{{tenure_line}}` to all five listing blocks)
- Modify: `docs/reporting-rules.md` (compose-the-🕒-line rules, next to the 🚶 rules)
- Modify: `docs/fetching.md` (note `listingHistory` in Fields To Extract)

This task has no unit test — it changes agent-facing docs/template. Verify by reading the diff for the exact strings below.

- [ ] **Step 1: Add `{{tenure_line}}` to the template**

In `templates/daily-notify-template.md`, add a `- {{tenure_line}}` line to each block:

- **前置排除** block — after `- {{walk_line}}`:

```
- {{walk_line}}
- {{tenure_line}}
- 前置排除：{{hard_exclusion_reason}}（{{hard_exclusion_evidence}}）
```

- **推薦物件** block — after `- {{walk_line}}`:

```
- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
```

- **接近門檻候選** block — after `- {{walk_line}}`:

```
- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
```

- **⚠️ 可疑/待查** block — make `{{tenure_line}}` the first detail line (long-on-market supports suspicion):

```
#### {{rank}}. [{{title}}]({{url}}) ｜ `{{suspicious_label}}`

- {{tenure_line}}
- 命中訊號：{{suspicious_signals}}
- 理由：{{suspicious_reason}}（信心：{{suspicious_confidence}}・{{detail_page_checked}}）
```

- **目標日排除物件** block — after the basics line:

```
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・覆蓋率 {{rent_coverage}}
- {{tenure_line}}
- 排除：{{exclusion_reason}}
```

- [ ] **Step 2: Add the 🕒 composition rules to `docs/reporting-rules.md`**

Immediately after the existing 🚶 / map-link rules (the bullet block ending at the `Map link {map_url} …` line), insert:

```markdown
- Emit the 🕒 tenure line (`{{tenure_line}}`) in every listing block (前置排除, 推薦, 接近門檻, 可疑/待查, 目標日排除). Compose it from the listing's enriched `tenure`:
  - `recordCount === 0` (no 刊登紀錄 parsed): `🕒 刊登史不明`.
  - `daysOnMarket` is `0` (earliest record is the target date — genuinely fresh): `🕒 本日新上架`.
  - Otherwise: `🕒 已刊登 {daysOnMarket} 天・{price_part}（最早 {firstListedDate}・{sourceCount} 來源）`, where `{price_part}` is:
    - `priceTrend === 'flat'` → `未降價`
    - `priceTrend === 'dropped'` → `曾降價 {firstPrice}→{latestPrice}萬`
    - `priceTrend === 'raised'` → `曾調漲 {firstPrice}→{latestPrice}萬`
    - `priceTrend === 'unknown'` → drop the `・{price_part}` segment entirely: `🕒 已刊登 {daysOnMarket} 天（最早 {firstListedDate}・{sourceCount} 來源）`
  - This line is information-only: it never changes the recommend / exclusion / suspicious decision.
```

- [ ] **Step 3: Note the new field in `docs/fetching.md`**

In `docs/fetching.md`, under "Fields To Extract Per Listing", add a bullet (after the `iBigFun real-price (實價登錄) URL …` bullet):

```markdown
- listing history (刊登紀錄): the inline `table.sub-table` rows for the listing —
  each as `{ date, source, price, active }` (active=false for `(下架)` records),
  used by enrich to compute how long the property has been on market
```

- [ ] **Step 4: Verify the suite is still green**

Run: `npm test`
Expected: PASS (no code changed, but confirms nothing regressed).

- [ ] **Step 5: Commit**

```bash
git add templates/daily-notify-template.md docs/reporting-rules.md docs/fetching.md
git commit -m "docs: render 🕒 tenure line in notify template and rules"
```

---

## Self-Review

**Spec coverage:**
- 起算日 = 最早一筆(含下架) → `computeTenure` uses min date across all entries (Task 3, test asserts `2025-09-07`). ✓
- 天數 → `daysOnMarket` via `daysBetween` (Tasks 1, 3). ✓
- 降價訊號 → `priceTrend` + `firstPrice`/`latestPrice` and the 🕒 `price_part` (Tasks 3, 4). ✓
- 純資訊呈現, no judgment change → stated in Global Constraints and the rules bullet; no threshold/sort edits anywhere. ✓
- 方案 A: raw history in fetch, derived in enrich, template renders → Tasks 2 / 3 / 4. ✓
- Inline DOM, no extra requests → Task 2 parses the already-present `table.sub-table`; no clicks. ✓
- Variants 本日新上架 / 刊登史不明 → Task 4 rules (`daysOnMarket===0` / `recordCount===0`). ✓
- Affected files list in spec (types, config, extract, enrich, template, reporting-rules, fetching, tests) → all covered. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; selectors and strings are literal. ✓

**Type consistency:** `ListingHistoryEntry` {date, source, price, active} used identically in `history.ts`, `tenure.ts`, tests, and template rules. `ListingTenure` fields (`firstListedDate`, `daysOnMarket`, `recordCount`, `sourceCount`, `priceTrend`, `firstPrice`, `latestPrice`) match across `tenure.ts`, the type, tests, and the 🕒 rules. `finalizeWalk` third param `targetDate` consistent between `walk.ts` and `enrich.ts`. `normalizeHistory`/`computeTenure` signatures match their call sites. ✓
