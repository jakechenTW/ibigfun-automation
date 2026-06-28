# Docs Cleanup — Fix Stale Content + Crisp Ownership

Date: 2026-06-28
Status: Design (approved in brainstorming; pending spec review)

## Problem

The profile-system redesign (folder profiles, data-driven `fetch`, `-taipei`
ids) updated the operational docs it touched, but left some docs stale and a few
indexes incomplete:

1. **`README.md` is the worst offender** — its "Profiles" and "Repository
   Layout" sections describe the *old* model: ids `investment` /
   `owner-occupied` (now `-taipei`), `fetchFilters.enabled: true` (field gone),
   "`profiles/` — … future fetch filter definitions", "`templates/` —
   profile-specific notification templates", and "`docs/` — … profile rules" —
   all no longer true.
2. **`templates/daily-notify-template.md` is an orphan** — a "Deprecated
   Template" pointer to `templates/investment-notify-template.md` /
   `templates/owner-occupied-notify-template.md`, both of which were **moved**
   into `profiles/<id>/notify-template.md`. It points at files that no longer
   exist and is the only remaining file in `templates/`, so the directory is
   vestigial.
3. **`data/README.md` is an incomplete index** — documents
   `ibigfun-filter-mappings.md`, `taipei_mrt_exits.csv`, and `negotiation-rate.md`
   but omits `region-allowlist.md`.
4. **AGENTS.md's source-of-truth map under-represents `data/` and `prompts/`** —
   it lists only `data/README.md` ("MRT dataset and distance rules") though
   `data/` now holds four reference files, and it omits
   `prompts/schedule-triggers.md`.

## Goals

- Every committed doc is accurate after the profile redesign.
- Each doc has one clear owner; no duplicated operational detail that can drift.
- `README.md` is a thin pointer (no operational detail to go stale).
- The indexes are complete: `data/README.md` lists every `data/*` file, and
  AGENTS.md's source-of-truth map names every committed doc area.

## Non-Goals (decided in brainstorming)

- **Do not consolidate docs under `docs/`.** Doc location is **co-located by
  responsibility**, on purpose, and that stays:
  - `README.md` / `CLAUDE.md` / `AGENTS.md` / `CHANGELOG.md` are root by tool and
    GitHub convention (entrypoints tools look for at root).
  - `profiles/<id>/evaluation.md` + `notify-template.md` are **runtime inputs the
    code/agent reads from the profile folder** — moving them breaks flat-folder
    discovery.
  - `data/*.md` co-locate with the data they describe (incl. `taipei_mrt_exits.csv`).
  - `prompts/*.md` are automation inputs.
  - `docs/*` holds only cross-profile reference prose (fetching, credentials,
    reporting-rules, automation-state).
  Findability is served by the source-of-truth map (the index), not by piling
  files into one directory.
- **Leave the 28 `docs/superpowers/specs` + `plans`** as an append-only design
  history. Their references to now-removed paths are expected; do not edit them.
- **No full cross-reference audit** and **no code changes** (docs only).

## Design

### A. Rewrite `README.md` as a thin pointer

Replace the whole file with the content below. It keeps the title, intro,
Start-Here, Credentials, and Safety pointers; **deletes** the stale "Profiles"
section; and **corrects** the layout (no `templates/`; accurate `profiles/`,
`docs/`, `data/`):

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

### B. Delete the `templates/` orphan

- `git rm templates/daily-notify-template.md`. After removal `templates/` is
  empty and disappears from git. No committed doc should reference it (the
  README `templates/` line is removed in A; only the superpowers *history*
  mentions it, which we leave).

### C. Complete `data/README.md`

Add a `region-allowlist.md` section so it indexes every `data/*` file:

```markdown
## `region-allowlist.md`

投資 profile 的目標捷運站白名單與 `regionGate` 規則（站外 / 站內走路過遠 /
待人工）。`profiles/investment-taipei/evaluation.md` 與 enrich 的 `regionGate`
判定依此清單。每次調整目標捷運範圍時更新。
```

### D. Fix AGENTS.md's source-of-truth map

- Replace the `data/README.md` line with one that frames it as the index of all
  reference data:
  `` - `data/`: static reference data — `data/README.md` indexes the datasets
  (Taipei MRT exits, filter id→name mappings, per-city 議價率, investment region
  allowlist). ``
- Add a line for the second prompt file:
  `` - `prompts/schedule-triggers.md`: copy-paste trigger template that injects
  profile / tool / date range into the `prompts/daily-run.md` SOP for scheduled
  runs. ``

### E. Ownership model (documented outcome, no new files)

The reorg makes this the explicit, single-owner map (already reflected by A–D):

| Area | Owner / role |
|---|---|
| `README.md` | Human entrypoint — pointer only |
| `CLAUDE.md` | Claude Code pointer to `AGENTS.md` |
| `AGENTS.md` | Agent runbook + **master index** (source-of-truth map) |
| `docs/*` | Cross-profile how-to: fetching, credentials, reporting-rules, automation-state |
| `profiles/<id>/` | Per-profile data + evaluation + template (runtime inputs) |
| `profiles/README.md` | How to author a profile |
| `data/*` | Reference data, indexed by `data/README.md` |
| `prompts/*` | Headless / scheduled run prompts |

## Verification

Docs-only; no automated tests. After the edits run these grep checks:

- No stale old-model terms in committed docs (excluding superpowers history):
  `grep -rnE "fetchFilters|notifyTask|ruleDocPath|templatePath|hardCriteria|templates/.*notify-template|--profile (investment|owner-occupied)\b" README.md CLAUDE.md AGENTS.md docs/*.md data/*.md prompts/*.md profiles/README.md`
  → no hits.
- `templates/` directory is gone: `ls templates 2>&1` → "No such file or directory".
- Every `data/*` file appears in `data/README.md`:
  `for f in data/*; do b=$(basename "$f"); [ "$b" = README.md ] || grep -q "$b" data/README.md || echo "MISSING: $b"; done`
  → no output.
- README layout no longer mentions `templates/`:
  `grep -c "templates/" README.md` → `0`.

## Out of Scope

- `docs/superpowers/specs` + `plans` (design history) — untouched.
- Full cross-reference audit of every doc — not done.
- Any `scripts/` change — none.
