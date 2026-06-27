# Reporting Rules

## Profile Rules

Shared rules live in this file. Profile-specific decision thresholds live in:

- `docs/profiles/investment.md`
- `docs/profiles/owner-occupied.md`

## Investment Criteria

Investment-specific thresholds and estimation rules are owned by
`docs/profiles/investment.md`.

## Walking-Distance Signals

The enrich step produces reusable walking-distance signals. Profiles decide how
to consume them; this shared file does not define a universal MRT hard
exclusion.

- `withinWalk === true`: the route to the nearest active MRT exit is reliable
  and within a 10-minute walk.
- `withinWalk === false`: the route is reliable and over a 10-minute walk.
- `withinWalk === null`: the coordinate or route is unreliable, missing, or
  ambiguous; never auto-exclude from this value alone.
- Use `data/taipei_mrt_exits.csv` as the active MRT reference data. Enrich
  computes straight-line distance from the listing coordinate to every active
  MRT exit, chooses the nearest exit, and routes walking distance for that exit.
- Straight-line distance is a screening signal only. Treat 700-900 m straight
  line as a boundary range that needs walking-distance confirmation.
- Construction or planned stations may be noted as future-upside context when
  reliable coordinates are available, but they do not replace active MRT exits
  for `withinWalk`.
- Retired or canceled stations must not be used for walk signals or
  future-upside notes.

## Calculations

- Market discount percentage must use: `(market_unit_price - listing_unit_price) / market_unit_price * 100`.
- A positive discount means the listing is below estimated market price.
- A negative discount means the listing is above estimated market price.
- A listing satisfies `below market by at least 10%` only when discount percentage is `>= 10`.
- Rent coverage must use: `estimated_monthly_rent / monthly_mortgage_payment`.
- Monthly mortgage payment must use total price, 80% loan-to-value, 2.6% annual interest, and 30-year principal and interest repayment.

## Market Price & Rent Estimation

For the investment profile, these are the inputs to the discount and
rent-coverage calculations above. Document the source used for each, as required
by the data-quality rules below. Profiles that do not use market/rent estimates
should still document their profile-specific judgment source and confidence in
their profile report notes.

### Market Price (推估區域行情)

Use this precedence:

1. iBigFun's own real-price / 實價登錄 link for the listing, when available.
2. Otherwise, agent-gathered comparable transactions matched on area, age,
   floor, and property type.
3. If only stale, weak, timed-out, or cross-site data is available, the listing
   **cannot be labeled `recommended`**. Route it to near-threshold or excluded
   and flag it for manual confirmation.

### Rent (預估月租金)

Estimate from comparable rental listings for the same area and property type.
Always flag the rent figure as needing manual confirmation of the actual
achievable rent and expected vacancy.

### Source Visibility

Keep the source used for each market and rent estimate visible in that
listing's notes.

## Manual Checks

- Actual achievable rent and expected vacancy period.
- Property condition, leaks, roof waterproofing, and repair cost.
- Loan-to-value, bank appraisal, and interest-rate terms.
- Illegal additions, rooftop additions, title issues, or zoning/use issues.
- Whether comparable transaction data is close enough by area, age, floor, and property type.

## Data Quality Rules

- Prefer fresh iBigFun listing and real-price data from the target report date.
- If market data is stale, cached, timed out, or sourced from another site, say so in the quick summary and the affected listing notes.
- Do not label a listing as recommended when its market comparison depends only on stale, timed-out, or weak comparable data. Put it in near-threshold or excluded status and mark it for manual confirmation.
- Keep the source used for each market estimate visible in the listing notes.
- Track seen listing IDs using `docs/automation-state.md` so reposts, edited listings, and cross-day duplicates can be handled consistently.

## Walking-Distance Triage (Agent)

When `scripts/enrich.ts` cannot trust the walking-distance result it sets
`withinWalk: null` with a `reliability.reason`. Before sending these to human
manual review, the agent does a first-pass triage. The deterministic distance
math stays with the tooling — the agent only fixes the *location* and reads the
signals; it never overrides a reliable `withinWalk`.

Inputs the agent has per listing: `addressOrArea`, `nearbyStation` (the station
text the listing itself shows), `reliability.reason`, `district`, and the
`coordinate`. The `npm run route -- --lat <> --lng <>` tool returns the
deterministic nearest-walk exit for any coordinate (shared ORS cache).

By reason:

- `coordinate inconsistent with district` / `no coordinate`: the pin is
  unreliable but the text address usually is not. Re-locate from the address
  (cross-check `nearbyStation`), then run `route` for a deterministic walking
  distance and decide `withinWalk`. Note "location from address, not listing
  pin". If `nearbyStation` and the address disagree (e.g. a 中正區 address
  claiming 信義安和站), treat it as a genuine data conflict — resolve only if
  confident, else `unknown`.
- `route ratio implausible`: the coordinate may be fine but the path detours
  (river/lake/hillside). Cross-check `nearbyStation`; you may accept "near but
  awkward walk" with low confidence, or defer.
- `routing unavailable`: not a data problem — re-run enrich later (transient).

Output a three-state verdict, recorded in the report with rationale, confidence,
and the location source: `likely-within`, `likely-far`, or `unknown` (→ human).

Guardrails: triage verdicts are agent judgment, clearly labelled and overridable;
default to `unknown` when genuinely ambiguous. Never present a triage verdict as
the deterministic `withinWalk`, and never silently exclude on unreliable data.

## Quality / Suspicious-Listing Judgment (Agent)

Auction/foreclosure detection is no longer a hardcoded keyword auto-exclusion.
The keyword check now only sets the advisory `signals.auctionKeyword` flag on
each enriched listing; the agent makes the final call as part of a broader
"low-info / suspicious listing" judgment. Foreclosure is one case under this.

### Suspicious signals (weigh together; none convicts on its own)

- `signals.auctionKeyword === true` — title contains 法拍 / 銀拍 / 金拍 /
  法院拍賣 / 拍賣 / 投標 / 應買.
- No interior photos, or only exterior / map / floor-plan images.
- Sparse information: very short description, many key fields blank.
- Source-site labels, tags, or notes showing special-disposition wording.

### When to open the detail page

Open the listing `url` to inspect photo count and information density when:

- any suspicious signal above is hit, OR
- the listing is otherwise strong enough to reach recommended / near-threshold
  and is worth verifying.

Detail URLs usually point to the originating source (591 / 樂居 / rakuya),
not `ibigfun.com`, so opening them does not affect the iBigFun login session.
Do NOT open every listing — only suspicious or borderline-but-promising ones,
to control cost.

### Verdict and output

Assign one of: `clean` / `suspicious` / `likely-auction`. For each, record the
reason, your confidence, and whether you actually opened the detail page.

- `likely-auction`: evidence points specifically at auction/foreclosure —
  `signals.auctionKeyword` plus corroboration (e.g. no interior photos,
  special-disposition wording on the detail page).
- `suspicious`: low-info or off quality without specific auction evidence
  (sparse description, missing interior photos, but no auction markers).
- `clean`: no concern, or a keyword hit verified as non-auction.

Both `suspicious` and `likely-auction` are down-ranked the same way (below); the
distinction is only for the reason you record.

Rules:

- proxy signals (e.g. "no interior photos") must never be the sole reason to
  remove a listing; auction-like listings are flagged, not auto-removed.
- If the detail page cannot be opened or the source blocks scraping, record
  "未能查證", keep the soft flag at low confidence, and do not escalate to
  removal.
- A keyword hit the agent verifies as non-auction (e.g. title says "非法拍" or
  "法拍屋旁") may be downgraded to `clean` with a recorded reason.

### Effect on ranking

`suspicious` / `likely-auction` listings are down-ranked, not removed: even if
the numbers qualify, do not place them in 推薦 — route them to 接近門檻 or the
可疑/待查 section with the reason noted. This mirrors the existing rule that a
listing lacking solid data cannot be labeled recommended.

## Notification Format

- Send with the canonical `ai-notify` command in `AGENTS.md`, which also defines the `ok`/`warn`/`fail` status selection.
- Use Markdown.
- Do not use tables.
- Put the quick summary before listing details.
- Add a Markdown link to every listing title.
- Render `detail_page_checked` as a short phrase (e.g. 已點詳情頁 / 未查證), not a raw boolean.
- Compose walk lines from the listing's enriched `walk` and `coordinate`:
  - Reliable (`walk` present): `🚶 {stationZh} {exitId} 號出口・{minutes} 分鐘（[地圖]({map_url})）`. If `exitId` is missing, drop the 出口 part: `🚶 {stationZh}・{minutes} 分鐘（[地圖]({map_url})）`.
  - Unreliable but `coordinate` present (`walk` is null — e.g. coordinate inconsistent, route ratio implausible): show the triage result and mark it pending: `🚶 約{station}・步行待確認（[地圖]({map_url})）`, or `🚶 步行待人工確認（[地圖]({map_url})）` when no station can be inferred.
  - No `coordinate`: `🚶 無位置資訊` (no map link).
- Map link `{map_url}` is exactly `https://www.google.com/maps?q=<lat>,<lng>` using the listing `coordinate`, with link text `地圖`.
- Emit the 🕒 tenure line (`{{tenure_line}}`) in every listing block unless a
  profile template explicitly omits tenure. Compose it from the listing's
  enriched `tenure`:
  - `recordCount === 0` (no 刊登紀錄 parsed): `🕒 刊登史不明`.
  - `daysOnMarket` is `0` (earliest record is the target date — genuinely fresh): `🕒 本日新上架`.
  - Otherwise: `🕒 已刊登 {daysOnMarket} 天・{price_part}（最早 {firstListedDate}・{sourceCount} 來源）`, where `{price_part}` is:
    - `priceTrend === 'flat'` → `未降價`
    - `priceTrend === 'dropped'` → `曾降價 {firstPrice}→{latestPrice}萬`
    - `priceTrend === 'raised'` → `曾調漲 {firstPrice}→{latestPrice}萬`
    - `priceTrend === 'unknown'` → drop the `・{price_part}` segment entirely: `🕒 已刊登 {daysOnMarket} 天（最早 {firstListedDate}・{sourceCount} 來源）`
  - This line is information-only: it never changes the recommend / exclusion / suspicious decision.
- When any field (月租, 現金流, 行情, 屋齡, 地址 等) is null, render it as `—` rather than dropping the line.
- Render each listed property with a 1-based `rank` value inside its section.
- Use the selected profile template for bucket names, inline metrics, omitted
  sections, exclusion-detail limits, and sorting.
- Keep a single notification around 3,500 Chinese characters when possible.
  Compress low-priority exclusions first; keep core numbers for the
  highest-priority profile buckets.

## Rule Ownership

Keep durable shared notification and data-quality rules in this file.
Keep profile-specific thresholds and report buckets in `docs/profiles/*.md`.
Keep the daily execution sequence in `AGENTS.md`. Keep recent run history and
one-off operational observations in automation memory.
