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
