# Fetching iBigFun Listings

How to retrieve the target date's listings for the daily report. This is the
mechanics referenced by step 3 and step 5 of the run sequence in `AGENTS.md`.

## Fetch Architecture (Browserless API)

The fetch is browserless: pure Node `fetch`, no Playwright/Chromium. Login is a
form POST; the session is held in a cookie jar. Two JSON endpoints back the
flow.

### Login

POST `https://www.ibigfun.com/user/login` with
`content-type: application/x-www-form-urlencoded` body:

```
mobile=<IBIGFUN_ACCOUNT>&password=<IBIGFUN_PASSWORD>
```

No CSRF token is required. On success the response sets an `ibigfun_session`
cookie. The cookie jar is persisted to `.cookies.json` (git-ignored) and reused
on subsequent runs. If the login response does not set `ibigfun_session`, or if
the run detects CAPTCHA / 2FA / account-risk signals, the run raises
`BlockedError` and stops immediately — it never bypasses those controls.

See `docs/credentials.md` for credential storage and the `BlockedError` rule.

### Single-session account (auto re-login)

iBigFun allows only one active login per account, and automation shares the
user's account. If the user logs in elsewhere the scraper's cookie is kicked. On
a kicked session the API call returns a redirect/auth error; the scraper
**auto re-logins** and retries, which logs the user's other browser session out
(an accepted trade-off for unattended robustness). Recovery is bounded
(`MAX_RELOGIN`); a contested account eventually exits with a login-failure error.
CAPTCHA / 2FA / risk / missing creds still hard-stop. See `scripts/lib/http.ts`.

### Endpoint 1 — listing table

```
POST https://www.ibigfun.com/api/search/list
```

Headers: `x-requested-with: XMLHttpRequest`, `content-type: application/x-www-form-urlencoded`, `accept: application/json`, plus the session cookie.

Body (filter + source allow-list, captured 2026-06-27):

```
page=<n>
expand=0
method=all_case
on_market=1
city=1
price_segment[max_val]=2500
floor_segment[min_val]=2
floor_segment[max_val]=4
total_floor[max_val]=5
add_date=<YYYY-MM-DD>
add_date_max=<YYYY-MM-DD>
source_web[]=370
source_web[]=462
source_web[]=371
source[]=372
source[]=373
source[]=592
source[]=382
source[]=383
source[]=384
source[]=465
source[]=381
source[]=380
source[]=374
source[]=375
source[]=376
source[]=377
source[]=378
source[]=379
source[]=463
source[]=464
source[]=478
source[]=579
source[]=590
exclude_land=1
```

Response JSON shape: `{ data: ListItem[], total_records: number, per_page: number, current_page: number }`.

### Endpoint 2 — listing history (刊登紀錄)

```
GET https://api.ibigfun.com/on-market/o2o-same?ids=<id,id,...>
```

Pass the `id` field from the listing table results (batch multiple ids in one
call). Response shape: `data[listingId][sourceName] = { source_id, link, total, add_date }`.

**History fidelity note (confirmed live 2026-06-27):** o2o-same returns only
currently-active cross-source records; 下架 (delisted) rows are not represented.
Every `listingHistory` entry is therefore `active: true`. This is harmless for
`tenure.firstListedDate` (the earliest `add_date` is still the earliest known
date) but means `recordCount` reflects only currently-listed sources, not all
historical sources.

### Pagination

Fetch pages 1, 2, … until `(current_page − 1) * per_page + data.length >= total_records`. The per-page count is fixed at 20 per the API response.

### Re-confirming the request shape

If the filter or source allow-list appears stale (unexpected empty results or a
changed field set), re-confirm by opening the authenticated listing view in a
real browser, opening Network devtools, and capturing the XHR POST to
`/api/search/list`. Update the allow-list in `scripts/lib/config.ts` and record
the re-capture date here. This is a devtools capture step, not a DOM-selector
inspection.

## Field Mapping (API → Listing)

The API returns camelCase/snake_case fields; these map to the normalized `Listing` type:

| API field | Listing field | Notes |
|---|---|---|
| `id` | `id` | String (coerce from number if needed) |
| `source` | `source` | String (coerce from number if needed) |
| `subject` | `title` | |
| `link` | `url`, `sourceLink` | Canonical URL — may point to 591, rakuya, etc. (see source model in `AGENTS.md`) |
| `address` | `addressOrArea` | |
| `mrt` | `nearbyStation` | |
| `lat`, `lng` | `coordinate` | Direct from API — no Maps-URL regex needed |
| `add_time` | `publishedDate` | Date only: first 10 chars (`YYYY-MM-DD`) |
| `total` | `totalPrice` | |
| `price_ave` | `unitPrice` | |
| `total_ping` | `totalPing` | |
| `floor` | `floor` | |
| `total_floor` | `totalFloors` | |
| `pattern` | `typeLayout` | |
| `house_age_x` | `age` | |
| `parking_type` | `parking` | |
| `room` | `room` | |
| `living_room` | `livingRoom` | |
| `bathroom` | `bathroom` | |
| — | `realPriceUrl` | Always `null` — the API does not expose it |
| o2o-same response | `listingHistory` | Each entry: `{ date, source, price, active: true }` (see history-fidelity note above) — used by enrich to compute how long the property has been on market |

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

The committed fetch script is browserless: it logs in via form POST, calls the
two JSON APIs, paginates, normalizes each listing per the field-mapping table
above, and writes to `state/listings-<date>.json` and stdout. It does **fetch +
normalize only** — MRT distance, estimation, and evaluation stay with the
report step.

### One-time setup

```bash
npm install   # toolchain (tsx, TypeScript — no Chromium needed)
```

### Run

```bash
npm run fetch -- --date 2026-06-26   # explicit target date
npm run fetch                        # defaults to the previous Taipei day
```

Exit codes: `0` ok, `1` unexpected error, `2` blocked (`BlockedError` — login
gate, CAPTCHA, 2FA, or bad input; needs a human).

The `.gitignore` covers the cookie jar and output artifacts (`.cookies.json`,
`state/`, `*.har`, `node_modules/`).
