# Profile System Redesign — Folder Profiles, Data-Driven Filters

Date: 2026-06-28
Status: Design (approved in brainstorming; pending spec review)

## Problem

Changing search conditions and adding new searches is harder than it should be.
Concretely, today:

1. **Closed allowlist** — `scripts/lib/profiles.ts` hard-codes
   `PROFILE_IDS = ['investment', 'owner-occupied']`. A new profile won't load
   until its id is added here, and `profiles.test.ts` locks the exact list.
2. **Filters split-brained into code** — `investment` runs with
   `fetchFilters.enabled: false`, so its *real* fetch filters live in
   `scripts/lib/api.ts` (`buildSearchBody` default branch), not in
   `profiles/investment.json`. The JSON is only descriptive prose.
3. **Fixed-field filter schema** — `ProfileFetchFilters` is a closed set of
   typed fields (`priceMaxWan`, `floorMin`, …). Adding a new filter dimension
   means editing the interface, `searchFiltersFromProfile`, and
   `buildSearchBody`.
4. **A profile is scattered across three top-level dirs** — data in
   `profiles/<id>.json`, rules in `docs/profiles/<id>.md`, template in
   `templates/<id>-notify-template.md`. `loadProfile` also throws unless the rule
   doc and template *exist*, so a new search means authoring three files in three
   places.

Net: adding one search = ~5 edits across 5 files, 3 of them friction rather
than content.

## Goals

- Adding a new search = create **one self-contained folder** (copy an existing
  one and edit it), zero code changes.
- Filter conditions are **data**, editable in one place; new filter dimensions
  need no code.
- Ad-hoc one-off conditions without touching the committed profile (CLI flags;
  natural language maps to the same flags).
- An **authoring guide** lets an AI agent (Claude / Codex) write a profile
  correctly without reading the source.

## Non-Goals (YAGNI)

- **Inheritance / base profiles / `evaluation.md` composition.** Deferred on
  purpose. Today each family (investment, owner-occupied) has exactly one member
  and **no variants exist**, so there is nothing to share yet, and both `fetch`
  and the bulk of `evaluation.md` turn out to be per-profile. Profiles are
  **flat and self-contained**. The folder layout lets us add `extends` +
  composition later, non-disruptively, *if* multiple regional variants appear
  and duplication actually hurts (see Future).
- **YAML/TOML profile format.** Stay zero-dependency; data stays JSON.
- **A query DSL.** The `fetch` map maps directly onto the existing
  `/api/search/list` body params.

## Design

### 1. Folder per profile (flat, self-contained)

A profile is a self-contained directory under `profiles/`:

```
profiles/
  investment-taipei/
    profile.json        # data: displayName + fetch (clean JSON)
    evaluation.md       # agent-facing evaluation (was docs/profiles/investment.md)
    notify-template.md  # notification template (was templates/investment-notify-template.md)
  owner-occupied-taipei/
    profile.json
    evaluation.md
    notify-template.md
```

Folders are named `<family>-<city>` so future regional variants
(`investment-taichung`, …) sit as symmetric siblings. The profile id = folder
name, so the runnable ids are `investment-taipei` / `owner-occupied-taipei`.

Each file keeps its natural format — no embedding, no fenced blocks, no heading
demotion. The profile id is the folder name. Every runnable profile carries its
own three files; there is no inheritance, so nothing is resolved from elsewhere.

Adding a search = **copy a folder and edit the three files.** The friction the
old layout had (three files in three top-level dirs, plus a code-side allowlist)
is gone: one folder, copied as a unit.

The **shared** rules in `docs/reporting-rules.md` (calculations, sorting,
data-quality, common to all profiles) stay shared and are *referenced* from each
`evaluation.md`, never copied.

### 2. `profile.json` shape (data-driven filters)

```json
// profiles/investment-taipei/profile.json
{
  "displayName": "iBigFun 台北投資房源監測",
  "fetch": {
    "city": "1",
    "price_segment": { "max": 2500 },
    "floor_segment": { "min": 2, "max": 4 },
    "total_floor": { "max": 5 }
  }
}
```

**The profile id is the folder name** — it is *not* a field in `profile.json`.
This removes a field to keep in sync when copying a folder, and removes a whole
"id ≠ folder name" error class.

Fields:

- `displayName` (string, required) — the single human-readable label. Used both
  for the console run hint **and** as the notification `ai-notify --task` label.
- `fetch` (object, required) — generic filter map → `/api/search/list` body
  (§3). This is the **only structured condition block** — it decides what the
  API returns. All agent-side evaluation (gates the fetch can't express,
  bucketing, data-quality, risk judgment, estimation) lives in `evaluation.md`,
  not in `profile.json`.

Dropped from the old schema:

- `id` — now the folder name (above).
- `notifyTask` — `displayName` now serves as the `ai-notify --task` label.
  (Side effect: the task label loses the "每日" prefix, which is more accurate
  anyway since runs may cover a multi-day range.)
- `requiresFilterVerification`, `fetchFilters.enabled`, the
  `fetchFilters.description` prose.
- `ruleDocPath` / `templatePath` — paths are now implicit (the folder's
  `evaluation.md` / `notify-template.md`).
- `hardCriteria` (and the structured `eval` we briefly considered) — **removed
  entirely.** Read by no code (only parsed as a generic object), and redundant:
  for `owner-occupied` the numeric gates are already enforced by `fetch`, and the
  real agent work (bucketing, data-quality, suspicious/auction risk,
  walk-as-sorting, market-price estimation) is prose judgment that already lives
  in `evaluation.md`. The `house_type` / `main_ping` filters are *trusted
  server-side* (the API applies them; the response just can't re-verify them — it
  returns `typeLayout`/`total_ping`), so they need no separate re-check gate.
  Result: conditions have exactly two homes — `fetch` (objective filter) and
  `evaluation.md` (agent judgment).

The descriptive prose from `fetchFilters.description` moves to
`data/ibigfun-filter-mappings.md`, which already holds the filter-key reference.

### 3. Generic `fetch` map → API body

`buildSearchBody` collapses from two branches to: **fixed envelope + a generic
walk over the `fetch` map.**

Fixed envelope stays hard-coded in `scripts/lib/api.ts` (it is the API
contract, not a user condition): `method=all_case`, `on_market=1`, `expand=0`,
`exclude_land=1`, the `source[]` / `source_web[]` allow-lists, `page`, and
`add_date` / `add_date_max` (the target range).

Generic emission rules for each `fetch` entry:

| `fetch` value         | Emits                                                |
|-----------------------|------------------------------------------------------|
| scalar `"city": "1"`  | `city=1`                                              |
| `{min,max}` object    | `key[min_val]=<min or "">` & `key[max_val]=<max or "">` |
| array `["1","4"]`     | `key[]=1` & `key[]=4`                                 |

This single rule set reproduces the captured investment shape exactly once
`investment-taipei/profile.json` carries the filters above. `api.test.ts` flips from
locking the hard-coded default branch to asserting
`buildSearchBody(from, to, page, investmentFetch)` produces the same captured
body — behavior provably unchanged.

The fixed-field `ProfileFetchFilters` interface and `searchFiltersFromProfile`
are removed; `SearchFilters` becomes the generic map type (or `buildSearchBody`
takes the `fetch` object directly).

New dimension (e.g. an age cap) = add `"house_age_segment": { "max": 30 }` to a
`profile.json`. No code change.

### 4. Auto-discovery

`availableProfileIds()` and `loadProfile` scan the `profiles/` directory for
`*/profile.json` instead of reading a `PROFILE_IDS` constant. The constant and
the exact-list assertion in `profiles.test.ts` are removed; the test becomes
"discovers whatever folders are on disk" / fixture-based. `loadProfile` validates
that the folder has `profile.json`, `evaluation.md`, and `notify-template.md`,
and that `profile.json` has a non-empty `displayName` and `fetch`.

### 5. CLI overrides (ad-hoc one-off conditions)

Generic, non-persisted overrides on the `fetch` block, layered on a profile:

- `--set fetch.<key>=<val>` — e.g. `--set fetch.price_segment.max=3000`
- `--unset fetch.<path>` — e.g. `--unset fetch.total_floor`
- comma-separated value → array, e.g. `--set fetch.town=16,17`

Overrides target `fetch` only — it is the one structured block. Ad-hoc tweaks to
agent judgment (e.g. "this run, only recommend ≤2500") are expressed in natural
language to the agent, which reasons via `evaluation.md`; there is no structured
gate to override.

Resolution: profile `fetch` → CLI overrides. The merged result (the **effective
fetch** + metadata) is written to the run directory as
`state/runs/<profile>/<label>/effective-profile.json`. The fetch code reads it
for the API body; the agent reads the profile's `evaluation.md` /
`notify-template.md` (with the effective `fetch` for context). Overrides never
touch the committed profile. The run journal / `status` prints the effective
`fetch`, marking which keys came from `--set`:

```
profile: investment-taipei
  fetch.price_segment = {max:3000}   (--set)
  fetch.city          = "1"          (profile)
  fetch.floor_segment = {min:2,max:4}(profile)
```

**Natural language is the same primitive.** "跑投資但價格上限改 3000、也看新北"
just means the agent composes `--set fetch.price_segment.max=3000 --set
fetch.city=2`. One mechanism serves both the CLI and NL paths.

### 6. Authoring guide for agents (`profiles/README.md`)

A single committed doc, co-located at `profiles/README.md`, teaches an AI agent
(Claude / Codex) **how to write a profile** without reading the source. It is
linked from `AGENTS.md`'s source-of-truth map (co-location matches the existing
`data/README.md` convention; keeps `AGENTS.md` a lean entrypoint). It covers:

- **Layout** — a profile is a self-contained folder; the three files
  (`profile.json` / `evaluation.md` / `notify-template.md`) and what each is for.
- **`profile.json` schema** — `displayName`, `fetch` (both required).
- **`fetch` encoding** — the scalar / `{min,max}` / array → API-body rules (§3
  table), with a pointer to `data/ibigfun-filter-mappings.md` for the key/id
  reference (city/town/house_type/etc.).
- **Recipe: add a search** — `cp -r` an existing folder, rename, edit
  `displayName` + `fetch`, adjust `evaluation.md` / `notify-template.md`.
- **CLI overrides** — `--set fetch.*` / `--unset fetch.*` for ad-hoc runs, and
  that natural-language requests map to these.
- **Validation & common errors** — id = folder name; the folder must contain all
  three files; `fetch`/`displayName` required.
- **No inheritance (yet)** — to make a variant, copy a folder; one line pointing
  to the Future section in case duplication later motivates composition.

## Affected Code & Docs

Code:

- `scripts/lib/profiles.ts` — folder discovery; drop `PROFILE_IDS`; `loadProfile`
  reads `profiles/<id>/profile.json`, validates the folder's three files and the
  `displayName`/`fetch` fields; remove `ProfileFetchFilters` /
  `searchFiltersFromProfile` and the `hardCriteria` field.
- `scripts/lib/api.ts` — generic `buildSearchBody`; `SearchFilters` becomes the
  generic map; remove the hard-coded investment default branch.
- `scripts/lib/api.test.ts` — assert `buildSearchBody(investmentFetch)` matches
  the captured body.
- `scripts/lib/profiles.test.ts` — discovery, parsing, validation (missing
  folder / missing file / missing field).
- `scripts/pipeline.ts` — write `effective-profile.json`; print the effective
  `fetch` with `--set` markers; update the path hint (lines ~96–97) to the
  folder's `evaluation.md` / `notify-template.md`. (Optional: a `profiles`
  subcommand that lists discovered profiles + `displayName`.)
- CLI flag parsing for `--set fetch.*` / `--unset fetch.*` (in the
  fetch/enrich/pipeline arg layer).

Docs:

- `profiles/README.md` (**new**) — the agent authoring guide (§6). Linked from
  `AGENTS.md`'s source-of-truth map.
- `AGENTS.md` — run sequence and source-of-truth map: profiles are folders;
  the runnable ids are now `investment-taipei` / `owner-occupied-taipei`;
  evaluation = `profiles/<id>/evaluation.md`, template =
  `profiles/<id>/notify-template.md`; the notification `--task` uses
  `displayName`; conditions live in `fetch` + `evaluation.md` (no
  `hardCriteria`/`eval`); document `--set fetch.*`.
- `docs/fetching.md` — fetch filters now come from `profile.json`'s `fetch` map;
  drop the `fetchFilters.enabled` framing.
- `data/ibigfun-filter-mappings.md` — absorb the investment `description` prose;
  it remains the human key for `fetch` map keys.
- `scripts/lib/region.ts` comment and `docs/reporting-rules.md` reference —
  repoint `docs/profiles/investment.md` → `profiles/investment-taipei/evaluation.md`.

Migration (flat folders, no base):

- **investment → `investment-taipei`**
  - `profiles/investment-taipei/profile.json` — `displayName`
    ("iBigFun 台北投資房源監測") + full `fetch` (city + price/floor/total_floor,
    the filters lifted from `api.ts`). Drop `hardCriteria` and all other dropped
    fields.
  - `profiles/investment-taipei/evaluation.md` — the full
    `docs/profiles/investment.md` (including the 台北 35-station
    region-allowlist rule — it stays here since this is a single 台北 profile).
  - `profiles/investment-taipei/notify-template.md` — from
    `templates/investment-notify-template.md`.
- **owner-occupied → `owner-occupied-taipei`** — same three moves; its `fetch`
  carries city/town/house_type/price/floor/main_ping/age/parking. Its old
  `hardCriteria` numeric gates are already enforced by `fetch` and described in
  `evaluation.md` ("Hard Criteria" section), so nothing is lost by dropping the
  JSON copy.
- `docs/reporting-rules.md` stays shared (referenced from each `evaluation.md`).
- **The runnable ids change** (`investment` → `investment-taipei`,
  `owner-occupied` → `owner-occupied-taipei`). Update every `--profile`
  reference — cron triggers, `prompts/schedule-triggers.md`,
  `prompts/daily-run.md`, and any `AGENTS.md` prose that names the old ids. New
  runs write under `state/runs/<new-id>/...`; old git-ignored run state under the
  former ids can be left or deleted.

## Testing

- `buildSearchBody(investmentFetch)` == captured investment body; owner-occupied
  fetch emits its town/house_type/range params correctly.
- Discovery finds on-disk folders; profile id is the folder name (no `id` field).
- `loadProfile` validation errors: unknown profile (no folder), missing
  `evaluation.md` / `notify-template.md`, missing `displayName` / `fetch`.
- `--set fetch.*` / `--unset fetch.*` parsing: dotted paths, comma→array;
  effective-fetch merge order profile → overrides.

## Future (deferred, not in this change)

If multiple regional variants of a family appear and the duplicated
`evaluation.md` / `notify-template.md` start to drift, add **single-level
composition** without disturbing the flat layout:

- A `extends: "<folder>"` field on a leaf's `profile.json`.
- A base folder (no `profile.json` → not discovered as runnable) holding the
  shared `evaluation.md` + `notify-template.md`.
- `evaluation.md` composes base → leaf (leaf wins on conflict);
  `notify-template.md` falls back to the base; `fetch` stays fully per-leaf.

This is recorded only so the current flat design stays forward-compatible; it is
**not** built now.

## Open Questions

None outstanding — resolved during brainstorming. Implementation sequencing
(e.g. folder migration + discovery first, then generic `buildSearchBody`, then
`--set` overrides, then the authoring guide) is for the implementation plan.
