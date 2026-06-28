# Profile System Redesign — Folder Profiles, Data-Driven Filters, Inheritance

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
4. **A profile is scattered + won't load without three files** — data in
   `profiles/<id>.json`, rules in `docs/profiles/<id>.md`, template in
   `templates/<id>-notify-template.md`. `loadProfile` validates that the rule
   doc and template *exist* or it throws, so a new search requires authoring
   three files in three top-level directories.

Net: adding one search = ~5 edits across 5 files, 3 of them friction rather
than content.

## Goals

- Adding a new search = create **one folder**, zero code changes, zero forced
  extra files.
- Filter conditions are **data**, editable in one place; new dimensions need no
  code.
- A profile can **inherit** from a family base so regional variants (e.g.
  台中投資) reuse the base's filters, evaluation, and template, overriding only
  the delta. `evaluation.md` **composes** (base + variant deltas), not just
  replace-or-inherit.
- Inheritance relationships and the final effective conditions are **easy to
  see**.
- An **authoring guide** lets an AI agent (Claude / Codex) write or extend a
  profile correctly without reading the source.

## Non-Goals (YAGNI)

- **Multi-level inheritance chains.** Single level only (a parent cannot itself
  `extends`). Revisit only if a real need appears.
- **YAML/TOML profile format.** Stay zero-dependency; data stays JSON.
- **A single global shared base across unrelated families.** Each family gets
  its *own* abstract base (`investment-base`, `owner-occupied-base`); there is no
  one base shared between investment and owner-occupied (they have almost nothing
  in common).
- **A query DSL.** The `fetch` map maps directly onto the existing
  `/api/search/list` body params.

## Design

### 1. Folder per profile

A profile is a directory under `profiles/`. Each family is an **abstract base**
(shared filters/evaluation/template) plus one or more **runnable leaves** (the
distinguishing delta — e.g. the city/region):

```
profiles/
  investment-base/            # abstract: not runnable; holds shared investment bits
    profile.json              #   fetch: price/floor/total_floor (no city)
    evaluation.md             #   generic investment evaluation (開價溢價, 行情, buckets)
    notify-template.md        #   shared investment template
  investment/                 # runnable leaf — 台北
    profile.json              #   extends investment-base; fetch.city="1"; displayName
    evaluation.md             #   台北 delta only (e.g. 35-station 捷運 allowlist)
  owner-occupied-base/        # abstract
    profile.json              #   fetch: house_type/price/floor/main_ping/age/parking
    evaluation.md
    notify-template.md
  owner-occupied/             # runnable leaf — 台北
    profile.json              #   extends owner-occupied-base; fetch.city + town; displayName
```

Each file keeps its natural format — no embedding, no fenced blocks, no heading
demotion. The profile id is the folder name. A leaf omits any file it inherits
unchanged (here, the leaves keep the base's `notify-template.md`).

Adding a regional variant (e.g. 台中投資) = create `investment-taichung/` with a
small `profile.json` (`extends: investment-base`, `displayName`,
`fetch.city`) and, if its region rules differ, an `evaluation.md` holding just
that delta. Nothing else.

The **shared** rules in `docs/reporting-rules.md` (calculations, sorting,
data-quality, common to all profiles) stay shared and are *referenced* from each
`evaluation.md`, never copied.

### 2. `profile.json` shape (data-driven filters)

Abstract base — shared filters, no `city`, no `displayName` (never run):

```json
// profiles/investment-base/profile.json
{
  "abstract": true,
  "fetch": {
    "price_segment": { "max": 2500 },
    "floor_segment": { "min": 2, "max": 4 },
    "total_floor": { "max": 5 }
  }
}
```

Runnable leaf — only the delta:

```json
// profiles/investment/profile.json
{
  "extends": "investment-base",
  "displayName": "iBigFun 投資房源監測",
  "fetch": { "city": "1" }
}
```

Effective `fetch` for `investment` = `{ city:"1", price_segment:{max:2500},
floor_segment:{min:2,max:4}, total_floor:{max:5} }`.

**The profile id is the folder name** — it is *not* a field in `profile.json`.
This removes a field to keep in sync when copying a folder, and removes a whole
"id ≠ folder name" error class.

Fields:

- `displayName` (string) — the single human-readable label. Required on a
  runnable (leaf) profile; not needed on an abstract base. Used both for the
  console run hint **and** as the notification `ai-notify --task` label.
- `fetch` (object) — generic filter map → `/api/search/list` body. May be
  inherited and deep-merged. This is the **only structured condition block** —
  it decides what the API returns. All agent-side evaluation (gates the fetch
  can't express, bucketing, data-quality, risk judgment, estimation) lives in
  `evaluation.md`, not in `profile.json`.
- `extends` (string, optional) — parent profile id (see Inheritance).
- `abstract` (boolean, optional, default `false`) — if `true`, not runnable
  (base only).

Dropped from the old schema:

- `id` — now the folder name (above).
- `notifyTask` — `displayName` now serves as the `ai-notify --task` label.
  (Side effect: the task label loses the "每日" prefix, which is more accurate
  anyway since runs may cover a multi-day range.)
- `requiresFilterVerification`, `fetchFilters.enabled`, the
  `fetchFilters.description` prose.
- `ruleDocPath` / `templatePath` — paths are now implicit (the folder's
  `evaluation.md` / `notify-template.md`, resolved through inheritance).
- `hardCriteria` (and the structured `eval` we briefly considered) — **removed
  entirely.** It was read by no code (only parsed as a generic object), and its
  contents were redundant: for `owner-occupied` the numeric gates are already
  enforced by `fetch`, and the real agent work (bucketing, data-quality,
  suspicious/auction risk, walk-as-sorting, market-price estimation) is prose
  judgment that already lives in `evaluation.md`. The `house_type` / `main_ping`
  filters are *trusted server-side* (the API applies them; the response just
  can't re-verify them — it returns `typeLayout`/`total_ping`), so they need no
  separate re-check gate. Result: conditions have exactly two homes — `fetch`
  (objective filter) and `evaluation.md` (agent judgment).

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

This single rule set reproduces the captured investment shape exactly from the
**resolved** `investment` fetch (`investment-base` price/floor/total_floor +
leaf `city:"1"`). `api.test.ts` flips from locking the hard-coded default branch
to asserting `buildSearchBody(from, to, page, resolvedInvestmentFetch)` produces
the same captured body — behavior provably unchanged.

The fixed-field `ProfileFetchFilters` interface and `searchFiltersFromProfile`
are removed; `SearchFilters` becomes the generic map type (or `buildSearchBody`
takes the `fetch` object directly).

New dimension (e.g. an age cap) = add `"house_age_segment": { "max": 30 }` to a
`profile.json`. No code change.

### 4. Auto-discovery

`availableProfileIds()` and `loadProfile` scan the `profiles/` directory for
`*/profile.json` instead of reading a `PROFILE_IDS` constant. The constant and
the exact-list assertion in `profiles.test.ts` are removed; the test becomes
"discovers whatever folders are on disk" / fixture-based.

Runnable profiles = discovered profiles where `abstract !== true`.

### 5. Single-level inheritance

A profile may declare `"extends": "<parent-id>"`.

**Resolution (`resolveProfile(id)` → effective profile):**

- **`fetch` + inheritable metadata (`displayName`)** — deep-merge per key: start
  from the parent's value, apply the child's keys on top. So a child that sets
  only `fetch.city` keeps all the parent's other `fetch` keys.
- **`evaluation.md` — composition (concatenation).** The effective evaluation is
  the chain's `evaluation.md` files joined **base → leaf**, with a clear divider
  between them. The base holds the generic family evaluation; the leaf holds only
  its deltas (e.g. its region allowlist). **On conflict the later (leaf) section
  governs** — stated as an explicit rule the agent follows. A leaf with no
  `evaluation.md` just inherits the base's. The resolver returns the ordered
  `evaluationChain`; the pipeline writes the combined result into the run dir
  (`state/runs/<profile>/<label>/evaluation.md`) so the agent reads one file.
- **`notify-template.md` — whole-file fallback** (replace-or-inherit): a literal
  fill-in template can't be concatenated, so the leaf's file is used if present,
  otherwise the base's.
- `abstract` and `extends` never inherit. (`id` is the folder name, not a
  field, so it cannot inherit.)

**Constraints (validated on load, with clear errors):**

- `extends` must point to an existing profile.
- A profile may not `extends` its own folder name.
- **Single level**: the parent named by `extends` must not itself have
  `extends` (no chains, so no cycles possible).
- A runnable (non-abstract) profile must resolve to a `displayName`, a non-empty
  effective `fetch`, an effective `evaluation.md`, and an effective
  `notify-template.md` (own or inherited).

### 6. `abstract` per-family base (the default structure)

`"abstract": true` marks a profile as base-only: it is excluded from the
runnable list and running it directly is an error
(`profile "<id>" is abstract and cannot be run`). It is `extends`-ed by its
family's leaves and supplies `fetch` / `evaluation.md` / `notify-template.md`.

**Each family is extracted into an abstract base from the start** (not deferred):

- `investment-base` (`abstract`) → `investment` (台北 leaf), later
  `investment-taichung`, … as symmetric siblings.
- `owner-occupied-base` (`abstract`) → `owner-occupied` (台北 leaf), …

Why up front rather than "concrete parent, extract later": it keeps every
runnable profile a thin leaf and the shared bits in one place, so adding a
variant never means retrofitting an existing runnable profile into a base, and
changing one variant never touches its siblings. The base/leaf split also gives
`evaluation.md` composition a natural home (generic rules in the base, region
deltas in each leaf).

The base carries everything common; the leaf carries only what distinguishes it
(typically `fetch.city` / `fetch.town`, `displayName`, and a small
`evaluation.md` delta). A base needs no `displayName` (never run/notified).

### 7. Inheritance visibility

Three cheap, stacking mechanisms (single level keeps them all trivial):

1. **Naming convention** — a family base is `<family>-base`; its primary leaf
   keeps the canonical family name (`investment`, preserved so existing
   `--profile investment` / cron triggers keep working); further variants are
   `<family>-<variant>` (e.g. `investment-taichung`). They sort together in
   `ls profiles/`. Convention only, not enforced (abstract-ness comes from the
   flag, not the name).
2. **`npm run pipeline -- profiles`** — prints the inheritance tree computed
   from the real `extends` fields (authoritative; naming is only a hint):

   ```
   investment-base (abstract)
   ├─ investment            (extends investment-base)
   └─ investment-taichung   (extends investment-base)
   owner-occupied-base (abstract)
   └─ owner-occupied        (extends owner-occupied-base)
   ```

3. **Effective profile at run time** — the run journal / `status` prints the
   resolved profile and, per key, whether each value was inherited or
   overridden:

   ```
   profile: investment-taichung  (extends investment-base)
     fetch.city          = "9"          (override)
     fetch.price_segment = {max:2500}   (inherited)
     evaluation.md       = investment-base + investment-taichung  (composed)
     notify-template.md  ← investment-base   (inherited)
   ```

### 8. CLI overrides (ad-hoc one-off conditions)

Generic, non-persisted overrides on the `fetch` block, layered on a base
profile:

- `--set fetch.<key>=<val>` — e.g. `--set fetch.price_segment.max=3000`
- `--unset fetch.<path>` — e.g. `--unset fetch.total_floor`
- comma-separated value → array, e.g. `--set fetch.town=16,17`

Overrides target `fetch` only — it is the one structured block. Ad-hoc tweaks to
agent judgment (e.g. "this run, only recommend ≤2500") are expressed in natural
language to the agent, which reasons via `evaluation.md`; there is no structured
gate to override.

Resolution order: parent (via `extends`) → child `profile.json` → CLI
overrides. The merged result is the **effective profile**, written to the run
directory as `state/runs/<profile>/<label>/effective-profile.json` (the resolved
`fetch` + metadata), alongside the **composed** `evaluation.md` (base + leaf)
and the resolved `notify-template.md`. The fetch code reads the effective profile
for the API body; the agent reads the composed `evaluation.md` and the template
(with the effective `fetch` for context). Overrides never touch the committed
profile.

**Natural language is the same primitive.** "跑投資但價格上限改 3000、也看新北"
just means the agent composes `--set fetch.price_segment.max=3000 --set
fetch.city=2`. One mechanism serves both the CLI and NL paths.

### 9. Authoring guide for agents (`profiles/README.md`)

A single committed doc, co-located at `profiles/README.md`, teaches an AI agent
(Claude / Codex) **how to write or extend a profile** without reading the
source. It is linked from `AGENTS.md`'s source-of-truth map. It covers:

- **Layout** — a profile is a folder; the three files
  (`profile.json` / `evaluation.md` / `notify-template.md`) and what each is for.
- **`profile.json` schema** — `displayName`, `fetch`, `extends`, `abstract`;
  which are required on a leaf vs a base.
- **`fetch` encoding** — the scalar / `{min,max}` / array → API-body rules
  (the §3 table), with a pointer to `data/ibigfun-filter-mappings.md` for the
  key/id reference (city/town/house_type/etc.).
- **Inheritance** — single-level `extends`; `fetch` deep-merge; `evaluation.md`
  composition (base → leaf, leaf wins on conflict; author the leaf as deltas);
  `notify-template.md` replace-or-inherit; the `<family>-base` + leaf pattern.
- **Recipe: add a regional variant** — `mkdir profiles/<family>-<variant>/`,
  write `profile.json` (`extends`, `displayName`, delta `fetch`), add an
  `evaluation.md` delta only if region rules differ.
- **CLI overrides** — `--set fetch.*` / `--unset fetch.*` for ad-hoc runs, and
  that natural-language requests map to these.
- **Validation & common errors** — id = folder name; `extends` must point to an
  existing profile; single-level only; abstract can't be run; leaf must resolve
  to all required parts.
- **Seeing inheritance** — `npm run pipeline -- profiles` and the run-time
  effective-profile printout.

## Affected Code & Docs

Code:

- `scripts/lib/profiles.ts` — folder discovery; drop `PROFILE_IDS`; new
  `resolveProfile` (inheritance: `fetch` deep-merge, `displayName`,
  `evaluationChain` ordered base→leaf, resolved `notify-template.md` path,
  validation); remove `ProfileFetchFilters` / `searchFiltersFromProfile` and the
  `hardCriteria` field; `abstract`/`extends` parsing.
- `scripts/lib/api.ts` — generic `buildSearchBody`; `SearchFilters` becomes the
  generic map; remove the hard-coded investment default branch.
- `scripts/lib/api.test.ts` — assert `buildSearchBody(investmentFetch)` matches
  the captured body.
- `scripts/lib/profiles.test.ts` — discovery, resolution/merge, override
  parsing, abstract/self/chain validation.
- `scripts/pipeline.ts` — `profiles` subcommand (tree); write
  `effective-profile.json` **and the composed `evaluation.md`** (concat the
  `evaluationChain`) into the run dir; print effective profile; update the path
  hint (lines ~96–97) to the resolved evaluation/template.
- CLI flag parsing for `--set fetch.*` / `--unset fetch.*` (in the
  fetch/enrich/pipeline arg layer).

Docs:

- `profiles/README.md` (**new**) — the agent authoring guide (§9). Linked from
  `AGENTS.md`'s source-of-truth map.
- `AGENTS.md` — run sequence and source-of-truth map: profiles are folders;
  evaluation = `profiles/<id>/evaluation.md`, template =
  `profiles/<id>/notify-template.md`; the notification `--task` uses
  `displayName`;
  conditions live in `fetch` + `evaluation.md` (no `hardCriteria`/`eval`);
  document `extends` / `abstract` / `--set fetch.*`.
- `docs/fetching.md` — fetch filters now come from `profile.json`'s `fetch` map;
  drop the `fetchFilters.enabled` framing.
- `data/ibigfun-filter-mappings.md` — absorb the investment `description` prose;
  it remains the human key for `fetch` map keys.
- `scripts/lib/region.ts` comment and `docs/reporting-rules.md` reference —
  repoint `docs/profiles/investment.md` → `profiles/investment/evaluation.md`.

Migration (split each family into abstract base + 台北 leaf):

- **investment**
  - `profiles/investment-base/profile.json` — `abstract: true`, `fetch` =
    price/floor/total_floor (lifted from `api.ts`; **no** `city`). Drop
    `hardCriteria` and all other dropped fields.
  - `profiles/investment-base/evaluation.md` — generic investment evaluation
    from `docs/profiles/investment.md`, **minus** the 台北-specific 35-station
    region-allowlist rule.
  - `profiles/investment-base/notify-template.md` — from
    `templates/investment-notify-template.md`.
  - `profiles/investment/profile.json` — `extends: investment-base`,
    `displayName`, `fetch.city = "1"`.
  - `profiles/investment/evaluation.md` — only the 台北 region-allowlist delta
    (references `data/region-allowlist.md`).
- **owner-occupied** — same split: base holds
  house_type/price/floor/main_ping/age/parking `fetch` + evaluation + template;
  leaf holds `extends`, `displayName`, `fetch.city` + `fetch.town`, and the
  台北 district list as its `evaluation.md` delta. The old `hardCriteria` numeric
  gates are already enforced by `fetch` and described in `evaluation.md`, so
  nothing is lost by dropping the JSON copy.
- `docs/reporting-rules.md` stays shared (referenced from each base's
  `evaluation.md`).
- Confirm cron triggers / `prompts/` still pass `--profile investment` /
  `--profile owner-occupied` (the runnable leaf ids are unchanged).

## Testing

- `buildSearchBody(investmentFetch)` == captured investment body; owner-occupied
  fetch emits its town/house_type/range params correctly.
- Discovery finds on-disk folders; abstract profiles excluded from runnable;
  running an abstract base errors.
- `resolveProfile`: leaf overrides only the `fetch` keys it sets (deep merge);
  `evaluation.md` composes base→leaf in order; a leaf with no `evaluation.md`
  yields the base's alone; `notify-template.md` falls back to the base;
  `abstract`/`extends` don't inherit.
- Profile id is derived from the folder name (no `id` field).
- Validation errors: missing parent, self-extends, chain (parent has `extends`),
  running an abstract profile, leaf missing a required resolved part.
- `--set fetch.*` / `--unset fetch.*` parsing: dotted paths, comma→array;
  effective-profile merge order parent → child → overrides.

## Open Questions

None outstanding — resolved during brainstorming. Implementation sequencing
(e.g. ship folder + discovery first, then inheritance, then overrides) is for
the implementation plan.
