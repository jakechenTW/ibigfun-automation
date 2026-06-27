# Fetching iBigFun Listings

How to retrieve the target date's listings for the daily report. This is the
mechanics behind the fetch step in `AGENTS.md`; enrichment, routing triage, and
profile evaluation are documented separately.

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

Headers: `x-requested-with: XMLHttpRequest`, `content-type: application/x-www-form-urlencoded`, `accept: application/json, text/javascript, */*; q=0.01`, plus the session cookie.

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

(The request also sends empty `price_segment[min_val]=` and `total_floor[min_val]=` params.)

The fetch body is profile-aware. With no profile filters (or a profile whose
`fetchFilters.enabled` is `false`) the captured investment shape above is sent.
When a profile has `fetchFilters.enabled: true`, `buildSearchBody` emits that
profile's filters instead: `city`, `town[]`, `house_type[]`,
`price_segment[max_val]`, `floor_segment[min_val]` (no max), `main_ping_number[min_val]`,
`house_age_segment[max_val]`, and `parking` (the `total_floor` cap and the
investment `floor 2–4` window are omitted). The `method`, `on_market`, `expand`,
`exclude_land`, and `source_web[]`/`source[]` allow-list are shared by both shapes.
`owner-occupied` enabled its filters on 2026-06-27; its town, floor, age,
parking, and price filters were verified against a live fetch, and its coded
ids were resolved (town 1/4/6/8/9→中正/中山/大安/信義/士林,
`house_type=17`→電梯大樓 from the filter UI). See
`data/ibigfun-filter-mappings.md` for the id→name reference.

`main_ping_number` and `house_type` are server-side filters only:
`/api/search/list` returns `total_ping` (not 主建物 ping) and `typeLayout`
(room layout, not a building-type category), so neither constraint can be
re-verified per-result from the response — they are trusted server-side.

Response JSON shape: `{ data: ListItem[], total_records: number, per_page: number, current_page: number }`.

### Listing history (刊登紀錄)

History is fetched per listing from the two endpoints the live site uses:

- On-market: `GET https://api.ibigfun.com/on-market/{id}/history` — `{id}` is the
  numeric listing id from `search/list`. Returns `{ status, data: [{ source,
  source_id, total (number), subject, add_time, link }] }`, the cross-source
  posting list (each `add_time` is that source's listing date).
- Off-market (下架): `POST https://www.ibigfun.com/api/query_off_market_by_id`
  with form body `id_encode=<uuid>` (the `uuid` from `search/list`, NOT the
  numeric id). Returns `{ status, msg, total_records, data: [{ source, total
  (comma string), add_time, … }] }` — delisted postings (UI shows the latest 10).

On-market rows map to `active: true`, off-market rows to `active: false`; they
are merged (dedup key `source|date|active`) into `listingHistory` and feed
`computeTenure`. Calls run through a concurrency pool (`HISTORY_CONCURRENCY`)
with retry + exponential backoff (`HISTORY_RETRIES`, `HISTORY_RETRY_BASE_MS`).

A listing whose history can't be fetched after retries — or whose on-market
history comes back empty for a still-live listing (a sign of throttling) — is
kept with empty history, logged as a `WARN` with its id, and counted in the
end-of-run summary. Never dropped silently.

**Accepted limitation:** under heavy throttle the API can return `200 ok` with
an empty `data` array, which is indistinguishable from a genuinely-empty result
for off-market records (empty is normal there). This is only flagged for
on-market history (empty-when-live → WARN).

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
| `id` | `id` | Number — stable iBigFun listing id; also the o2o-same key |
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
| history + off-market responses | `listingHistory` | Each entry: `{ date, source, price, active }` — used by enrich to compute how long the property has been on market |

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
`docs/reporting-rules.md` plus the selected profile doc for how distance feeds
reporting decisions.

## Automated Fetch (`scripts/fetch.ts`)

The committed fetch script is browserless: it logs in via form POST, calls the
two JSON APIs, paginates, normalizes each listing per the field-mapping table
above, and writes to `state/runs/<profile>/<label>/listings.json` and stdout. It
does **fetch + normalize only**. MRT/walking signals are produced by enrich;
profile-specific estimation and evaluation stay with the report step.

### One-time setup

```bash
npm install   # toolchain (tsx, TypeScript — no Chromium needed)
```

### Run

```bash
npm run fetch -- --profile investment --date 2026-06-26   # explicit target date
npm run fetch -- --profile investment                     # defaults to the previous Taipei day
```

Exit codes: `0` ok, `1` unexpected error, `2` blocked (`BlockedError` — login
gate, CAPTCHA, 2FA, or bad input; needs a human).

The `.gitignore` covers the cookie jar and output artifacts (`.cookies.json`,
`state/`, `*.har`, `node_modules/`).
