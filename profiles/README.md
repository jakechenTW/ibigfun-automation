# Authoring a Profile

A **profile** defines one iBigFun search: what to fetch and how to evaluate the
results. This guide lets an agent (Claude / Codex) or a human add or change a
profile **without reading the source**. It is the source of truth for the
profile format; `AGENTS.md` links here.

## Folder layout

Each profile is a **self-contained folder** under `profiles/`. The folder name
**is** the profile id (the value you pass to `--profile`). There is no `id`
field anywhere — rename the folder to rename the profile.

```
profiles/
  example-investment/        # id = folder name
    profile.json             # data: displayName + fetch filter map
    evaluation.md            # agent-facing evaluation rules (criteria, buckets, judgment)
    notify-template.md       # report / notification structure
  example-owner-occupied/
    profile.json
    evaluation.md
    notify-template.md
```

> **Committed vs. private.** This template commits only `example-*` profiles.
> Your own tuned profiles are private: keep them on disk under `profiles/` and
> they are auto-discovered, but git-ignore them (the default `.gitignore`
> ignores `profiles/*.local/` plus the author's own folders). To start your own,
> copy an example folder and rename it, e.g. `cp -r profiles/example-investment
> profiles/my-investment.local`.

All three files are **required**; `loadProfile` rejects a folder that is missing
any of them. Folders are named `<family>-<city>` so future regional variants
(`investment-taichung`, …) sit as symmetric siblings.

The three files:

- **`profile.json`** — pure data: the human label and the `fetch` filter map
  (the only structured condition block; it decides what the API returns).
- **`evaluation.md`** — all agent-side judgment the `fetch` can't express:
  region gates, bucketing, data-quality, suspicious/auction risk, market-price
  estimation, hard criteria as prose. It references the shared
  `docs/reporting-rules.md` rather than copying it.
- **`notify-template.md`** — the structure the agent uses to write the run's
  `report.md` (which is then sent as the notification body).

## `profile.json` schema

```json
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

| Field         | Type   | Required | Meaning |
|---------------|--------|----------|---------|
| `displayName` | string | yes      | The single human-readable label. Used for the console run hint **and** as the notification `ai-notify --task` label. |
| `fetch`       | object | yes      | Generic filter map → `/api/search/list` body params (see below). |

There is **no `id` field** — the id is the folder name. There is no
`notifyTask`, `ruleDocPath`, `templatePath`, `fetchFilters`, `hardCriteria`, or
`requiresFilterVerification`; those were removed. Conditions have exactly two
homes: `fetch` (objective filter) and `evaluation.md` (agent judgment).

## The `fetch` encoding

`buildSearchBody` (`scripts/lib/api.ts`) walks the `fetch` map generically and
emits the `/api/search/list` POST body. Each entry encodes by its value shape:

| `fetch` value             | Emits                                                       |
|---------------------------|-------------------------------------------------------------|
| scalar `"city": "1"`      | `city=1`                                                    |
| `{ min, max }` object     | `key[min_val]=<min or "">` & `key[max_val]=<max or "">`     |
| array `["1", "4"]`        | `key[]=1` & `key[]=4` (repeated)                            |

Notes:

- In a `{min,max}` object, an omitted bound emits an **empty** value
  (`key[min_val]=`), i.e. unbounded on that side. `{ "max": 2500 }` →
  `price_segment[min_val]=` & `price_segment[max_val]=2500`.
- A new filter dimension needs **no code** — just add a key to `fetch`
  (e.g. `"house_age_segment": { "max": 30 }`).
- The **fixed envelope** is not in `fetch` and must not be added there: `page`,
  `method=all_case`, `on_market=1`, `expand=0`, `exclude_land=1`, the
  `source[]`/`source_web[]` allow-lists, and `add_date`/`add_date_max` (the
  target range) are the API contract, hard-coded in `buildSearchBody`.

For the coded ids each key accepts (`city`, `town`, `house_type`, `parking`,
the `*_segment` / `*_number` ranges, etc.) see
**`data/ibigfun-filter-mappings.md`** — it is the human key for the `fetch`
keys.

## Recipe: add a new search

1. Copy an existing folder to the new id:

   ```bash
   cp -r profiles/example-investment profiles/investment-taichung
   ```

2. Edit `profiles/investment-taichung/profile.json` — set `displayName` and the
   `fetch` map (e.g. `"city": "9"` for 台中市; adjust price/floor/etc. per
   `data/ibigfun-filter-mappings.md`).
3. Edit `evaluation.md` and `notify-template.md` for the new search's judgment
   and report structure.
4. Run `--profile investment-taichung`; it is auto-discovered (no allowlist to
   update).

## Ad-hoc overrides (`--set` / `--unset`)

One-off conditions that should **not** be committed to the profile are layered
on at the command line. They target the `fetch` block only:

- `--set fetch.<key>=<val>` — e.g. `--set fetch.price_segment.max=3000`
- `--unset fetch.<path>` — e.g. `--unset fetch.total_floor`
- comma-separated value → array — e.g. `--set fetch.town=16,17`

Example:

```bash
npm run pipeline -- run --profile investment-taipei \
  --set fetch.price_segment.max=3000 --set fetch.city=2
```

Resolution is profile `fetch` → overrides; the merged **effective fetch** is
written to `state/runs/<id>/<label>/effective-profile.json`. Overrides never
touch the committed profile.

**Natural language maps to the same flags.** "跑投資但價格上限改 3000、也看新北"
just means the agent composes `--set fetch.price_segment.max=3000 --set
fetch.city=2`. There is no structured gate for agent judgment — ad-hoc tweaks to
evaluation (e.g. "this run, only recommend ≤2500萬") are expressed in natural
language and the agent reasons via `evaluation.md`.

## Validation & common errors

`loadProfile` / `resolveProfileFromArgs` throw on:

- **Unknown profile** — no `profiles/<id>/profile.json`. The error lists the
  available (auto-discovered) ids.
- **Missing file** — the folder lacks `evaluation.md` or `notify-template.md`.
- **Missing/empty `displayName`** — must be a non-empty string.
- **Missing/invalid `fetch`** — must be an object.
- **Bad override path** — `--set`/`--unset` paths must start with `fetch.`
  (e.g. `--set fetch.price_segment.max=3000`); `--set` needs `key=value`.

Reminder: the id is the folder name, so it never needs to appear inside
`profile.json`.

## No inheritance (yet)

Profiles are flat and self-contained — to make a variant, **copy a folder** (the
recipe above). Single-level composition (`extends`) is deferred until duplicated
`evaluation.md` / `notify-template.md` actually start to drift; see the Future
section of `docs/superpowers/specs/2026-06-28-profile-system-redesign-design.md`.
