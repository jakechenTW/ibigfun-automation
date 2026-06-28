# Docs Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the docs left stale by the profile redesign and make each doc's ownership/indexes crisp, without moving any files.

**Architecture:** Pure docs edit. Rewrite `README.md` as a thin pointer, delete the orphan `templates/` file, complete `data/README.md`, and fix AGENTS.md's source-of-truth map. Verification is grep checks (no code, no unit tests).

**Tech Stack:** Markdown only.

**Spec:** `docs/superpowers/specs/2026-06-28-docs-cleanup-design.md`

## Global Constraints

- **Docs only.** No `scripts/` changes, no `npm` install, no new dependencies.
- **Do not edit `docs/superpowers/specs/` or `docs/superpowers/plans/`** (append-only design history; their old-path references are expected).
- **Do not move/relocate any file** — co-location by responsibility is intentional. The only file removed is the `templates/` orphan.
- **Never commit** `.env`, credentials, or `state/` content.
- Profile ids are `investment-taipei` / `owner-occupied-taipei`.

---

### Task 1: Fix stale docs + complete indexes

**Files:**
- Replace (full): `README.md`
- Delete: `templates/daily-notify-template.md` (empties the `templates/` dir)
- Modify: `data/README.md` (add `region-allowlist.md` section)
- Modify: `AGENTS.md` (source-of-truth map: `data/` line + add `prompts/schedule-triggers.md`)

**Interfaces:** none (docs only).

- [ ] **Step 1: Replace `README.md`** with exactly this content:

```markdown
# iBigFun Automation

Workspace for monitoring iBigFun property listings through explicit profiles,
preparing profile-specific Markdown reports, and sending concise notifications.

## Start Here

**Agents:** read `AGENTS.md` — the linear runbook (source model, first-run
prerequisites, daily run sequence, notification command, safety rules, and the
source-of-truth map that indexes every other doc). Do not duplicate those rules
here. To author or add a profile, see `profiles/README.md`.

## Credentials

Use a dedicated automation account. Copy `.env.example` to `.env` and fill it
locally; never commit `.env`. See `docs/credentials.md`.

## Repository Layout

- `AGENTS.md` — agent runbook and entrypoint; its source-of-truth map indexes
  every doc.
- `profiles/<id>/` — one self-contained folder per profile: `profile.json`
  (`displayName` + `fetch` filter map), `evaluation.md`, and `notify-template.md`.
  See `profiles/README.md` to author one.
- `docs/` — cross-profile reference: fetching, credentials, shared reporting
  rules, automation state.
- `data/` — static reference data (MRT exits, filter mappings, 議價率, region
  allowlist); indexed by `data/README.md`.
- `prompts/` — committed prompts for headless / scheduled runs.
- `state/` — local generated output and per-run artifacts under
  `state/runs/<profile>/<label>/`; git-ignored.

## Safety

See the safety rules in `AGENTS.md`. In short: never commit credentials,
sessions, browser profiles, automation state, traces, screenshots, downloaded
pages, or any local output containing secrets.
```

- [ ] **Step 2: Delete the `templates/` orphan.**

Run: `git rm templates/daily-notify-template.md`
Expected: `rm 'templates/daily-notify-template.md'`. Then `ls templates 2>&1` → "No such file or directory" (dir is now empty/gone).

- [ ] **Step 3: Append a `region-allowlist.md` section to `data/README.md`** (after the existing `negotiation-rate.md` section, at end of file):

```markdown

## `region-allowlist.md`

投資 profile 的目標捷運站白名單與 `regionGate` 規則（站外 / 站內走路過遠 /
待人工）。`profiles/investment-taipei/evaluation.md` 與 enrich 的 `regionGate`
判定依此清單。每次調整目標捷運範圍時更新。
```

- [ ] **Step 4: Fix AGENTS.md's source-of-truth map.** In `AGENTS.md`, find the map bullet:

```
- `data/README.md`: MRT reference dataset and distance rules.
```

Replace it with:

```
- `data/`: static reference data — `data/README.md` indexes the datasets
  (Taipei MRT exits, filter id→name mappings, per-city 議價率, investment region
  allowlist).
```

Then, immediately after the `prompts/daily-run.md` bullet in the same map, add:

```
- `prompts/schedule-triggers.md`: copy-paste trigger template that injects
  profile / tool / date range into the `prompts/daily-run.md` SOP for scheduled
  runs.
```

- [ ] **Step 5: Verify (grep checks).** Run each; all must pass:

```bash
# 1. No stale old-model terms in committed docs (excluding superpowers history)
grep -rnE "fetchFilters|notifyTask|ruleDocPath|templatePath|hardCriteria|templates/.*notify-template|--profile (investment|owner-occupied)\b" \
  README.md CLAUDE.md AGENTS.md docs/*.md data/*.md prompts/*.md profiles/README.md
# Expected: no output.

# 2. templates/ dir gone
ls templates 2>&1   # Expected: No such file or directory

# 3. Every data/* file is indexed in data/README.md
for f in data/*; do b=$(basename "$f"); [ "$b" = README.md ] || grep -q "$b" data/README.md || echo "MISSING: $b"; done
# Expected: no output.

# 4. README no longer mentions templates/
grep -c "templates/" README.md   # Expected: 0
```

Note: grep #1 matches `profiles/README.md` only when it *explains* these terms were removed (prose like "those were removed") or shows `--profile investment-taipei` — those are correct and not stale. If a hit appears there, confirm it is the authoring guide's "removed fields" prose or a `-taipei` id before treating it as clean. The dangerous hits are in `README.md` / `AGENTS.md` / `docs/*` / `data/*` describing the live model.

- [ ] **Step 6: Commit.**

```bash
git add -A
git commit -m "docs: fix stale README/templates, complete data + source-of-truth indexes"
```

---

## Self-Review

**Spec coverage:** §A README rewrite → Step 1. §B delete templates orphan → Step 2. §C complete data/README → Step 3. §D AGENTS map fix → Step 4. §E ownership model → realized by Steps 1+4 (documented in README layout + map; no new file, per spec). Verification → Step 5 (mirrors the spec's four grep checks).

**Placeholder scan:** Full README content inlined; exact bullet text for the map edit; exact `data/README.md` section text; exact grep commands with expected output. No TBD/TODO.

**Consistency:** README layout drops `templates/` (Step 1) consistent with deleting it (Step 2); the map's `data/` framing (Step 4) matches `data/README.md` becoming the complete index (Step 3). The grep in Step 5 caveat correctly excludes the authoring-guide prose.

**Scope:** Single cohesive docs task; no decomposition needed.
