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
- A profile can **inherit** from another so regional variants (e.g. 台中投資)
  reuse a parent's rules, template, and most filters, overriding only the delta.
- Inheritance relationships and the final effective conditions are **easy to
  see**.

## Non-Goals (YAGNI)

- **Multi-level inheritance chains.** Single level only (a parent cannot itself
  `extends`). Revisit only if a real need appears.
- **YAML/TOML profile format.** Stay zero-dependency; data stays JSON.
- **A single global shared base.** Not forced. Per-family abstract bases are
  *possible* via the `abstract` flag but not mandated.
- **A query DSL.** The `fetch` map maps directly onto the existing
  `/api/search/list` body params.

## Design

### 1. Folder per profile

A profile is a directory under `profiles/`:

```
profiles/
  investment/
    profile.json     # data: metadata + fetch + eval (clean JSON)
    rules.md         # agent-facing rules (was docs/profiles/investment.md)
    template.md      # notification template (was templates/investment-notify-template.md)
  owner-occupied/
    profile.json
    rules.md
    template.md
```

Each file keeps its natural format — no embedding, no fenced blocks, no heading
demotion. The profile id is the folder name.

Adding a search = copy a folder and edit `profile.json`.

The **shared** rules in `docs/reporting-rules.md` (calculations, sorting,
data-quality, common to all profiles) stay shared and are *referenced* from each
`rules.md`, never copied.

### 2. `profile.json` shape (data-driven filters)

```json
{
  "displayName": "iBigFun 投資房源監測",
  "fetch": {
    "city": "1",
    "price_segment": { "max": 2500 },
    "floor_segment": { "min": 2, "max": 4 },
    "total_floor": { "max": 5 }
  },
  "eval": {}
}
```

**The profile id is the folder name** — it is *not* a field in `profile.json`.
This removes a field to keep in sync when copying a folder, and removes a whole
"id ≠ folder name" error class.

Fields:

- `displayName` (string) — the single human-readable label. Required on a
  runnable profile; may be inherited. Used both for the console run hint **and**
  as the notification `ai-notify --task` label.
- `fetch` (object) — generic filter map → `/api/search/list` body. May be
  inherited and deep-merged.
- `eval` (object, optional, default `{}`) — machine-readable criteria the agent
  applies as its **per-listing include/exclude gate** when evaluating fetched
  results. Distinct from `fetch`, which only narrows what the API *returns*:
  `eval` is what the agent *enforces*, and it can re-check things the API can't
  filter reliably (e.g. `house_type` / `main_ping`, which the API treats as
  server-side-only). May be inherited and deep-merged; overridable via
  `--set eval.*`. For `owner-occupied` it carries the real numeric gates
  (`priceMaxWan`, `floorMin`, `mainPingMin`, `ageMax`, …, i.e. the old
  `hardCriteria`). For `investment` it is `{}` — its gates (開價溢價, 行情,
  region allowlist) are doc-driven in `rules.md`.
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
  `rules.md` / `template.md`, resolved through inheritance).
- The `hardCriteria.profile` placeholder — confirmed read by no code (only
  parsed as a generic object); it merely restated the id. `hardCriteria` is
  renamed `eval`.

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
`investment/profile.json` carries the filters above. `api.test.ts` flips from
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
"discovers whatever folders are on disk" / fixture-based.

Runnable profiles = discovered profiles where `abstract !== true`.

### 5. Single-level inheritance

A profile may declare `"extends": "<parent-id>"`.

**Resolution (`resolveProfile(id)` → effective profile):**

- **Data (`fetch`, `eval`, and the inheritable metadata `displayName`)** —
  deep-merge per key: start from the parent's value, apply the child's keys on
  top. So a child that sets only `fetch.city` keeps all the
  parent's other `fetch` keys.
- **Files (`rules.md`, `template.md`)** — whole-file fallback: if the child's
  folder has the file, use it; otherwise use the parent's. (Prose/templates
  can't be meaningfully merged.)
- `abstract` and `extends` never inherit. (`id` is the folder name, not a
  field, so it cannot inherit.)

**Constraints (validated on load, with clear errors):**

- `extends` must point to an existing profile.
- A profile may not `extends` its own folder name.
- **Single level**: the parent named by `extends` must not itself have
  `extends` (no chains, so no cycles possible).
- A runnable (non-abstract) profile must resolve to a `displayName`,
  `notifyTask`, a non-empty effective `fetch`, an effective `rules.md`, and an
  effective `template.md` (own or inherited).

### 6. `abstract` flag (per-family base, optional)

`"abstract": true` marks a profile as base-only: it is excluded from the
runnable list and running it directly is an error
(`profile "<id>" is abstract and cannot be run`). It can be `extends`-ed and can
supply `fetch`/`eval`/`rules.md`/`template.md` to its children.

This makes both structures expressible with one mechanism, decided **per family,
whenever you want** — no global A-vs-B lock-in:

- **Concrete parent (start here):** `investment` is runnable *and* the parent of
  `investment-taichung`. No `abstract`. Zero upfront ceremony.
- **Abstract per-family base (later, if a family grows):** introduce
  `investment-base` (`abstract: true`); `investment` (台北) and
  `investment-taichung` both `extends` it as symmetric siblings. Because the
  engine already supports `abstract`, this is a data move, not a code change.

Initial migration keeps investment and owner-occupied as plain concrete
profiles — no base extracted yet.

### 7. Inheritance visibility

Three cheap, stacking mechanisms (single level keeps them all trivial):

1. **Naming convention** — derived profiles named `<base>-<variant>` (e.g.
   `investment-taichung`), so they sort under the base in `ls profiles/`.
   Convention only, not enforced.
2. **`npm run pipeline -- profiles`** — prints the inheritance tree computed
   from the real `extends` fields (authoritative; naming is only a hint):

   ```
   investment
   ├─ investment-taichung   (extends investment)
   └─ investment-newpei     (extends investment)
   owner-occupied
   ```

3. **Effective profile at run time** — the run journal / `status` prints the
   resolved profile and, per key, whether each value was inherited or
   overridden:

   ```
   profile: investment-taichung  (extends investment)
     fetch.city          = "9"          (override)
     fetch.price_segment = {max:2500}   (inherited)
     rules.md            ← investment    (inherited)
     template.md         ← investment    (inherited)
   ```

### 8. CLI overrides (ad-hoc one-off conditions)

Generic, non-persisted overrides layered on a base profile:

- `--set fetch.<key>=<val>` — e.g. `--set fetch.price_segment.max=3000`
- `--set eval.<key>=<val>` — e.g. `--set eval.priceMaxWan=8000`
- `--unset <path>` — e.g. `--unset fetch.total_floor`
- comma-separated value → array, e.g. `--set fetch.town=16,17`

Resolution order: parent (via `extends`) → child `profile.json` → CLI
overrides. The merged result is the **effective profile**, written to the run
directory as `state/runs/<profile>/<label>/effective-profile.json`. The fetch
code reads it for the API body; the agent reads it for `eval`, alongside the
resolved `rules.md` / `template.md`. Overrides never touch the committed
profile.

**Natural language is the same primitive.** "跑投資但價格上限改 3000、也看新北"
just means the agent composes `--set fetch.price_segment.max=3000 --set
fetch.city=2`. One mechanism serves both the CLI and NL paths.

## Affected Code & Docs

Code:

- `scripts/lib/profiles.ts` — folder discovery; drop `PROFILE_IDS`; new
  `resolveProfile` (inheritance + deep-merge + validation); remove
  `ProfileFetchFilters` / `searchFiltersFromProfile`; `eval`/`abstract`/`extends`
  parsing.
- `scripts/lib/api.ts` — generic `buildSearchBody`; `SearchFilters` becomes the
  generic map; remove the hard-coded investment default branch.
- `scripts/lib/api.test.ts` — assert `buildSearchBody(investmentFetch)` matches
  the captured body.
- `scripts/lib/profiles.test.ts` — discovery, resolution/merge, override
  parsing, abstract/self/chain validation.
- `scripts/pipeline.ts` — `profiles` subcommand (tree); write
  `effective-profile.json`; print effective profile; update the path hint
  (lines ~96–97) to the folder's resolved `rules.md` / `template.md`.
- CLI flag parsing for `--set` / `--unset` (in the fetch/enrich/pipeline arg
  layer).

Docs:

- `AGENTS.md` — run sequence and source-of-truth map: profiles are folders;
  rules = `profiles/<id>/rules.md`, template = `profiles/<id>/template.md`; the
  notification `--task` uses `displayName`; document `extends` / `abstract` /
  `--set`.
- `docs/fetching.md` — fetch filters now come from `profile.json`'s `fetch` map;
  drop the `fetchFilters.enabled` framing.
- `data/ibigfun-filter-mappings.md` — absorb the investment `description` prose;
  it remains the human key for `fetch` map keys.
- `scripts/lib/region.ts` comment and `docs/reporting-rules.md` reference —
  repoint `docs/profiles/investment.md` → `profiles/investment/rules.md`.

Migration:

- Move `profiles/investment.json` → `profiles/investment/profile.json` (with
  filters lifted from `api.ts` into `fetch`, `hardCriteria` → `eval`).
- Move `docs/profiles/investment.md` → `profiles/investment/rules.md`.
- Move `templates/investment-notify-template.md` →
  `profiles/investment/template.md`.
- Same three moves for `owner-occupied`.
- `docs/reporting-rules.md` stays shared.

## Testing

- `buildSearchBody(investmentFetch)` == captured investment body; owner-occupied
  fetch emits its town/house_type/range params correctly.
- Discovery finds on-disk folders; abstract profiles excluded from runnable.
- `resolveProfile`: child overrides only the keys it sets (deep merge); omitted
  `rules.md`/`template.md` fall back to parent; `id`/`abstract`/`extends` don't
  inherit.
- Profile id is derived from the folder name (no `id` field).
- Validation errors: missing parent, self-extends, chain (parent has `extends`),
  running an abstract profile.
- `--set` / `--unset` parsing: dotted paths, comma→array, fetch vs eval
  namespacing; effective-profile merge order parent → child → overrides.

## Open Questions

None outstanding — resolved during brainstorming. Implementation sequencing
(e.g. ship folder + discovery first, then inheritance, then overrides) is for
the implementation plan.
