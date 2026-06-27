# Design: Browserless API-based fetch

**Date:** 2026-06-27
**Branch / worktree:** `feat/api-browserless-fetch` (worktree off `main`)
**Status:** Approved design, pending implementation plan

## Problem

The fetch step (`scripts/lib/extract.ts`) scrapes iBigFun's filtered latest-sale
view by driving a Playwright/Chromium browser, waiting for the SPA to render, and
parsing the rendered HTML: positional `<td>` indices (`td[1]`=date, `td[2]`=price,
…), `innerText` splitting, a Google-Maps-URL coordinate regex, and a fragile walk
over a sibling `table.sub-table` for 刊登紀錄. Any markup change on iBigFun breaks
extraction. The goal: replace HTML-structure dependence with iBigFun's own JSON
APIs, and — as confirmed during discovery — do it **without a browser at all**.

## Discovery (network capture, 2026-06-27)

Three throwaway spikes (against the live authenticated site) established the
following. Captured fixtures live in the session scratchpad
(`search-list.json`, `o2o-same.json`, `login-events.json`).

### Two JSON APIs back the listing view

1. **`POST https://www.ibigfun.com/api/search/list`** — the listing table.
   - Request: `application/x-www-form-urlencoded` body mirroring the documented
     filters, plus a fixed `source_web[]` / `source[]` allow-list and
     `exclude_land=1`. Headers: `x-requested-with: XMLHttpRequest`,
     `accept: application/json`. Auth via cookies.
   - Response: `{ data[], total_records, per_page, current_page, status, msg }`.
     20 items/page; `total_records`/`per_page` give exact page count (no more
     "loop until a page looks empty"). `status: "ok"` on success.
   - Every currently-scraped field is present as typed JSON (see mapping below),
     including `lat`/`lng` directly (no Maps-URL regex).

2. **`GET https://api.ibigfun.com/on-market/o2o-same?ids=<id,id,…>`** — the
   cross-source 刊登紀錄 history, keyed by listing id.
   - Response: `{ status, data: { <listingId>: { <sourceName>: { source_id,
     link, total, add_date } } } }`. One entry per source (591, 好房網, 信義,
     永慶, 樂屋網, …) with price (`total`) and `add_date`. The earliest `add_date`
     across sources is the true first-listed date for days-on-market.

### Login is a trivial form POST (no browser needed)

- `GET /user/signin` primes `ibigfun_session` + `api_token` cookies. The signin
  form has **no CSRF token** (only empty `request_uri` / `return_url` hidden
  fields).
- `POST https://www.ibigfun.com/user/login` with
  `mobile=<account>&password=<password>&return_url=` returns `302` → the session
  cookie `ibigfun_session` (httpOnly) is set. No captcha/2FA seen.
- The data APIs then need only those cookies + `x-requested-with` + the form body.

### Browserless proven end-to-end

A pure Node `fetch` spike (zero Playwright/Chromium) completed the full flow:
`GET /user/signin` → `POST /user/login` (302) → `POST /api/search/list` (200,
78 records, 20/page) → `GET o2o-same` (200, history for 20 ids). Verdict: works.

### Anti-bot note

The site posts a New Relic beacon `{"ja":{"webdriverDetected":true}}` and flags
the headless browser, but **login succeeds anyway** — it is monitoring, not a
gate. A pure-`fetch` client runs no page JS, so it emits no such beacon. No
captcha appeared. This is a risk to watch, not a present blocker.

## Decisions

- **Architecture:** fully browserless, pure Node `fetch`. (Chosen over the hybrid
  "browser-for-login" option after the browserless spike proved login is a plain
  form POST.)
- **Remove Playwright entirely** — it is used only by `session.ts` and
  `extract.ts`, both replaced here.
- **Output:** drop-in `Listing` (downstream `enrich`/report/tests unchanged) plus
  a few high-value new fields now available from the API.
- **`tenure.ts` is untouched** — it keeps consuming `ListingHistoryEntry[]`.
- **Worktree off `main`** (tenure feature already merged into `main` at
  `b93fa3b`, so no cross-branch sequencing needed).

## Architecture

Three new small modules replace the Playwright scraper; `extract.ts` keeps the
public `collectListings()` signature so `fetch.ts` barely changes.

- **`scripts/lib/http.ts`** — HTTP/session layer:
  - Minimal cookie jar (parse via `Headers.getSetCookie()`; emit `Cookie`).
  - `login()`: `GET /user/signin` (prime cookies; scan page text for
    `BLOCKING_SIGNALS` → `BlockedError`), `POST /user/login` with `.env`
    credentials, verify `ibigfun_session` is present (else `BlockedError`).
  - Jar persistence to a gitignored file (replaces `storageState.json`), so a
    valid session is reused between runs.
  - A small authed-request helper that detects a kick (`302`→signin / signin
    body / non-`ok`) and surfaces it to the relogin loop.
- **`scripts/lib/api.ts`** — typed API calls + response types:
  - `fetchListPage(date, page)` → `/api/search/list`. Owns the POST body builder,
    including the fixed `source[]`/`source_web[]`/`exclude_land` allow-list,
    documented with a "captured 2026-06-27" note (as selectors are today).
  - `fetchHistory(ids[])` → `o2o-same`.
- **`scripts/lib/map.ts`** — pure mapping: `apiItemToListing(item, historyForId)`
  → `Listing`. Unit-tested against the captured fixtures.

`extract.ts` (`collectListings`): ensure session → loop exact pages from
`total_records`/`per_page` → batch `fetchHistory` for the page's ids → map →
collect. Same return type as today.

**Relogin-on-kick** reuses the existing pure `relogin.ts` (`openWithRelogin`) —
its `navigate`/`login`/`isSignin` effects are wired to `fetch` instead of
Playwright. iBigFun's single-active-login still evicts us mid-run; we re-login and
retry, up to the existing cap.

## Field mapping (`/api/search/list` item → `Listing`)

| `Listing` field | API source | Note |
|---|---|---|
| `title` | `subject` | |
| `url` | `link` | source-origin URL (unchanged semantics) |
| `addressOrArea` | `address` | |
| `nearbyStation` | `mrt` | e.g. `"植物園站(施工中)"` |
| `coordinate` | `{lat, lng}` | direct; no Maps-URL regex |
| `publishedDate` | `add_time` | `"YYYY-MM-DD HH:mm:ss"` (kept as display text) |
| `totalPrice` | `total` | numeric; rendered to string to preserve `Listing` shape |
| `unitPrice` | `price_ave` | |
| `totalPing` | `total_ping` | |
| `floor` / `totalFloors` | `floor` / `total_floor` | |
| `typeLayout` | `pattern` | e.g. `"3房2廳1衛"` |
| `age` | `house_age_x` | |
| `parking` | `parking_type` | |
| `realPriceUrl` | derived from `id_encode` / `uuid` | not a direct field; iBigFun builds the realprice URL client-side. Plan captures the exact URL pattern from one live listing and builds it; `null` if not reconstructable. |
| `listingHistory` | from `o2o-same` (see below) | |

### New fields added to `Listing` (additive; downstream stays valid)

| New field | API source |
|---|---|
| `id` | `id` (stable iBigFun id; also the o2o-same key) |
| `source` | `source` (origin platform, e.g. `"樂屋"`) |
| `sourceLink` | `link` |
| `room` / `livingRoom` / `bathroom` | `room` / `living_room` / `bathroom` |

### History mapping (`o2o-same` → `ListingHistoryEntry[]`)

For each `data[id][sourceName] = { total, add_date, link, source_id }`, emit
`{ date: add_date, source: sourceName, price: String(total), active: true }`,
then pass through the existing `normalizeHistory()` (date validation/trim). No
change to `tenure.ts`.

**Fidelity caveat ⚠️** The HTML sub-table marked `active` (下架 vs on-market) via
a link cell; o2o-same has no delisted flag, so every entry maps `active: true`
and any 下架-only rows are not represented. Harmless for `tenure.firstListedDate`
(earliest date is still earliest); shifts `recordCount`/`active` semantics. The
plan must verify against a listing known to have 下架 history and decide whether
to keep `active` in the type or document the behavior change.

## Error handling & AGENTS.md compliance

- API non-`200` or `status !== "ok"` → typed error (fail loud, as today).
- Kick mid-run (`302`→signin / signin body) → `relogin.ts` loop re-logins + retries.
- CAPTCHA / 2FA / risk text on signin, or login yielding no `ibigfun_session`
  → `BlockedError`; the run stops and asks for manual handling. We submit real
  credentials to the real login endpoint — we do **not** bypass any control
  (AGENTS.md Safety Rules).
- Cookie-jar file is gitignored; credentials never logged (AGENTS.md).

## Removed

- `playwright` dependency and the `npx playwright install chromium` prerequisite.
- `scripts/lib/session.ts` (browser session/login).
- DOM selectors + `td` indices in `scripts/lib/config.ts` (keep
  `SIGNIN_PATH_FRAGMENT`, `BLOCKING_SIGNALS`; rename/repurpose the storage-path
  constant for the cookie jar).
- `scripts/lib/coords.ts` Maps-URL parser becomes dead (we read `lat`/`lng`).
  Remove only what is genuinely unused after the cutover.

## Testing

- `map.test.ts` — API item + o2o-same fixtures → expected `Listing`, including a
  real `daysOnMarket` derived from o2o-same dates end-to-end with `tenure.ts`.
- `api.test.ts` — POST body builder produces the captured param set; response
  type parsing.
- `http.test.ts` — cookie-jar parse/emit; relogin wiring stays covered by the
  existing `relogin.test.ts`.
- One thin live smoke check (manual / opt-in), not in `npm test`.
- Net effect: extraction logic becomes testable offline, with no browser.

## Docs to update

- `AGENTS.md` — First-Run prereqs (drop chromium install), Tooling description
  (no longer "Playwright scraper").
- `docs/fetching.md` — rewrite for the API flow + the documented filter/source
  param set and capture date.
- `docs/credentials.md` — note the cookie-jar file (gitignored) replacing
  `storageState.json`.

## Risks

- **Anti-bot / risk engine.** No browser fingerprint; the site monitors but does
  not gate today. If risk controls appear later, the run fails loud (no bypass).
- **Fixed `source[]` allow-list.** Hardcoded from capture; if iBigFun changes the
  source set, results may narrow. Mitigated by documenting it with a capture date,
  like the selectors today.
- **Header/UA sensitivity.** Send a realistic `User-Agent` + `x-requested-with`;
  the proven request set is the baseline.

## Out of scope

- Changes to `enrich`/report/notify logic or estimation.
- Adopting iBigFun's own `downday`/`first_sold` signals (redundant with `tenure`;
  revisit later if wanted).
- Any attempt to defeat or evade anti-bot controls.
