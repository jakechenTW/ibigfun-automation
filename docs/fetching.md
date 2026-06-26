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

## Future: Replace Manual Fetch With A Script

A committed `scripts/fetch.ts` (Playwright) should eventually log in with the
`.env` credentials and write the day's listings to JSON, replacing the manual
browser steps. The `.gitignore` already covers Playwright artifacts
(`storageState.json`, `*.har`, traces, `playwright-report/`, etc.). Until that
exists, use the browser method above.
