# Agent Instructions

This repository is the workspace for monitoring iBigFun investment property listings, preparing daily Markdown reports, and sending concise notifications.

These instructions are shared by Codex and Claude Code. Follow them before making changes or producing reports.

## Project Context

- Main project notes live in `README.md`.
- Credential handling rules live in `docs/credentials.md`.
- Investment criteria, sorting, and notification rules live in `docs/reporting-rules.md`.
- Notification structure lives in `templates/daily-notify-template.md`.
- Generated local reports belong under `reports/` and are ignored by git.

## Safety Rules

- Never commit real credentials, cookies, sessions, browser profiles, screenshots with secrets, or raw local output containing secrets.
- Use `.env.example` as the committed template. The real `.env` file must stay local.
- Do not print `IBIGFUN_ACCOUNT` or `IBIGFUN_PASSWORD` in logs, reports, notifications, screenshots, or debug output.
- If login is blocked by CAPTCHA, 2FA, or account-risk checks, stop and ask for manual confirmation. Do not bypass those controls.

## Daily Report Workflow

1. Gather new iBigFun listings for the target date.
2. Evaluate each listing using `docs/reporting-rules.md`.
3. Write any generated Markdown output under `reports/`.
4. Prepare notifications from `templates/daily-notify-template.md`.
5. Send notifications with `ai-notify --details-file <markdown-file>` only after the report is ready.

## Reporting Rules

- Use Markdown.
- Do not use tables in notifications.
- Put the quick summary before listing details.
- Add a Markdown link to every listing title.
- Keep one notification around 3,500 Chinese characters when possible.
- Compress excluded listings first; preserve core numbers for recommended and near-threshold listings.
- Sort recommended listings by discount percentage, highest first.
- Sort near-threshold listings by rent coverage, highest first.
- Sort excluded listings by rent coverage, discount percentage, then lower total price.

## Investment Criteria

- Mortgage assumption: 80% loan-to-value, 2.6% annual interest, 30-year principal and interest repayment.
- Recommended listing: below market by at least 10% and rent coverage at least 1.0.
- Near-threshold listing: rent coverage at least 0.8.

Always call out manual checks for achievable rent, vacancy, property condition, leaks, roof waterproofing, repair cost, loan terms, illegal additions, title issues, zoning/use issues, and comparable transaction quality.

## Collaboration Guidelines

- Prefer small, focused changes that match the existing repository structure.
- Read the relevant docs before changing report logic, templates, or workflow instructions.
- Keep generated reports out of git unless the user explicitly asks otherwise.
- When adding automation code later, load credentials from environment variables rather than hard-coding values.
- Before finishing code changes, run the smallest relevant verification available and report what was checked.
