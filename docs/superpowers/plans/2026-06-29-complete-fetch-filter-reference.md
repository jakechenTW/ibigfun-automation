# Complete iBigFun Fetch-Filter Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Execute inline in the main session** — the crawl drives the user's live Chrome and cannot be delegated to a headless subagent.

**Goal:** Make `data/ibigfun-filter-mappings.md` the complete, authoritative catalog of every `/api/search/list` body param a profile's `fetch` map can set, with full allowed-value enumerations, captured from a real live crawl.

**Architecture:** Two gated tasks. Task 1 is a live read-only crawl of the authenticated `lists/latest` filter UI via Claude-in-Chrome (on the user's own session) plus one XHR capture, written to an un-committed scratchpad notes file. Task 2 expands the committed doc from those notes and verifies it. No code, no unit tests; verification is XHR-name matching + grep checks.

**Tech Stack:** Markdown + data file; Claude-in-Chrome browser tools (read-only); the existing `scripts/lib/api.ts` `buildSearchBody` as the param-name oracle.

**Spec:** `docs/superpowers/specs/2026-06-29-complete-fetch-filter-reference-design.md`

## Global Constraints

- **Docs + data only.** No `scripts/` change, no `profiles/` change, no `npm install`, no new deps.
- **Single shared login — never run headless network commands.** Do NOT run `npm run fetch`, `npm run pipeline`, or any headless iBigFun request. The only live access is Claude-in-Chrome against the **user's already-authenticated Chrome session** (the user's own session → no second login → no kick).
- **Never commit secrets.** No credentials, cookies, `ibigfun_session`, or `mobile=`/`password=` values in any committed file (incl. the doc and the scratchpad if it were ever staged).
- **Scope = `fetch`-tunable body params only.** The fixed envelope (`page`, `method=all_case`, `on_market=1`, `expand=0`, `exclude_land=1`, `add_date`/`add_date_max`) and the `source[]`/`source_web[]` allow-lists are API contract, NOT catalogued as tunable — only cross-referenced as envelope.
- **Captured date is 2026-06-29.**
- Scratchpad notes live at `/private/tmp/claude-501/-Users-jakechen-Documents-ibigfun-automation/f0777bb4-8595-42ef-8a38-c4f560118cd7/scratchpad/filter-crawl-notes.md` (un-committed).

---

### Task 1: Live crawl — capture the complete filter surface

**Files:**
- Create (un-committed, scratchpad): `.../scratchpad/filter-crawl-notes.md`
- Read-only oracle: `scripts/lib/api.ts` (`buildSearchBody` param names)

**Interfaces:**
- Produces: `filter-crawl-notes.md` containing, for every fetch-tunable filter: its `/api/search/list` body key, value shape (scalar / `{min,max}` / array / literal), and the **complete** allowed-value set (id→name tables for coded filters; literal lists for `parking`; range-vs-buckets + unit + bounds for `*_segment`/`*_number`); PLUS the raw param list from one captured `/api/search/list` XHR body. Task 2 consumes this file.

- [ ] **Step 1: Load the Chrome browser tools.** One ToolSearch call:

```
ToolSearch query: "select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__read_network_requests"
```

- [ ] **Step 2: Get tab context and confirm an authenticated session.** Call `mcp__claude-in-chrome__tabs_context_mcp`. Confirm Chrome is reachable and there is (or can be) a tab on `ibigfun.com` where the user is logged in. If no logged-in iBigFun tab exists, STOP and ask the user to log in to `https://www.ibigfun.com` in Chrome first (do not attempt a login ourselves — login is the kick risk).

- [ ] **Step 3: Open the filter UI.** Navigate the working tab to `https://www.ibigfun.com/lists/latest` with `mcp__claude-in-chrome__navigate`. Confirm via `read_page` that the filter controls render (not a login redirect). If it redirects to login, STOP and ask the user to sign in.

- [ ] **Step 4: Extract the embedded option metadata via `javascript_tool`.** Run page script to dump the machine-readable filter sources in one shot (read-only; logs to console, no mutation):

```js
// Dump filter option metadata from the lists/latest page.
const out = {};
// (a) inline city→towns object the selector is built from
try { out.cityObj = (typeof city !== 'undefined') ? city : window.city ?? null; } catch (e) { out.cityObj = String(e); }
// (b) every caption span: id like "<filter>_caption_<id>" -> text
out.captions = [...document.querySelectorAll('span[id*="_caption_"]')]
  .map(s => ({ id: s.id, name: s.textContent.trim() }));
// (c) every <select> filter and its <option> value/text pairs
out.selects = [...document.querySelectorAll('select')]
  .map(sel => ({ name: sel.name || sel.id, options: [...sel.options].map(o => ({ value: o.value, text: o.textContent.trim() })) }));
// (d) checkbox/radio filter groups (house_type, parking, source, etc.)
out.inputs = [...document.querySelectorAll('input[type=checkbox],input[type=radio]')]
  .map(i => ({ name: i.name, value: i.value, label: (i.closest('label')?.textContent || i.nextElementSibling?.textContent || '').trim() }))
  .filter(x => x.name);
console.log('FILTER_DUMP_START');
console.log(JSON.stringify(out));
console.log('FILTER_DUMP_END');
```

Then read it back with `mcp__claude-in-chrome__read_console_messages` (pattern `FILTER_DUMP`) — load that tool in the same ToolSearch if not already present. Record the JSON into the scratchpad notes.

- [ ] **Step 5: Manually open each range/bucket dropdown and record its options.** For `price_segment`, `floor_segment`, `total_floor`, `house_age_segment`, `main_ping_number` (坪數), and any 屋齡/坪數 range control found in Step 4: determine whether it is a **free numeric input** or a **fixed bucket dropdown**. If the Step-4 `selects`/`inputs` dump already lists the option values, use those; otherwise use `computer` to open the control and `read_page` to read the rendered options. Note the **unit** (萬 / 樓 / 坪 / 年) for each.

- [ ] **Step 6: Capture one real `/api/search/list` XHR body.** With `read_network_requests` armed, perform ONE search via the page UI (set any single filter and submit) in the user's session. Capture the POST to `/api/search/list` and record its full body param list into the notes. This is the param-name oracle for Task 2. (One search in the user's own session — not a headless call — is within the safety rule.)

- [ ] **Step 7: Cross-check captured param names against `buildSearchBody`.** Open `scripts/lib/api.ts`. Confirm the captured XHR's variable param names map onto the shapes `buildSearchBody` emits (scalar `key=v`; range `key[min_val]`/`key[max_val]`; array `key[]`). In the notes, flag any captured filter param NOT yet represented anywhere in the doc, and any doc filter NOT seen in the UI.

- [ ] **Step 8: Write the consolidated notes file.** Ensure `filter-crawl-notes.md` now contains, per fetch-tunable filter: body key, value shape, complete allowed values (id→name / literals / range-vs-buckets + unit + bounds), plus the raw captured XHR param list and the Step-7 flags. This file is the complete input for Task 2.

- [ ] **Step 9: Gate.** Verify the notes cover **every** filter control seen on the page (no control left as "unknown"), `parking` has concrete literal values (not "re-confirm"), and each range filter is classified free-range vs buckets with a unit. If any gap remains, return to the relevant step before proceeding. (No commit — scratchpad is un-committed.)

---

### Task 2: Expand and verify `data/ibigfun-filter-mappings.md`

**Files:**
- Modify: `data/ibigfun-filter-mappings.md`
- Modify (if its one-line summary drifts): `data/README.md`
- Read-only input: `.../scratchpad/filter-crawl-notes.md` (from Task 1)

**Interfaces:**
- Consumes: `filter-crawl-notes.md` (Task 1 output) and the captured XHR param list.
- Produces: the committed complete reference. No downstream code consumer.

- [ ] **Step 1: Bump the header capture date.** In `data/ibigfun-filter-mappings.md`, change the `Captured: 2026-06-27` line to `Captured: 2026-06-29` and keep the existing re-confirm instructions intact.

- [ ] **Step 2: Add the "Filter catalog" overview table.** Insert, immediately after the intro/source bullets and before the `## Profile filter usage` section, a new section:

```markdown
## Filter catalog (every fetch-tunable param)

Every `/api/search/list` body param a profile's `fetch` map can set. The fixed
envelope (`page`, `method`, `on_market`, `expand`, `exclude_land`,
`add_date`/`add_date_max`) and the `source[]` / `source_web[]` allow-lists are
**API contract, not `fetch`-tunable** — see the request-body encoding section.

| `fetch` key | Value shape | Allowed values | Section |
|---|---|---|---|
```

Fill one row per tunable key found in Task 1 (`city`, `town`, `house_type`,
`parking`, each `*_segment` / `*_number` range, and any newly-found key). "Value
shape" ∈ {scalar, `{min,max}` range, array `key[]`, literal}. "Allowed values" is
a short hint (e.g. "22 city ids", "free 萬 range", "N literal strings"); "Section"
links to the per-filter heading below.

- [ ] **Step 3: Verify the existing `city` / `town` / `house_type` tables.** Compare each against the Task-1 capture. If the live UI matches, leave the tables as-is. If anything changed, correct the table and note the change inline. (These are large tables — only edit on a real mismatch.)

- [ ] **Step 4: Complete the `parking` section.** Replace the current "Other UI values include 機械、塔式、其他 (re-confirm from the UI if needed)" wording with the **complete** literal value list captured in Task 1, formatted like the other value sections. Keep the note that `parking` is sent as a literal Chinese value, not an id.

- [ ] **Step 5: Add/expand the range-filter sections.** For each of `price_segment`, `floor_segment`, `total_floor`, `house_age_segment`, `main_ping_number`, and any new range key: add a subsection stating whether it is a **free numeric range or fixed buckets** (list every bucket if bucketed), its **unit** (萬 / 樓 / 坪 / 年), and the `key[min_val]`/`key[max_val]` encoding (omitted bound → empty string = unbounded). Place these under a `## Range filters` heading after `parking`.

- [ ] **Step 6: Add any newly-found body filter** surfaced in Task 1 as its own section (id→name table or literal list, matching the existing style), and add its catalog-table row.

- [ ] **Step 7: Mark the envelope in the encoding section.** In the existing `## /api/search/list request-body encoding` section, add one explicit sentence that the fixed envelope and `source[]`/`source_web[]` allow-lists are API contract and intentionally absent from the catalog table. Keep the existing server-side-only caveat (`main_ping_number`→`total_ping`, `house_type`→`typeLayout`).

- [ ] **Step 8: Update `data/README.md` if its summary drifted.** Read `data/README.md`'s `ibigfun-filter-mappings.md` section; if its one-line description no longer fits the now-complete catalog, update that sentence only. (Skip if still accurate.)

- [ ] **Step 9: Verify — XHR param-name match.** Confirm every variable param in the Task-1 captured XHR body appears in the new catalog table, and every catalog row's encoding matches what `buildSearchBody` (`scripts/lib/api.ts`) emits for that shape. Reconcile any mismatch in favor of the live capture.

- [ ] **Step 10: Verify — no placeholders, no secrets, complete enumerations.** Run:

```bash
# (a) No leftover re-confirm/TBD for in-scope filters
grep -niE "re-confirm if needed|TBD|TODO|機械、塔式、其他 \(re-confirm" data/ibigfun-filter-mappings.md
# Expected: no hits on a placeholder value list (the header's "Re-confirm if iBigFun changes" instruction is allowed).

# (b) No secrets anywhere in the file
grep -niE "password|mobile=|ibigfun_session|cookie" data/ibigfun-filter-mappings.md
# Expected: no hits.

# (c) Every catalog-table key has a matching section heading
grep -nE "^\| \`?[a-z_]+\`? \|" data/ibigfun-filter-mappings.md
# Manual check: each key in the printed rows has a `## ` or `### ` section below.
```

All must pass; fix the doc until they do.

- [ ] **Step 11: Commit.**

```bash
git add data/ibigfun-filter-mappings.md data/README.md
git commit -m "docs(data): complete fetch-filter catalog from live crawl

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Spec "Goal" + "Design §2 catalog table" → Task 2 Step 2.
- "Design §1 header date" → Task 2 Step 1.
- "Design §3 per-filter sections" → Task 2 Steps 3 (city/town/house_type verify), 4 (parking), 5 (ranges), 6 (new filters).
- "Design §4 retained sections + envelope note" → Task 2 Step 7.
- "Crawl method (safety-critical)" → Task 1 Steps 1–7 (Chrome-only, no headless, one XHR, no secrets).
- "Execution model: inline" → header + plan-wide note.
- "Verification" bullets → Task 2 Steps 9 (XHR match), 10 (placeholders/secrets/completeness); `data/README.md` accuracy → Task 2 Step 8.
- "Out of scope" (non-fetch UI, no code/profile change, envelope stays envelope) → Global Constraints + Step 7.

**Placeholder scan:** Browser steps give exact tool names and the full JS dump script; doc steps give exact section text, exact insertion points, and exact grep commands with expected output. No "TBD"/"implement later". The id→name table *contents* are intentionally produced by the Task-1 crawl (the whole point) — Task 2 steps specify exactly where each goes.

**Type/name consistency:** `filter-crawl-notes.md` scratchpad path is identical in both tasks. Filter key names (`price_segment`, `floor_segment`, `total_floor`, `house_age_segment`, `main_ping_number`, `parking`, `city`, `town`, `house_type`) match the spec, `docs/fetching.md`, and `scripts/lib/api.ts` encoding. "Value shape" vocabulary (scalar / `{min,max}` / array / literal) is consistent across the catalog table and `buildSearchBody`.

**Scope:** Single cohesive docs+data deliverable; two tasks only because crawl-capture and doc-write are independently gateable. No decomposition needed.
