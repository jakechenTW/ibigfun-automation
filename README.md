# iBigFun Automation

Workspace for monitoring iBigFun property listings through explicit profiles,
preparing profile-specific Markdown reports, and sending concise notifications.

## Start Here

**Agents:** read `AGENTS.md` — it is the linear runbook (source model, first-run
prerequisites, daily run sequence, notification command, safety rules, and the
source-of-truth map). Do not duplicate those rules here.

## Credentials

Use a dedicated automation account. Copy `.env.example` to `.env` and fill it
locally; never commit `.env`. See `docs/credentials.md`.

## Profiles

Every run requires `--profile <id>`.

- `investment`: current rental-yield investment monitor.
- `owner-occupied`: self-use monitor with saved iBigFun search criteria
  documented/designed, but incomplete until `fetchFilters.enabled` is true. For
  now, runs use the captured shared fetch universe and must notify `warn`.

Run artifacts live under `state/runs/<profile>/<label>/`.

## Repository Layout

- `AGENTS.md` — runbook and entrypoint.
- `docs/` — fetching, credentials, shared reporting rules, profile rules,
  automation state.
- `data/` — static reference data (Taipei MRT exit coordinates).
- `profiles/` — profile metadata, notification task names, and future fetch
  filter definitions.
- `templates/` — profile-specific notification templates.
- `state/` — local generated output and state; git-ignored. Per-run artifacts
  (`listings.json`, `enriched.json`, `report.md`) live under
  `state/runs/<profile>/<label>/`.

## Safety

See the safety rules in `AGENTS.md`. In short: never commit credentials,
sessions, browser profiles, automation state, traces, screenshots, downloaded
pages, or any local output containing secrets.
