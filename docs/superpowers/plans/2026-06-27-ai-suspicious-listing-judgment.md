# AI Suspicious/Auction Listing Judgment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded auction-keyword hard-exclusion with an advisory signal, and move the auction/"low-info/suspicious" judgment to the report-step agent (soft-flag + down-rank, never auto-remove).

**Architecture:** Keep the "scripts do deterministic work, agent does judgment" split. The only code change demotes `hasAuction` from a `hardExclusion` reason to an advisory `signals.auctionKeyword` field on `EnrichedListing`. All judgment logic lives in `docs/reporting-rules.md` (a new "品質/可疑判斷" section) and is surfaced in the report via `templates/daily-notify-template.md`.

**Tech Stack:** TypeScript (tsx, ESM `.ts` imports), `node:test` + `node:assert/strict`, Markdown docs/templates.

## Global Constraints

- Test runner: `node:test` via `npm test`. Assertions: `node:assert/strict`.
- Module imports use explicit `.ts` extensions (ESM), matching existing files.
- `hardExclusion` after this change is triggered **only** by ">10-min walk (when data reliable)". Auction keyword must NOT add a `hardExclusion` reason.
- proxy signals (e.g. "no interior photos") must never be the sole reason to remove a listing. Auction listings are flagged, not auto-removed.
- Commit message trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Work on branch `feat/ai-suspicious-listing-judgment` (already created; the spec commit is on it).

---

### Task 1: Demote auction keyword to an advisory signal

**Files:**
- Modify: `scripts/lib/types.ts:60-72` (add `signals` to `EnrichedListing`)
- Modify: `scripts/lib/walk.ts:71-122` (`listingBase` + `finalizeWalk`)
- Test: `scripts/lib/walk.test.ts:87-92` (rewrite the auction test)

**Interfaces:**
- Consumes: `OfflineEnriched` (from `scripts/lib/enrich-offline.ts`) which already has `hasAuction: boolean`. Unchanged.
- Produces: `EnrichedListing.signals: { auctionKeyword: boolean }`. `finalizeWalk(o, routed)` sets `signals.auctionKeyword = o.hasAuction` and no longer pushes an auction reason into `hardExclusion`.

- [ ] **Step 1: Rewrite the auction test to expect a signal, not an exclusion**

In `scripts/lib/walk.test.ts`, replace the existing test at lines 87-92:

```typescript
test('auction keyword -> advisory signal, not hard-excluded', () => {
  const e = finalizeWalk(offline({ hasAuction: true }), [600]);
  assert.equal(e.withinWalk, true);
  assert.equal(e.signals.auctionKeyword, true);
  assert.equal(e.hardExclusion.excluded, false);
  assert.equal(e.hardExclusion.reasons.join(), '');
});

test('no auction keyword -> signal false', () => {
  const e = finalizeWalk(offline({ hasAuction: false }), [600]);
  assert.equal(e.signals.auctionKeyword, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `e.signals` is `undefined` (property does not exist yet), so `e.signals.auctionKeyword` throws / assertion fails. The old `>800m walk` exclusion test still passes.

- [ ] **Step 3: Add `signals` to the `EnrichedListing` type**

In `scripts/lib/types.ts`, inside `interface EnrichedListing` (currently ending at line 71 with `hardExclusion`), add the field right before `hardExclusion`:

```typescript
  /** Advisory signals for agent judgment (do NOT auto-exclude). */
  signals: { auctionKeyword: boolean };
  hardExclusion: { excluded: boolean; reasons: string[] };
```

- [ ] **Step 4: Surface the signal and stop excluding on it in `walk.ts`**

In `scripts/lib/walk.ts`, change `finalizeWalk` so the auction keyword no longer adds a hard-exclusion reason and is instead emitted as a signal.

Replace the reasons block (lines 109-113):

```typescript
  const reasons: string[] = [];
  if (o.hasAuction) reasons.push('auction/special-disposition keyword in title');
  if (withinWalk === false && walk) {
    reasons.push(`>10-min walk to MRT (routed ${walk.distanceM}m to ${walk.stationZh})`);
  }
```

with:

```typescript
  const reasons: string[] = [];
  if (withinWalk === false && walk) {
    reasons.push(`>10-min walk to MRT (routed ${walk.distanceM}m to ${walk.stationZh})`);
  }
```

Then update the return object (lines 115-121) to include `signals`:

```typescript
  return {
    ...listingBase(o),
    walk,
    withinWalk,
    reliability,
    signals: { auctionKeyword: o.hasAuction },
    hardExclusion: { excluded: reasons.length > 0, reasons },
  };
```

Note: `listingBase` (lines 72-75) already destructures `hasAuction` out of the spread, so it stays out of the base object — we now re-add it explicitly as `signals.auctionKeyword`. Leave `listingBase` unchanged.

- [ ] **Step 5: Run the full test suite to verify it passes**

Run: `npm test`
Expected: PASS — all tests pass, including the two new auction tests and the unchanged `>800m walk -> hard-excluded` test. `enrich-offline.test.ts` (asserts `o.hasAuction` on the offline result) is unaffected.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. Any consumer of `EnrichedListing` that builds the object literally would now need `signals`; `finalizeWalk` is the only constructor, and it is updated.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/types.ts scripts/lib/walk.ts scripts/lib/walk.test.ts
git commit -m "$(cat <<'EOF'
feat: demote auction keyword from hard-exclusion to advisory signal

EnrichedListing now carries signals.auctionKeyword; hardExclusion is
triggered only by >10-min walk. The recommend/exclude decision for
auction-like listings moves to the report-step agent.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Rewrite the auction rule as agent quality/suspicious judgment

**Files:**
- Modify: `docs/reporting-rules.md:21-22` (remove auction hard-exclusion lines), and add a new section after "Walking-Distance Triage (Agent)" (after line 109).

**Interfaces:**
- Consumes: `EnrichedListing.signals.auctionKeyword` (from Task 1).
- Produces: a documented agent verdict vocabulary `clean | suspicious | likely-auction` used by the report template in Task 3.

This task changes documentation only; verification is by inspection (no unit test).

- [ ] **Step 1: Remove the auction hard-exclusion lines**

In `docs/reporting-rules.md`, delete these two lines (currently 21-22) from the "Hard Exclusions" list:

```markdown
- Exclude auction and special-disposition listings, including foreclosure, court auction, bank auction, tender, bidding, and similar cases.
- Treat title, source labels, listing notes, tags, and visible listing metadata as evidence for these exclusions.
```

Leave the rest of the "Hard Exclusions" section (MRT-distance rules and the closing "Keep hard-exclusion counts..." line) intact, so that section now describes only the objective MRT-distance hard-exclusion.

- [ ] **Step 2: Add the new agent judgment section**

In `docs/reporting-rules.md`, immediately after the "Walking-Distance Triage (Agent)" section (after its last line, before "## Notification Format"), insert:

```markdown
## Quality / Suspicious-Listing Judgment (Agent)

Auction/foreclosure detection is no longer a hardcoded keyword hard-exclusion.
The keyword check now only sets the advisory `signals.auctionKeyword` flag on
each enriched listing; the agent makes the final call as part of a broader
"low-info / suspicious listing" judgment. Foreclosure is one case under this.

### Suspicious signals (weigh together; none convicts on its own)

- `signals.auctionKeyword === true` — title contains 法拍 / 銀拍 / 金拍 /
  法院拍賣 / 拍賣 / 投標 / 應買.
- No interior photos, or only exterior / map / floor-plan images.
- Sparse information: very short description, many key fields blank.
- Source-site labels, tags, or notes showing special-disposition wording.

### When to open the detail page

Open the listing `url` to inspect photo count and information density when:

- any suspicious signal above is hit, OR
- the listing is otherwise strong enough to reach recommended / near-threshold
  and is worth verifying.

Detail URLs usually point to the originating source (591 / 樂居 / rakuya),
not `ibigfun.com`, so opening them does not affect the iBigFun login session.
Do NOT open every listing — only suspicious or borderline-but-promising ones,
to control cost.

### Verdict and output

Assign one of: `clean` / `suspicious` / `likely-auction`. For each, record the
reason, your confidence, and whether you actually opened the detail page.

Rules:

- proxy signals (e.g. "no interior photos") must never be the sole reason to
  remove a listing; auction-like listings are flagged, not auto-removed.
- If the detail page cannot be opened or the source blocks scraping, record
  "未能查證", keep the soft flag at low confidence, and do not escalate to
  removal.
- A keyword hit the agent verifies as non-auction (e.g. title says "非法拍" or
  "法拍屋旁") may be downgraded to `clean` with a recorded reason.

### Effect on ranking

`suspicious` / `likely-auction` listings are down-ranked, not removed: even if
the numbers qualify, do not place them in 推薦 — route them to 接近門檻 or the
可疑/待查 section with the reason noted. This mirrors the existing rule that a
listing lacking solid data cannot be labeled recommended.
```

- [ ] **Step 3: Verify the document reads consistently**

Re-read the "Hard Exclusions" and the new "Quality / Suspicious-Listing
Judgment" sections. Confirm: no remaining sentence claims auction listings are
hard-excluded, and the new section's verdict vocabulary
(`clean`/`suspicious`/`likely-auction`) is internally consistent.

- [ ] **Step 4: Commit**

```bash
git add docs/reporting-rules.md
git commit -m "$(cat <<'EOF'
docs: replace auction hard-exclusion with agent suspicious-listing rule

Auction/foreclosure is now an advisory signal the agent judges (clean/
suspicious/likely-auction), soft-flagged and down-ranked, never auto-removed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Surface suspicious listings in the report + sync wording

**Files:**
- Modify: `templates/daily-notify-template.md:17` (summary line), `:5-17` (add summary count), and insert a new "可疑/待查" section between "接近門檻候選" (ends line 100) and "目標日排除物件" (starts line 102).
- Modify: `AGENTS.md:40-42` (enrich step description) and `scripts/enrich.ts:7` (header comment) to drop the "auction keywords are hard-excluded" wording.

**Interfaces:**
- Consumes: the verdict vocabulary `clean | suspicious | likely-auction` from Task 2.
- Produces: report sections/placeholders (`{{suspicious_count}}`, `{{#each suspicious}}`) used when writing `reports/<date>.md`.

Documentation/template only; verification by inspection.

- [ ] **Step 1: Update the summary block to mention the new count and fix the exclusion wording**

In `templates/daily-notify-template.md`, add a summary line after line 12
(`- 目標日排除：{{excluded_count}} 筆`):

```markdown
- 可疑/待查：{{suspicious_count}} 筆
```

Then replace the front-matter exclusion description (current line 17):

```markdown
- 前置排除：明確離捷運超過 800 公尺,或法拍/銀拍/法院拍賣/投標等特殊處分案
```

with:

```markdown
- 前置排除：明確離捷運超過 800 公尺(客觀硬排除)
- 可疑/待查：法拍/資訊過少/無室內圖等由 agent 軟標記,降權但不自動移除
```

- [ ] **Step 2: Add the 可疑/待查 section**

In `templates/daily-notify-template.md`, between the end of the "接近門檻候選"
block (after line 100, the `{{/if}}` that closes near_threshold) and the
"### 目標日排除物件" heading (line 102), insert:

```markdown
### ⚠️ 可疑/待查

{{#if suspicious}}

{{#each suspicious}}

#### {{rank}}. [{{title}}]({{url}})

- 標記：`{{suspicious_label}}`  （clean / suspicious / likely-auction）
- 地址/區域：{{address_or_area}}
- 刊登日：{{published_date}}
- 命中訊號：{{suspicious_signals}}
- 是否點進詳情頁查證：{{detail_page_checked}}
- 理由與信心：{{suspicious_reason}}（信心：{{suspicious_confidence}}）

{{/each}}

{{else}}

- 無 agent 標記為可疑/待查的物件。

{{/if}}

```

- [ ] **Step 3: Sync the enrich-step wording in `AGENTS.md`**

In `AGENTS.md`, the run-sequence step 4 (lines 40-42) currently reads:

```markdown
   and objective hard-exclusion flags (>10-min walk when data is reliable,
   auction/special-disposition keywords). Listings with an unreliable
```

Replace with:

```markdown
   objective hard-exclusion flags (>10-min walk when data is reliable), and an
   advisory `signals.auctionKeyword` flag the agent weighs (no longer an
   auto-exclusion — see Quality / Suspicious-Listing Judgment in
   docs/reporting-rules.md). Listings with an unreliable
```

Also update the Tooling bullet for enrich (line 67) — replace
`a reliability gate, and hard-exclusion flags →` with
`a reliability gate, hard-exclusion (walk only), and the advisory
auction-keyword signal →`.

- [ ] **Step 4: Sync the header comment in `scripts/enrich.ts`**

In `scripts/enrich.ts`, the header comment (lines 6-8) currently reads:

```typescript
 * gate, and objective hard-exclusion flags (>10-min walk when reliable; auction
 * keywords). Writes state/enriched-<date>.json and stdout.
```

Replace with:

```typescript
 * gate, an objective hard-exclusion flag (>10-min walk when reliable), and an
 * advisory auction-keyword signal for the agent. Writes
 * state/enriched-<date>.json and stdout.
```

- [ ] **Step 5: Verify tests and typecheck still pass (no logic touched, but enrich.ts was edited)**

Run: `npm test && npx tsc --noEmit`
Expected: PASS — the `scripts/enrich.ts` edit is comment-only; no behavior change.

- [ ] **Step 6: Commit**

```bash
git add templates/daily-notify-template.md AGENTS.md scripts/enrich.ts
git commit -m "$(cat <<'EOF'
docs: add 可疑/待查 report section and sync auction-signal wording

Report template gains a suspicious/待查 section and summary count; AGENTS.md
and enrich.ts headers describe the auction keyword as an advisory signal.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Notes for the implementer

- The deterministic foreclosure judgment is intentionally gone. Do not
  reintroduce any code path that auto-excludes on the auction keyword.
- `enrich.ts:124` computes `hardExcludedCount` from `hardExclusion.excluded`;
  after Task 1 that count reflects walk-distance exclusions only — this is
  correct and needs no code change.
- There is no automated test for the agent's judgment (it is non-deterministic);
  `reporting-rules.md` + the template ARE its spec. Verify by inspecting a
  generated daily report.
