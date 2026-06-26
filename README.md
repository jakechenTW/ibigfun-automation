# iBigFun Automation

Project workspace for monitoring iBigFun investment property listings, preparing daily Markdown reports, and sending concise notifications.

## Structure

- `docs/`: operating notes, credential handling, and reporting rules.
- `templates/`: reusable notification templates.
- `reports/`: local generated notification/report files; ignored by git.

## Credentials

Use a dedicated automation account. Copy `.env.example` to `.env` and fill it locally. Do not commit `.env`.

See `docs/credentials.md` for details.

## Daily Report Workflow

1. Gather new iBigFun listings for the target date.
2. Evaluate each listing with the rules in `docs/reporting-rules.md`.
3. Write local notification/report output under `reports/` when needed.
4. Use `templates/daily-notify-template.md` when preparing text for `ai-notify`.

## Safety

Do not commit real credentials, cookies, session files, raw browser profiles, or local output containing secrets.
