# Agent Instructions (iBigFun Automation)

This repository monitors iBigFun investment property listings, prepares a daily
Markdown report, and sends a concise notification. It is the shared entrypoint
for Codex and Claude Code. Read it top-to-bottom before operating; follow the
linked docs only when you need rule detail.

## What This Is & The Source Model

iBigFun aggregates sale listings that originate on other sites (591, 樂居,
rakuya, etc.). A listing's canonical URL therefore often points to the
originating source rather than `ibigfun.com` — that is expected, not a bug. The
daily job reads iBigFun's filtered latest-sale view for the target date,
evaluates each listing against `docs/reporting-rules.md`, writes a report, and
notifies.

## First Run — Prerequisites

Do these once before the first run; stop and ask the user if any fails:

- [ ] `ai-notify` is on PATH (`which ai-notify`). If missing, stop and ask.
- [ ] `.env` exists and is filled (`cp .env.example .env`; see
  `docs/credentials.md`).
- [ ] A browser tool is available for the fetch step (see `docs/fetching.md`).

## Daily Run Sequence

1. Read this file, `docs/reporting-rules.md`, `docs/credentials.md`, and
   `docs/automation-state.md` before generating a report or changing behavior.
2. Compute the target date: the previous calendar day in `Asia/Taipei` (see
   "Report Date" below). A run on `2026-06-27` targets `2026-06-26`.
3. Fetch the target date's listings → `docs/fetching.md`.
4. Deduplicate by stable listing ID → `docs/automation-state.md`.
5. Normalize each listing's fields and compute the nearest MRT exit →
   `docs/fetching.md`, `data/taipei_mrt_exits.csv`.
6. Estimate market price and rent → `docs/reporting-rules.md`.
7. Evaluate against the investment criteria, exclusions, and sorting →
   `docs/reporting-rules.md`.
8. Write `reports/YYYY-MM-DD.md` (target date in the filename) using
   `templates/daily-notify-template.md` as the structure.
9. Notify with the canonical command below.

### Report Date

Default recurring runs report on the previous calendar day in `Asia/Taipei`, not
the run date — this avoids an incomplete same-day report. Set both `add_date`
and `add_date_max` to the target date, write `reports/<target>.md`, and title the
report for the target date. Only use the run date itself when the user explicitly
asks for a same-day/intraday check, and mark such output as incomplete/intraday.

## Canonical Notification Command

Send the finished report only after it is written. Use this exact command shape:

```bash
ai-notify --tool <codex|claude> --status <ok|warn|fail> \
  --task "每日 iBigFun 投資房源監測" --title "<short title>" \
  --details-file reports/YYYY-MM-DD.md
```

- `--tool`: the agent actually running (`codex` or `claude`).
- `--status warn`: recommendations, near-threshold candidates, stale/weak market
  data, login fallback, or anything needing review.
- `--status ok`: a clean no-recommendation run with fresh data.
- `--status fail`: only when the monitor cannot complete.

## Safety Rules

- Never commit real credentials, cookies, sessions, browser profiles,
  screenshots with secrets, or raw local output containing secrets.
- Never commit local automation state, traces, HAR files, downloaded HTML pages,
  or browser storage files unless sanitized and explicitly requested.
- Use `.env.example` as the committed template; the real `.env` stays local.
- Do not print `IBIGFUN_ACCOUNT` or `IBIGFUN_PASSWORD` in logs, reports,
  notifications, screenshots, or debug output.
- If login is blocked by CAPTCHA, 2FA, or account-risk checks, stop and ask for
  manual confirmation. Do not bypass those controls.
- Generated reports under `reports/` and local state under `state/` are
  git-ignored. Do not commit them unless the user explicitly asks.

## Source-Of-Truth Map

- `AGENTS.md` (this file): entrypoint, run sequence, safety, notification
  command, source-of-truth map.
- `docs/fetching.md`: how to fetch listings, fields to extract, MRT distance.
- `docs/credentials.md`: credential storage and login secrets handling.
- `docs/reporting-rules.md`: investment criteria, calculations, estimation,
  data quality, sorting, and notification format.
- `docs/automation-state.md`: durable state and deduplication conventions.
- `templates/daily-notify-template.md`: report/notification structure.
- `data/README.md`: MRT reference dataset and distance rules.
- Automation memory: recent run summaries and short-lived notes only. When a
  decision becomes durable, promote it into the relevant doc above.
