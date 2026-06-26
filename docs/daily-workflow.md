# Daily iBigFun Workflow

This file is the source of truth for the daily monitoring procedure. Keep durable rules here and in the referenced docs; keep automation memory limited to recent run history, operational decisions, and one-off findings.

## Source Of Truth Map

- `AGENTS.md`: shared agent entrypoint, safety rules, and where to find durable instructions.
- `docs/daily-workflow.md`: daily run sequence and notification route.
- `docs/credentials.md`: credential storage and login handling.
- `docs/reporting-rules.md`: investment criteria, calculations, sorting, data quality, and notification format.
- `docs/automation-state.md`: durable state and deduplication conventions.
- `templates/daily-notify-template.md`: Markdown report/notification structure.
- Automation memory: recent run summaries, temporary operational notes, and decisions not yet promoted into repository docs.

## Daily Run Sequence

1. Read `AGENTS.md`, this workflow, `docs/credentials.md`, `docs/reporting-rules.md`, and `docs/automation-state.md` before generating a report or changing workflow behavior.
2. Determine the report target date with the rule in "Report Date".
3. Open the iBigFun latest-sale URL in the in-app browser with the active filters and an explicit target date range.

Base URL:

```text
https://www.ibigfun.com/lists/latest?page=1&expand=0&method=all_case&on_market=1&city=1&price_segment=%2C2500&floor_segment=2%2C4&total_floor=%2C5
```

Add these date parameters for the target date:

   - `add_date=YYYY-MM-DD`
   - `add_date_max=YYYY-MM-DD`
4. If iBigFun redirects to `/user/signin`, follow `docs/credentials.md` to log in from the project-local `.env` credentials. Stop if CAPTCHA, 2FA, account-risk checks, missing credentials, or repeated login failure occurs.
5. Confirm the page displays the expected target date and collect all result pages for that date.
6. Deduplicate listings using stable listing IDs and the convention in `docs/automation-state.md`.
7. Normalize each listing with at least: title, URL, address/area, address coordinate from the iBigFun Google Maps link when available, published date, total price, total ping, unit price, floor/total floors, type/layout, age, parking, and iBigFun real-price URL when available.
8. For listings with a credible address coordinate, calculate the nearest active MRT exit using `data/taipei_mrt_exits.csv`. Keep the nearest station, exit ID, straight-line distance, and whether the result is a 700-900m manual walking-distance boundary case. If a walking-time estimate is needed, call OpenStreetMap foot routing only for the nearest exit.
9. Evaluate listings with `docs/reporting-rules.md`.
10. Write the detailed Markdown report under `reports/YYYY-MM-DD.md`, using the target date in the filename and `templates/daily-notify-template.md` as the structure guide.
11. Send the completed report with:

```bash
ai-notify --tool codex --status <ok|warn|fail> --task "每日 iBigFun 投資房源監測" --title "<short title>" --details-file reports/YYYY-MM-DD.md
```

Use `warn` when there are recommendations, near-threshold candidates, stale/weak market data, login fallback, or other items needing review. Use `ok` for a clean no-recommendation run with fresh data. Use `fail` only when the monitor cannot complete.

## Report Date

Default recurring runs report on the previous calendar day in the `Asia/Taipei` timezone, not the run date. This avoids producing an incomplete same-day report before the listing day has finished.

For example, a run on `2026-06-27` Asia/Taipei should use target date `2026-06-26`, set both `add_date` and `add_date_max` to `2026-06-26`, write `reports/2026-06-26.md`, and title the report for `2026-06-26`.

Only use the run date itself when the user explicitly asks for a same-day or intraday check. Mark such output clearly as incomplete/intraday.

## Notification Route

Use `ai-notify --details-file <markdown-file>` for this automation.

## Report Storage

Generated reports belong under `reports/` and are ignored by git. Do not commit generated daily reports unless the user explicitly asks.

## Memory Hygiene

Automation memory should not become a second rulebook. When an operational decision becomes durable, move it into the appropriate repository doc and leave only a short note in memory that the repo docs are now authoritative.
