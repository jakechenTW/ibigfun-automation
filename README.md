# iBigFun Automation

Project workspace for monitoring iBigFun investment property listings, preparing daily Markdown reports, and sending concise notifications.

## Structure

- `AGENTS.md`: shared agent entrypoint and safety rules.
- `docs/daily-workflow.md`: source of truth for the daily monitoring procedure.
- `docs/credentials.md`: credential storage and login handling.
- `docs/reporting-rules.md`: investment criteria, calculations, data quality, sorting, and notification rules.
- `docs/automation-state.md`: durable state and deduplication conventions.
- `data/`: static reference data, such as Taipei MRT exit coordinates for distance checks.
- `templates/`: reusable notification templates.
- `reports/`: local generated notification/report files; ignored by git.
- `state/`: future local automation state, such as seen listing IDs; ignored by git.

## Credentials

Use a dedicated automation account. Copy `.env.example` to `.env` and fill it locally. Do not commit `.env`.

See `docs/credentials.md` for details.

## Daily Report Workflow

Follow `docs/daily-workflow.md`.

Recurring runs report on the previous calendar day in the `Asia/Taipei` timezone, not the run date. For example, a run on `2026-06-27` reports listings published on `2026-06-26`.

Current notification route:

```bash
ai-notify --tool codex --status <ok|warn|fail> --task "每日 iBigFun 投資房源監測" --title "<short title>" --details-file reports/YYYY-MM-DD.md
```

Future automation should track seen listing IDs using the convention in `docs/automation-state.md`.

## Memory Hygiene

Automation memory is for recent run summaries and short-lived operational notes. If a decision becomes durable, move it into the relevant file under `docs/` instead of relying on memory as a rule source.

## Safety

Do not commit real credentials, cookies, session files, raw browser profiles, automation state, traces, screenshots, downloaded pages, or local output containing secrets.
