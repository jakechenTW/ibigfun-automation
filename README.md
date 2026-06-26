# iBigFun Automation

Workspace for monitoring iBigFun investment property listings, preparing a daily
Markdown report, and sending a concise notification.

## Start Here

**Agents:** read `AGENTS.md` — it is the linear runbook (source model, first-run
prerequisites, daily run sequence, notification command, safety rules, and the
source-of-truth map). Do not duplicate those rules here.

## Credentials

Use a dedicated automation account. Copy `.env.example` to `.env` and fill it
locally; never commit `.env`. See `docs/credentials.md`.

## Repository Layout

- `AGENTS.md` — runbook and entrypoint.
- `docs/` — fetching, credentials, reporting rules, automation state.
- `data/` — static reference data (Taipei MRT exit coordinates).
- `templates/` — notification template.
- `reports/`, `state/` — local generated output and state; git-ignored.

## Safety

See the safety rules in `AGENTS.md`. In short: never commit credentials,
sessions, browser profiles, automation state, traces, screenshots, downloaded
pages, or any local output containing secrets.
