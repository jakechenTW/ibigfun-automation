# Fetching iBigFun Listings

How to retrieve the target date's listings for the daily report. This is the
mechanics referenced by step 3 and step 5 of the run sequence in `AGENTS.md`.

## Why Browser-First, Not Plain Fetch

The iBigFun listing pages redirect unauthenticated requests to `/user/signin`
(login-gated) and render results with client-side JavaScript. Plain HTTP
fetching returns the login wall or empty HTML, so it is not reliable. Drive a
real browser session instead.

## Primary Method (Browser Tool)

1. Build the filtered target-date URL. Base URL:

   ```text
   https://www.ibigfun.com/lists/latest?page=1&expand=0&method=all_case&on_market=1&city=1&price_segment=%2C2500&floor_segment=2%2C4&total_floor=%2C5
   ```

   Add the target-date parameters (same date for both, computed per the
   "Report Date" rule in `AGENTS.md`):

   - `add_date=YYYY-MM-DD`
   - `add_date_max=YYYY-MM-DD`

2. Open the URL in the browser tool.
3. If the browser redirects to `/user/signin`, log in with the project-local
   `.env` credentials (`IBIGFUN_ACCOUNT`, `IBIGFUN_PASSWORD`; see
   `docs/credentials.md`). Fill the **visible** login fields only — the page
   contains duplicate hidden login inputs, so do not match by duplicate IDs
   alone. Never print, log, screenshot, or store either credential value.
4. After login, reopen the filtered target-date URL.
5. Confirm the page shows the expected target date, then collect all result
   pages for that date.
6. If login is blocked by CAPTCHA, 2FA, account-risk checks, missing
   credentials, or repeated failure, stop and ask for manual confirmation. Do
   not attempt to bypass those controls.

### Single-session account (auto re-login)

iBigFun allows only one active login per account, and automation shares the
user's account. If the user logs in elsewhere, the scraper's session is kicked
and a page load bounces to `/user/signin`. The scraper **auto re-logins** and
retries the page — on the first page or a mid-run kick during pagination —
which logs the user's other browser session out (an accepted trade-off for
unattended robustness). Recovery is bounded (`MAX_RELOGIN`); a contested account
eventually fails with "Repeated signin redirects" (exit 2). CAPTCHA / 2FA /
risk / missing creds still hard-stop. See `scripts/lib/relogin.ts`.

## Fields To Extract Per Listing

Normalize each listing with at least:

- title
- URL (canonical listing URL — may point to the originating source such as 591
  or rakuya; see the source model note in `AGENTS.md`)
- address / area
- address coordinate from the iBigFun Google Maps link when available
- published date
- total price
- total ping
- unit price
- floor / total floors
- type / layout
- age
- parking
- iBigFun real-price (實價登錄) URL when available
- listing history (刊登紀錄): the inline `table.sub-table` rows for the listing —
  each as `{ date, source, price, active }` (active=false for `(下架)` records),
  used by enrich to compute how long the property has been on market

## MRT Distance

For listings with a credible address coordinate:

- Compute straight-line distance with the **haversine formula** from the listing
  coordinate to every exit in `data/taipei_mrt_exits.csv`, and pick the nearest
  exit. Keep the nearest station, exit ID, and distance.
- Treat a straight-line distance of 700–900 m as a manual walking-distance
  boundary case. Straight-line distance is not walking distance.
- When a walking-time estimate is needed, call OpenStreetMap foot routing only
  for the single nearest exit, not every exit.

See `data/README.md` for the dataset columns and the full distance rules, and
`docs/reporting-rules.md` for how distance feeds the hard-exclusion rule.

## Automated Fetch (`scripts/fetch.ts`)

A committed Playwright scraper automates the manual flow above: it builds the
filtered target-date URL, reuses a saved session (or logs in with the `.env`
credentials, visible fields only), paginates, and writes the normalized
listings to `state/listings-<date>.json` and stdout. It does **fetch +
normalize only** — MRT distance, estimation, and evaluation stay with the
report step.

### One-time setup

```bash
npm install                      # toolchain (tsx, Playwright, TypeScript)
npx playwright install chromium  # browser binary (skipped by the bare install)
```

### Run

```bash
npm run fetch -- --date 2026-06-26   # explicit target date
npm run fetch                        # defaults to the previous Taipei day
```

Exit codes: `0` ok, `1` unexpected error, `2` blocked (login gate or bad input;
needs a human — the scraper never bypasses CAPTCHA/2FA/risk controls).

### Selectors (verified) and how to re-verify

The selectors in `scripts/lib/config.ts` were confirmed against the live
authenticated DOM on 2026-06-27, and `SELECTORS_VERIFIED` is `true`. The
listing view is one table (`#results table.ttable`) whose rows are listings;
most fields are positional `<td>`s with two `<br>`-separated lines, so
`extract.ts` reads cells by index. Login fields are duplicated (hidden +
visible) under the same ids, so the login selectors use `:visible` and the form
is submitted with Enter (no clickable submit button).

If iBigFun changes its markup (empty or wrong results), re-verify: open the
filtered URL with real credentials, inspect the row/cell structure, update the
selectors and `td` indices in `config.ts`, and re-run. The pure
date/URL/coordinate/floor logic is covered by `npm test`; only the selectors
need live confirmation.

Run with a visible, slowed-down browser to watch the flow while confirming
selectors:

```bash
HEADED=1 npm run fetch -- --date 2026-06-26
```

`npx playwright codegen <filtered-url>` is the easiest way to pick selectors
interactively (log in manually, then click elements to get their selectors).

The `.gitignore` covers the generated session and artifacts (`storageState.json`,
`state/`, `*.har`, traces, `playwright-report/`, `node_modules/`).
