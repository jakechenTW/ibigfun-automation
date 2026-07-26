# Reporting Rules

## Profile Rules

Shared rules live in this file. Profile-specific decision thresholds live in:

- `profiles/example-investment/evaluation.md`
- `profiles/example-owner-occupied/evaluation.md`

## Investment Criteria

Investment-specific thresholds and estimation rules are owned by
`profiles/example-investment/evaluation.md`.

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

## Region Gate（目標捷運範圍，投資 profile）

投資 profile 將範圍限縮在 `data/region-allowlist.md` 的 35 站核心區。enrich 以
走路最近站 (`walk.stationZh`) 比對白名單，於每筆 listing 產出 `regionGate`
（`scripts/lib/region.ts`），口徑互斥、先判範圍再判遠近：

- `in`：最近站在白名單且 `withinWalk === true` → 進入評估。
- `out-of-region`：最近站不在白名單（不論遠近）→ 排除，僅計數。
- `in-region-too-far`：最近站在白名單但 `withinWalk === false` → 排除，僅計數。
- `review`：`withinWalk === null`（座標/路線不可靠）→ 不排除，送既有人工 triage。

`enriched.json` 彙總 `outOfRegionCount` 與 `inRegionTooFarCount`。投資報告「快速摘要」
須輸出一行稽核計數，兩個排除原因分開列，例如：
`本日新案 {count} 筆｜目標捷運站外 {outOfRegionCount} 筆｜站內走路過遠 {inRegionTooFarCount} 筆｜進入評估 {in 計} 筆（待人工確認 {manualReviewCount} 筆）`。
`out-of-region` 與 `in-region-too-far` 的物件不逐筆列出，只進此計數行；若 `進入評估`
異常為 0，視為白名單/資料異常的警訊。

## Calculations

- 開價溢價（asking premium）須用：`(物件開價單價 − 成交行情單價) / 成交行情單價 * 100`。
  正值＝開價高於成交行情（常態）；負值＝開價低於成交行情（罕見、強訊號）。
- 典型開價溢價 `p*` 由各市成交議價率 `r` 換算：`p* = r / (1 − r)`，`r` 取自
  `data/negotiation-rate.md`。
- 投資 profile 的分桶門檻（推薦 `溢價 ≤ p*/2`、接近 `p*/2 < 溢價 ≤ p*`、排除 `溢價 > p*`、
  可疑含 `溢價 ≤ −10%`）見 `profiles/example-investment/evaluation.md`。
- Monthly mortgage payment must use total price, 80% loan-to-value, 2.6% annual interest, and 30-year principal and interest repayment.
- 租金覆蓋率 `估計月租 / 月房貸` 與現金流 `月租 − 房貸` 僅供參考顯示，不參與分桶或排序
  （見下方 Rent 段）。

## Market Price (成交行情) & Premium

成交行情單價是開價溢價計算的基準。開價（iBigFun 上的委託價）系統性高於成交行情，
因此幾乎每筆物件的溢價為正；以成交行情為錨點、用各市議價率換算的 `p*` 畫門檻，
正是為了吸收這個結構性落差。

### 預設來源與保守分桶

`enriched.json` 的 `marketEstimate` 是成交行情的預設且權威的工作來源：它以本地、版本化的
內政部實價登錄與台北市門牌資料選出可比成交。報告必須顯示 `reliable`、`review` 或
`unavailable`，以及中位數、P25–P75、信心、可比筆數、選用階段與官方資料日期/新鮮度。
通知只顯示這個摘要；完整可比成交及其排除理由留在 git-ignored 的 `enriched.json`，不可整份貼進通知。

- 投資分桶的開價溢價以 **P25 保守行情** 計算/覆核；中位數溢價只能用於說明，不能單獨使物件進入推薦。
- 只有當本機 backtest acceptance 的 `transactions-index.json` checksum、`ESTIMATOR_POLICY_VERSION`、
  以及完整有效交易索引的最新日期覆蓋均與目前執行環境完全相符時，估值才可為 `reliable`；缺少
  acceptance、backtest 未完成/未達標、歷史 `--as-of` 未涵蓋完整索引、估值政策已變更或資料集已更新時
  一律降為 `review`，不得自動推薦。任何 selector、weight、outlier、confidence、status 或 backtest
  語意變更都必須提高 `ESTIMATOR_POLICY_VERSION` 並重新通過完整 backtest。
- `status: reliable` 且兩個官方來源均未過期，才可能進入推薦；`low` 信心、`review`、`unavailable`，或只靠中位數才符合門檻者，最多是待人工覆核的候選。
- 車位價格/面積無法與建物分離（含 `listing-parking-not-separable`）時，不得自動推薦。
- 任一官方來源過期時，受影響物件不得推薦，快速摘要必須寫明資料偏舊，整則通知一律使用 `warn`。

### 有界外部覆核（非靜默覆寫）

僅對低信心、`review`/`unavailable`，或以中位數才看似跨過門檻的少數邊界物件，可人工查閱外部估值
（例如好時價 AVM）。不得全量查詢、逆向 endpoint 或把外部值寫回 `marketEstimate`。外部結果不會取代
官方值；若它改變物件分桶，必須在同一 run 寫入 `valuation-review.json`，並保留 listing ID、來源及 HTTPS
URL、查核時間、外部單價/總價（來源有回傳時）、官方狀態與 unavailable reasons、可用的官方
P25/中位/P75、兩邊單價皆有時的差異、是否採納、理由與結果分桶。缺值明確寫 `null`；不得用 0 或虛構值
填補。未取得任何外部價格的查核只能記為 `accepted: false`。pipeline 在
`mark report --status ok` 時會驗證此檔；沒有可驗證證據不得藉外部值改桶。官方行情不可用時，外部查核
只能讓物件留在人工候選，不能直接升為推薦。

每個 review `listingId` 必須在同 run 的 `enriched.json` **恰好出現一次**，review 內的
`officialStatus`、`officialUnavailableReasons`、官方中位/P25/P75（包含 `null`）必須逐欄等於該 listing 的
`marketEstimate`；同一 listing 不得有重複 review。`differencePercent` 定義為
`(externalUnitPriceWan − officialMedianWan) / officialMedianWan * 100`，只有兩個單價都有時可填，pipeline
以 ±0.01 個百分點容差重算驗證。只要 `valuation-review.json` 存在，這些綁定規則對 `ok`、`warn`、`fail`
通知狀態都生效；換成 `warn` 不能繞過稽核。

通知的逐筆「覆核」欄只能是一行精簡結論（是否查核、來源、結果和待確認事項），不得包含完整可比清單、
原始地址、交易列或外部頁面抓取內容。

### 非自由持分（地上權／使用權）校正

開價溢價假設物件與成交行情同為自由持分（所有權）。地上權、區分地上權、使用權住宅等
非自由持分物件的開價結構性低於自由持分行情，直接拿來算溢價會失真——開價偏低時得到失真的
大負值，開價偏高時得到失真的小溢價。

- 從標題／詳情辨識非自由持分（如「地上權」「使用權」字樣）。
- 不可用自由持分成交行情當其溢價基準；不得僅憑這種失真溢價標為推薦。
- 路由到「可疑/待查」並註記持分型態；無可比同型成交時排除並說明。

## Rent (預估月租金，僅供參考)

- 租金降為純參考：只顯示 `月租 ~X（參考·低信心）` 與 `現金流 ~Y/月（參考）`
  （現金流 = 月租 − 房貸），**永不影響分桶或排序**。
- 由 agent 粗估同區同類型可比租金即可；不建租金資料集。標來源（若有）與低信心。
- 一律提醒人工確認實際可租金額與空置期。

## Manual Checks

- Actual achievable rent and expected vacancy period.
- Property condition, leaks, roof waterproofing, and repair cost.
- Loan-to-value, bank appraisal, and interest-rate terms.
- Illegal additions, rooftop additions, title issues, or zoning/use issues.
- Whether comparable transaction data is close enough by area, age, floor, and property type.

## Data Quality Rules

- Prefer fresh iBigFun listing and official market data for the target report date.
- If market data is stale, cached, timed out, or externally reviewed, say so in the quick summary and the affected listing's compact evidence line.
- Do not label a listing as recommended when its market comparison is stale, low-confidence, `review`, `unavailable`, or weak. Put it in near-threshold or excluded status and mark it for manual confirmation.
- Keep the official source date/freshness and compact evidence summary visible in the listing notes; preserve the full local evidence in `enriched.json` and (when used) `valuation-review.json`.
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
- For every evaluated listing, render one compact market-evidence line: status (`reliable` / `review` / `unavailable`), official median and P25–P75 when available, confidence, comparable count, selected stage, official source date, and freshness. A `review` or `unavailable` result must say `需人工確認`; do not imply it is a reliable valuation.
- In the profile templates, set `market_requires_review` for `review` or `unavailable` and render `需人工確認：{{market_manual_review_reason}}`; the reason is a compact summary of `unavailableReasons`/freshness, never raw comparables. Apply this to every individually rendered bucket.
- If an external valuation was consulted, render one compact review line. Do not embed raw comparables or the external response in the notification.
- Render each listed property with a 1-based `rank` value inside its section.
- Use the selected profile template for bucket names, inline metrics, omitted
  sections, exclusion-detail limits, and sorting.
- Keep a single notification around 3,500 Chinese characters when possible.
  Compress low-priority exclusions first; keep core numbers for the
  highest-priority profile buckets.

## Rule Ownership

Keep durable shared notification and data-quality rules in this file.
Keep profile-specific thresholds and report buckets in `profiles/<id>/evaluation.md`.
Keep the daily execution sequence in `AGENTS.md`. Keep recent run history and
one-off operational observations in automation memory.
