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

### 權威用途情境、車位證據與保守分桶

`enriched.json` 的 `marketScenarios` 是成交行情與報告分桶的權威工作來源：它以本地、版本化的
內政部實價登錄與台北市門牌資料，按官方主要用途分開估算建物單價 P25/P50/P75 與含車位的
整體總價 P25/P50/P75。`marketEstimate` 僅保留一版作相容與通知稽核，尤其在用途未知或使用
車位推估時會帶 `legacy-residential-baseline-not-authoritative`；不得再用它取代情境判斷。

- 門牌索引與交易查找共用結構化的 base-doorplate key（市／區／路、選填段巷弄、號與子號），
  只有明確且完整的樓層／戶別文法可移除後再配對；`附近`、`隔壁巷` 或混合／不完整尾碼一律
  unresolved。相同 base key 的所有保留點必須有完全相同的經緯度才可 exact match；座標衝突時
  不得任選一點。原始地址、完整正規化地址、配對門牌、方法與不確定範圍仍完整保留在本機
  evidence。不可用模糊文字補猜缺失的市、區、路或號。
- 官方主要用途正規化為 `residential`、`mixed-residential`、`office`、`commercial`、
  `industrial`、`mixed-industrial` 或 `unknown`。每個情境只使用完全相同的官方主要用途；樣本少
  不得跨用途混合補足。一次移轉多棟、政府標讓售、特殊交易、無法定位或其他硬性衝突仍不得成為
  建物單價可比。
- 車位證據採 A/B/C 分級，不再以「所有價格或面積不能直接分離的車位一律不可估」作單一規則：
  - A：有車位時，官方車位價格與面積皆可直接分離；明確無車位且官方零值／空值一致時也屬 A。
    A 按正常權重進建物單價；只有有車位的 A 可訓練車位推估。
  - B：缺少車位價格、面積之一或兩者，但可由估價日以前的同棟或 500 公尺內同類 A 級車位因果推估；
    只有共享車位 gate 通過時才可使用，且建物可比權重有上限。報告須標示推估階段與組件。
  - C：建物／車位組件仍無法分離，只能作同用途整體成交的 bundle 交叉檢查；不得進建物單價
    P25/P50/P75，也不得訓練或被當成 B 級。bundle 顯著衝突時送人工複核。
- 報告語意中的「acceptance-enabled 情境」是：官方用途 cohort 已由相符的 schema-3 acceptance
  標為 accepted，所需車位組件也通過共享車位 gate，且情境有非空的建物 P25/P50/P75。實際
  `UseScenarioEstimate` 沒有獨立的 acceptance 布林欄；應由其 quantiles 與 `reasons` 判讀：含
  `use-cohort-not-accepted` 或所需車位模型含 `parking-cohort-not-accepted` 的情境不得計入。
  用途未知的情境即使 acceptance-enabled，`status` 依設計仍最多為 `review`；若唯一待確認原因是
  `registered-use-unverified`，可依下方「條件式推薦」規則判斷，不能誤要求它變成 `reliable`。
- 投資分桶以每個 acceptance-enabled 情境的 **含車位總價 P25** 所得
  `askingPremiumConservative` 計算/覆核；建物中位數或住宅比較情境只能說明，不能單獨使物件進入推薦。
- 只有當本機 backtest acceptance 的 `transactions-index.json` checksum、`ESTIMATOR_POLICY_VERSION`、
  active policy id、schema-4 manifest 的 index-policy provenance、schema-3 acceptance，以及完整有效
  交易索引的最新日期覆蓋均與目前執行環境完全相符時，accepted cohort 才可支持自動判斷。
  Residential 全域 gate 仍須證明 coverage ≥70%、reliable median APE ≤12%、P75 APE ≤20%，以及
  high／medium 的既有樣本與信心排序門檻；每個用途 cohort 與共享車位 gate 另行驗證，失敗或樣本不足
  的非住宅 cohort 保持 `diagnostic-only`，不得借用住宅 cohort 取得 accepted。缺少 acceptance、
  backtest 未完成/未達標、歷史 `--as-of` 未涵蓋完整索引、估值政策已變更或資料集已更新時一律
  降級，不得自動推薦。任何 eligibility、selector、weight、outlier、confidence、status、coverage
  或 backtest 語意變更都必須提高 `ESTIMATOR_POLICY_VERSION` 並重新通過完整 backtest。
- 市場資料 refresh 先在 staging 建 candidate index 並完成 gate，只有 candidate build 與 checksum
  綁定 acceptance 皆通過才一起發佈。失敗時保留 last-known-good active build／acceptance，不得把
  失敗 candidate 或錯配 acceptance 用於 `reliable`。來源 byte 未變時，也只有目前 active build
  已有相符的現行 policy acceptance 才可走 `not-modified` 快路徑；policy／eligibility 變更造成舊
  acceptance 失效時必須重建 index、重新 gate 並交易式發佈。發佈 rename 中斷後，由同一 writer
  lock 下的 durable journal／old-acceptance backup 恢復成驗證過的舊 pair 或新 pair。舊版 build
  或缺少／錯配 policy provenance 的 schema-4 build 一律不得成為目前執行環境的估值權威；正常
  `update` 必須以
  現行語義重建並發佈，不得只改 manifest metadata 或補簽 acceptance。Standalone `backtest`（包含
  `--no-gate`）須在輸出 case evidence 前拒絕錯配 provenance，writer 落盤前再比對 active manifest、
  transaction checksum 與 acceptance policy/version。
- Coverage 不足只能依序評估 baseline → 48-month → 1000-meter；只有前一政策「單純 coverage
  <70%」時才可擴張，任何 accuracy／confidence calibration failure 都必須停止。Fallback 必須全面
  通過相同門檻、提高 policy compatibility 版本並以正常 update 發佈；不得降低門檻或混用建物型態。
- 已驗證用途的 controlling scenario 必須為 `reliable` 且兩個官方來源均未過期，才可能進入推薦；
  `low` 信心、`unavailable`、未 accepted、只靠 P50 才符合門檻，或含未解衝突者，最多是待人工
  覆核候選。用途未知時唯一例外是下方明確標示的條件式推薦；它不能被寫成用途已驗證。
- 任一官方來源過期時，受影響物件不得推薦，快速摘要必須寫明資料偏舊，整則通知一律使用 `warn`。

### 用途驗證與情境決策順序

`marketScenarios.registeredUse` 只有 `source` 為 `official` 或 `manual` 且 `value !== 'unknown'`
才是已驗證用途。房源標題、描述、`typeLayout` 或「工業宅／住辦」等市場文案永遠不能改寫或驗證
登記用途。

依下列順序決策，profile 只能加上自己的 P25 門檻與其他既有硬條件，不得改變用途優先序：

1. **已驗證用途**：同用途且 acceptance-enabled 的 `role: primary` 情境控制。若已驗證為非住宅，
   `role: residential-comparison` 只能比較說明，不能覆寫同用途結論或單獨促成推薦。
2. **用途未知／未驗證**：先檢查 bundle conflict；任何 `bundle-evidence-conflicts` 都送「人工複核」。
   接著只把 acceptance-enabled、P25 非空、資料新鮮、信心非 low，且除
   `registered-use-unverified`、`bundle-evidence-corroborates`／`bundle-evidence-insufficient` 外無其他
   unresolved reason 的情境視為 supported：
   - 至少兩個 supported 情境（必含 residential）全部通過 profile 的 P25 gate，且沒有
     diagnostic-only 情境提供相反判斷，才可標「條件式推薦（用途未確認）」。
   - pass／fail／insufficient 混合、所有 supported 皆 pass 但未達兩情境或缺 residential，或
     diagnostic-only 情境與通過結果衝突，均為「用途待確認候選」。
   - 每個 supported 情境都未通過 P25 gate，為「不推薦」。
   - 沒有 supported 情境，為「人工複核」。

條件式推薦不是法律用途認定；報告仍須列出待確認的登記用途、貸款、稅務與轉售風險。

### 情境表、可比定位與官方連結

每個逐筆列出的物件都須由 `marketScenarios.scenarios` 產生下列情境表；無值顯示 `—`，不得拿
`marketEstimate` 補空：

| 登記用途情境 | 建物單價 P25／P50／P75 | 含車位總價 P25／P50／P75 | A／B／C 筆數 | 狀態 | 判斷 |
|---|---:|---:|---:|---|---|

- 單價取 `marketUnitPriceP25`／`marketUnitPriceMedian`／`marketUnitPriceP75`；總價取
  `bundleValue.p25Ntd`／`p50Ntd`／`p75Ntd` 並轉成萬元；A/B/C 取 `gradeCounts`。
- 「狀態」須合併顯示 `status`、`confidence`、`selectedStage`、資料新鮮度及 acceptance 判讀；
  「判斷」寫該情境通過／未通過 profile P25 gate、比較用、證據不足或衝突，不可只貼 reason code。
- 每情境最多列兩筆最具影響可比：先將 `comparables` 與 `bundleComparables` 依交易 ID 去重，再按
  `weight.total` 由高到低取前兩筆。每筆使用 `officialLocator` 與 transaction parking evidence 顯示
  交易月份、路名／揭露地址範圍、樓層、總面積、總價、車位 family/grade 與直接價格／面積或推估
  階段、距離範圍及 imputation 標籤；不得輸出 transaction ID。
- 每筆可比附 `[內政部查詢](https://lvr.land.moi.gov.tw/)`。這是內政部查詢服務入口；
  `officialLocator` 的行政區、路名／地址範圍、月份、樓層、總價及面積只協助人工定位，連結**不是**
  精確交易列或永久 deep link，不得宣稱點擊後會直接開啟該筆交易。
- 完整 comparables、排除理由與地址 evidence 留在 git-ignored `enriched.json`；通知只列上述摘要，
  不得整份貼出 raw transactions 或 per-case backtest。

### 有界外部覆核（非靜默覆寫）

僅對低信心、`review`/`unavailable`，或以中位數才看似跨過門檻的少數邊界物件，可人工查閱外部估值
（例如好時價 AVM）。不得全量查詢、逆向 endpoint 或把外部值寫回 `marketScenarios`／相容
`marketEstimate`。外部結果不會取代官方情境值，也不能把未 accepted 或衝突情境升格；若它在既有
情境規則允許的人工判斷範圍內改變物件分桶，必須在同一 run 寫入 `valuation-review.json`，並保留
listing ID、來源及 HTTPS URL、查核時間、外部單價/總價（來源有回傳時）、官方狀態與
unavailable reasons、可用的官方
P25/中位/P75、兩邊單價皆有時的差異、是否採納、理由與結果分桶。缺值明確寫 `null`；不得用 0 或虛構值
填補。未取得任何外部價格的查核只能記為 `accepted: false`。pipeline 在
`mark report --status ok` 時會驗證此檔；沒有可驗證證據不得藉外部值改桶。官方行情不可用時，外部查核
只能讓物件留在人工候選，不能直接升為推薦。

每個 review `listingId` 必須在同 run 的 `enriched.json` **恰好出現一次**，review 內的
`officialStatus`、`officialUnavailableReasons`、官方中位/P25/P75（包含 `null`）必須逐欄等於該 listing 的
相容 `marketEstimate`（這是現行 pipeline 的覆核稽核契約，不是分桶權威）；同一 listing 不得有
重複 review。`differencePercent` 定義為
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
- Do not label a verified-use listing as recommended when its controlling scenario is stale, low-confidence,
  `review`, `unavailable`, `diagnostic-only`, `insufficient-sample`, or weak. For unknown use, only the explicitly
  labelled conditional-recommendation exception in「用途驗證與情境決策順序」may proceed while each
  scenario remains `review` solely because use is unverified; any other review reason routes to a candidate or
  human confirmation.
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
- Do not use tables except the required compact use-scenario evidence table for each individually rendered listing.
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
- For every evaluated listing, render the required compact scenario table with each scenario's P25/P50/P75,
  grade counts, status summary, and profile judgment. Below it render at most two influential comparables per
  scenario with the official-query locator fields defined above. A `review`, `unavailable`, `diagnostic-only`, or
  `insufficient-sample` scenario must say why it cannot control; do not imply it is a verified reliable valuation.
- In the profile templates, set `scenario_requires_review` when the controlling or conditional-decision evidence
  needs review and render `需人工確認：{{scenario_manual_review_reason}}`; derive the reason compactly from
  `marketScenarios.reasons`, scenario `reasons`, freshness, and use verification, never from raw comparables.
  Apply this to every individually rendered bucket. Legacy `market_requires_review` may still be used only for
  the one-release compatibility/notification audit and must not replace the scenario judgment.
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
