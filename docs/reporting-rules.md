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

`enriched.json` 彙總 `outOfRegionCount` 與 `inRegionTooFarCount`。投資報告在「排除摘要」
將兩個區域排除原因分開計數：`目標捷運站外 {outOfRegionCount} 筆` 與
`站內走路過遠 {inRegionTooFarCount} 筆`；各 reason 為 0 時隱藏該列。
`out-of-region` 與 `in-region-too-far` 的物件不逐筆列出。若 `進入評估` 異常為 0，
將白名單／資料異常警訊寫入 `data_warning`，不要增加另一條稽核摘要。

## Calculations

- Monthly mortgage payment must use total price, 80% loan-to-value, 2.6% annual interest, and 30-year principal and interest repayment. It is workflow/local data only and never appears in `report.md`.
- 租金覆蓋率 `估計月租 / 月房貸` 與現金流 `月租 − 房貸` 僅供 workflow/local reference，不參與分桶或排序，也不出現在 `report.md`（見下方 Rent 段）。

## Market Price (成交行情) Evidence

成交行情用來提供官方市場脈絡，並驗證物件的用途、車位與可比資料品質。
完整的官方中位數、P25–P75 與可靠性證據保留在本地 evidence；`report.md` 只使用精簡的 `market_summary_line`，且不把待售開價與官方估值的差異當作分桶、可疑訊號或排序依據。

### 預設來源與可靠性閘門

`enriched.json` 的 `marketEstimate` 是成交行情的預設且權威的工作來源：它以本地、版本化的
內政部實價登錄與台北市門牌資料選出可比成交。完整的 status、中位數、P25–P75、信心、可比筆數、選用階段與官方資料日期/新鮮度都保留在 git-ignored 的 `enriched.json` 和本地 evidence。
`report.md` 只顯示由該證據組成的精簡 `market_summary_line`。
When
`marketUnitPriceMedian` is non-null, render `官方成交中位約 {median rounded to 1 decimal} 萬/坪（{comparables.length} 筆可比{review limitation, when applicable}）`.
A `review` value retains exactly one concise human-readable limitation and never
becomes recommendation-eligible merely because a value exists. When the median
is null, render only a concise unavailable reason. Examples:
`官方成交中位約 56.4 萬/坪（13 筆可比）`
`官方成交中位約 56.4 萬/坪（13 筆可比；地址定位待確認）`
`官方行情無法估算：座標附近無可驗證門牌。`
Do not print raw status syntax,
P25–P75, internal stage, raw confidence enum, source-check date, or the full
reason list per property.

- 門牌索引與交易查找共用結構化的 base-doorplate key（市／區／路、選填段巷弄、號與子號），
  只有明確且完整的樓層／戶別文法可移除後再配對；`附近`、`隔壁巷` 或混合／不完整尾碼一律
  unresolved。相同 base key 的所有保留點必須有完全相同的經緯度才可 exact match；座標衝突時
  不得任選一點。原始地址、完整正規化地址、配對門牌、方法與不確定範圍仍完整保留在本機
  evidence。不可用模糊文字補猜缺失的市、區、路或號。
- 未解析文字地址只要 listing coordinate 可靠、行政區一致，且最近官方門牌距離 `<=100 m`，
  即為已接受的位置證據；`>100 m && <=300 m` 為 review-only，300 m 內無可驗證門牌則
  unavailable。An incomplete road-name mismatch within the accepted band is not a warning；它不會
  變成同棟門牌，也不會啟用同棟情境。
- 官方交易先分成三類：一般市場、單一建物、`住家用` 且車位為 Grade A（明確無車位，或
  價格與面積皆可直接分離）並通過所有硬性品質檢查者為 `reliable-eligible`。已知的
  `住商用`／辦公／商業／工業／住工用途、多棟移轉，或車位為 Grade B（僅缺一項或兩項）
  者保留為 `review-only`，可供 acceptance 核准的同用途／車位情境使用，但不會冒充住宅
  reliable 可比。空白／未知用途、政府標讓售、特殊交易、無法定位、Grade C 車位或其他
  硬性衝突才是 `excluded`。只剩 review-only 且沒有已核准情境時，估值必須為 `review`。
- 只有當本機 backtest acceptance 的 `transactions-index.json` checksum、`ESTIMATOR_POLICY_VERSION`、
  active policy id、schema-5 manifest 的 index-policy provenance、schema-3 acceptance，以及完整有效
  交易索引的最新日期覆蓋均與目前執行環境完全相符時，估值才可為 `reliable`。Acceptance 必須同時
  證明：所有 `reliable-eligible` held-out 交易
  中至少 70% 可估價、`reliable` cohort 的 median APE ≤12% 且 P75 APE ≤20%、high／medium
  各至少 20 筆，且 high median APE 至少比 medium 低一個絕對百分點。Coverage denominator
  只含符合 production eligibility 的 held-out 交易；`review-only` 與硬性排除項均不在分母。
  缺少 acceptance、backtest 未完成/未達標、歷史 `--as-of` 未涵蓋完整索引、估值政策已變更或資料集
  已更新時一律降為 `review`，不得自動推薦。任何 eligibility、selector、weight、outlier、
  confidence、listing-location status/eligibility、status、coverage 或 backtest 語意變更都必須提高
  `ESTIMATOR_POLICY_VERSION` 並重新通過完整 backtest。
- policy-8 將 listing-location status/eligibility 納入相容性契約，並啟用
  schema-5／policy-8／acceptance-schema-3 正式契約。此 bump 必須由 `update`
  完整通過 gate 後原子發布，否則保留 last-known-good。
  `marketEstimate` 仍是官方市場脈絡與資料品質的基準；`marketScenarios` 只依 acceptance 已核准的用途與
  車位家族補充情境證據，不得繞過用途、車位數、地址、freshness 或信心檢查。
  詳見 [safe-stop design](superpowers/specs/2026-08-03-multi-use-parking-safe-stop-design.md)。
- Candidate coverage 不足只能依序評估 baseline → 48-month → 1000-meter；只有前一政策「單純 coverage
  <70%」時才可擴張，任何 accuracy／confidence calibration failure 都必須停止。Fallback 必須全面
  通過相同門檻，且仍須另行明確啟用與 provenance review；目前 `update` 不會因未來 data-only pass
  自動發佈。不得降低門檻或混用建物型態。
- `status: reliable` 且兩個官方來源均未過期，才可能進入自動推薦；`low` 信心、
  `review` 或 `unavailable` 只能進入待人工覆核的候選或依其他硬性規則排除。
- 待售物件含車位時，保守 `marketEstimate` 會標為 `listing-parking-not-separable`／review；只有
  車位家族與數量已確認、該家族 acceptance 已通過且 `marketScenarios` 其餘證據也完整時，車位估值
  才能作補充情境，不能單獨把物件升為自動推薦。
- 任一官方來源過期時，受影響物件不得推薦；偏舊解讀同時寫入 `data_warning` 與受影響物件的 `market_summary_line`，不印來源日期，整則通知一律使用 `warn`。

### 有界外部覆核（非靜默覆寫）

僅對低信心、`review`/`unavailable` 或其他有明確可解決行情疑點的少數物件，可人工查閱外部估值
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

### 產權相容性（地上權／使用權）

- 從標題／詳情辨識非自由持分（如「地上權」「使用權」字樣）。
- 自由持分的官方可比成交不能證明非自由持分物件的行情可靠；不得自動推薦。
- 產權類型與 profile 或官方證據不相容是重要資料品質／風險訊號，放入
  `風險物件／待查`；若已確認違反 profile 硬性產權條件，則排除並說明。

## Rent (預估月租金，workflow/local only)

- 租金為純 workflow/local 參考（現金流 = 月租 − 房貸），**永不影響分桶或排序，也不出現在 `report.md`**。
- agent 可粗估同區同類型可比租金，不建租金資料集；來源（若有）、低信心和實際可租金額／空置期確認均留在本地 workflow data。

## Manual Checks

- Actual achievable rent and expected vacancy period.
- Property condition, leaks, roof waterproofing, and repair cost.
- Loan-to-value, bank appraisal, and interest-rate terms.
- Illegal additions, rooftop additions, title issues, or zoning/use issues.
- Whether comparable transaction data is close enough by area, age, floor, and property type.

## Data Quality Rules

- Prefer fresh iBigFun listing and official market data for the target report date.
- If market data is stale, cached, timed out, or externally reviewed, put the compact interpretation in `data_warning` and the affected listing's `market_summary_line`.
- Do not label a listing as recommended when its market evidence is stale, low-confidence, `review`, `unavailable`, or weak. Put a clean listing with resolvable uncertainty in `候選／資料待確認`; otherwise follow the profile's risk or exclusion rules.
- Keep only a compact stale/freshness interpretation in `data_warning` and the affected listing's `market_summary_line`; official source dates and full evidence stay local in `enriched.json` and (when used) `valuation-review.json`.
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
- the listing is otherwise strong enough to reach a positive or candidate bucket
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

Both `suspicious` and `likely-auction` are routed to `風險物件／待查`; the
distinction is only for the reason you record.

Rules:

- proxy signals (e.g. "no interior photos") must never be the sole reason to
  remove a listing; auction-like listings are flagged, not auto-removed.
- If the detail page cannot be opened or the source blocks scraping, record
  "未能查證", keep the soft flag at low confidence, and do not escalate to
  removal.
- A keyword hit the agent verifies as non-auction (e.g. title says "非法拍" or
  "法拍屋旁") may be downgraded to `clean` with a recorded reason.

### Effect on bucketing

`suspicious` / `likely-auction` listings are flagged, not silently removed. Even
when other criteria pass or data also needs review, route them to
`風險物件／待查` with the reason noted; the verified risk verdict takes
precedence over a positive or clean-data candidate bucket.

## Notification Format

- `report.md` is the exact user-facing Markdown body sent to `ai-notify`; do not create a second notification artifact. Its first content line is the conclusion, never a Markdown heading.
- Use `✅` for `ok`, `⚠️` for `warn`, and `❌` for `fail`. The `pipeline mark report --title` value is the sole notification title and contains the status icon, date/range, profile purpose, and primary outcome; do not repeat it in `report.md`.
- `ok` means the run completed without unresolved actionable warnings; it may contain fully supported recommendations or matches.
- `warn` means candidates, risks, unresolved actionable manual review, stale sources, unverified mappings, or other weak evidence affects safe interpretation.
- A fresh market review/unavailable result on a confirmed hard exclusion does not force `warn`.
- Put one conclusion sentence first, followed by one compact count line. Render `data_warning` only when stale, weak, missing, or inconsistent data affects safe interpretation.
- List every positive, candidate, and risk property. Summarize excluded properties by valid hard reason and count; never list excluded properties individually.
- Every individually rendered property shows total price, area, asking unit price, profile-relevant basics, `walk_line`, `tenure_line`, `market_summary_line`, and one bucket reason or next action.
- Compose `walk_line` after bucketing from authoritative enriched ORS `walk`, the display-only `route-trial.json` comparison, and `coordinate`; apply it only to positive, candidate, and risk buckets. The Valhalla trial never changes a bucket, order, ORS decision, or notification status, and excluded/count-only listings never enter its request. `route-trial-request.json` must name the selected enriched-index array exactly `listingIndexes`, with at most 25 unique safe integer entries:
  - Both reliable: `🚶 ORS 松江南京 4號出口・9分｜Valhalla 松江南京 3號出口・10分（試行）・[地圖](https://www.google.com/maps?q=<lat>,<lng>)`; substitute each provider's selected station, exit, and recomputed minutes, and omit either provider's exit segment when its `exitId` is absent.
  - Valhalla unavailable: `🚶 ORS 松江南京 4號出口・9分｜Valhalla 暫無（試行）・[地圖](https://www.google.com/maps?q=<lat>,<lng>)`.
  - ORS unavailable: `🚶 ORS 待確認｜Valhalla 松江南京 3號出口・10分（試行）・[地圖](https://www.google.com/maps?q=<lat>,<lng>)`.
  - Both unavailable: `🚶 ORS 待確認｜Valhalla 暫無（試行）・[地圖](https://www.google.com/maps?q=<lat>,<lng>)`.
  - No coordinate: `🚶 無位置資訊` (without a map link).
- Compose `tenure_line` from enriched `tenure`:
  - For `daysOnMarket === 0`, use `🕒 今日上架`.
  - For known positive days with flat, dropped, or raised price trend, use `🕒 已刊登 {daysOnMarket} 天` plus `・未降價`, `・曾降價 {firstPrice}→{latestPrice}萬`, or `・曾調漲 {firstPrice}→{latestPrice}萬` for the known price history.
  - For known positive days with unknown price trend, use `🕒 已刊登 {daysOnMarket} 天` with no trend suffix.
  - For only unknown days, use `🕒 刊登天數待確認`.
  - Never invent a price-history value.
- Omit an unavailable optional segment instead of printing repeated `—`. Convert decision-relevant missing data into a short action phrase; never invent a value.
- Compose `market_summary_line` from authoritative `marketEstimate`: When `marketUnitPriceMedian` is non-null, render `官方成交中位約 {median rounded to 1 decimal} 萬/坪（{comparables.length} 筆可比{review limitation, when applicable}）`. A `review` value retains exactly one concise human-readable limitation and never becomes recommendation-eligible merely because a value exists. When the median is null, render only a concise unavailable reason. Do not print raw status syntax, P25-P75, internal stage, raw confidence enum, source-check date, or the full reason list per property.
- Any stale official source remains visible in the top warning and affected listing, forces `warn`, and blocks an automatic positive bucket.
- A bounded external review that affects a bucket gets one compact review conclusion. It never overwrites official evidence and raw external content remains local.
- Never describe a listing as cheap, expensive, a deal, overpriced, suspicious, sorted, bucketed, or excludable from asking price versus official evidence.
- Do not show mortgage, rent, cash flow, financing assumptions, generic repeated manual-check lists, rule-source footers, route/cache/enrich counters, timestamps, internal event names, or raw stack traces.
- Keep a single notification around 3,500 Chinese characters when possible. Completeness of positive, candidate, and risk buckets takes precedence; never silently truncate.

## Rule Ownership

Keep durable shared notification and data-quality rules in this file.
Keep profile-specific thresholds and report buckets in `profiles/<id>/evaluation.md`.
Keep the daily execution sequence in `AGENTS.md`. Keep recent run history and
one-off operational observations in automation memory.
