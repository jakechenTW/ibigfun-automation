# Agent Instructions

This repository is the workspace for monitoring iBigFun investment property listings, preparing daily Markdown reports, and sending concise notifications.

These instructions are shared by Codex and Claude Code. Follow them before making changes or producing reports.

## Project Context

- Main project notes live in `README.md`.
- Daily workflow rules live in `docs/daily-workflow.md`.
- Credential handling rules live in `docs/credentials.md`.
- Investment criteria, sorting, and notification rules live in `docs/reporting-rules.md`.
- Future durable state rules live in `docs/automation-state.md`.
- Notification structure lives in `templates/daily-notify-template.md`.
- Generated local reports belong under `reports/` and are ignored by git.
- Automation memory is for recent run history and temporary notes only; promote durable rules into the repository docs above.

## Safety Rules

- Never commit real credentials, cookies, sessions, browser profiles, screenshots with secrets, or raw local output containing secrets.
- Never commit local automation state, traces, HAR files, downloaded HTML pages, or browser storage files unless they have been sanitized and the user explicitly asks for them.
- Use `.env.example` as the committed template. The real `.env` file must stay local.
- Do not print `IBIGFUN_ACCOUNT` or `IBIGFUN_PASSWORD` in logs, reports, notifications, screenshots, or debug output.
- If login is blocked by CAPTCHA, 2FA, or account-risk checks, stop and ask for manual confirmation. Do not bypass those controls.

## Daily Report Workflow

Follow `docs/daily-workflow.md`. In short: recurring runs gather the previous calendar day's iBigFun listings in the `Asia/Taipei` timezone, deduplicate by stable listing ID, evaluate with `docs/reporting-rules.md`, write Markdown output under `reports/`, then notify with `ai-notify --details-file <markdown-file>` only after the report is ready.

## Reporting Rules

Use `docs/reporting-rules.md` as the source of truth for investment criteria, calculations, sorting, notification length, and data quality labels.

## Investment Criteria

The active thresholds live in `docs/reporting-rules.md`. Always call out manual checks for achievable rent, vacancy, property condition, leaks, roof waterproofing, repair cost, loan terms, illegal additions, title issues, zoning/use issues, and comparable transaction quality.

## Collaboration Guidelines

- Prefer small, focused changes that match the existing repository structure.
- Read the relevant docs before changing report logic, templates, or workflow instructions.
- Keep generated reports out of git unless the user explicitly asks otherwise.
- When adding automation code later, load credentials from environment variables rather than hard-coding values.
- Before finishing code changes, run the smallest relevant verification available and report what was checked.
