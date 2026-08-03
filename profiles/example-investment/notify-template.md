## iBigFun 每日投資房源監測（範例） - {{date}}

**結論：{{conclusion}}**

### 快速摘要

- 新刊登物件：{{new_listing_count}} 筆
- iBigFun 查詢：[開啟目標日篩選](https://www.ibigfun.com/lists/latest?page=1&expand=0&method=all_case&on_market=1&city=1&price_segment=%2C3000&floor_segment=2%2C4&total_floor=%2C5&add_date={{date}}&add_date_max={{date}})
- 區域閘門｜目標捷運站外：{{out_of_region_count}} 筆・站內走路過遠：{{in_region_too_far_count}} 筆・待人工確認：{{manual_review_count}} 筆
- 推薦物件：{{recommended_count}} 筆
- 接近門檻：{{near_threshold_count}} 筆
- 目標日排除：{{excluded_count}} 筆
- 可疑/待查：{{suspicious_count}} 筆
- 用途情境決策｜條件式推薦：{{conditional_recommended_count}} 筆・用途待確認：{{use_confirmation_count}} 筆・人工複核：{{scenario_manual_review_count}} 筆
- 相容行情稽核（非分桶權威）｜可靠：{{market_reliable_count}} 筆・待覆核：{{market_review_count}} 筆・不可用：{{market_unavailable_count}} 筆・資料偏舊：{{market_stale_count}} 筆
- 主要排除原因：{{main_exclusion_reasons}}
- 房貸假設：8 成貸、年利率 2.6%、30 年本息平均攤還
- 推薦門檻：已驗證用途取 accepted 同用途情境；用途未知須至少兩個 accepted 情境（必含住宅）
  全部符合 `−10% < P25 開價溢價 ≤ 該市 p*/2`，且無 diagnostic 或 bundle 衝突
- 接近門檻：`p*/2 < 開價溢價 ≤ p*`
- 排除：`開價溢價 > p*`；可疑/待查：`開價溢價 ≤ −10%`（異常低）或法拍/資訊過少等軟標記
- 區域閘門：最近捷運站不在目標白名單（目標捷運站外）或白名單站但可靠步行 >10 分（站內走路過遠）即排除，只計數不逐列（見 `data/region-allowlist.md`）
- 可疑/待查：法拍／資訊過少／無室內圖等由 agent 軟標記,降權但不自動移除
- 用途來源：只認 `marketScenarios.registeredUse` 的 official/manual 證據；房源標題與描述不驗證用途
- 實價連結：逐筆 `[內政部查詢]` 只開啟查詢服務入口，須以列示條件定位，並非精確交易列直連

### 推薦物件

{{#if recommended}}

{{#each recommended}}

#### {{rank}}. [{{title}}]({{url}}) ｜ 開價溢價 {{premium_percent}}%・{{use_decision_label}}

- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 登記用途 {{registered_use_value}}（來源 {{registered_use_source}}・{{registered_use_detail}}）

| 登記用途情境 | 建物單價 P25／P50／P75 | 含車位總價 P25／P50／P75 | A／B／C 筆數 | 狀態 | 判斷 |
|---|---:|---:|---:|---|---|
{{#each market_scenarios}}
| {{use_label}} | {{building_p25_wan}}／{{building_p50_wan}}／{{building_p75_wan}} 萬/坪 | {{bundle_p25_wan}}／{{bundle_p50_wan}}／{{bundle_p75_wan}} 萬 | {{grade_a_count}}／{{grade_b_count}}／{{grade_c_count}} | {{scenario_status_summary}} | {{scenario_judgment}} |
{{/each}}

{{#each market_scenarios}}
{{#each influential_comparables}}
- {{../use_label}} 最具影響可比：{{transaction_month}}・{{district}} {{address_or_road}}・{{floor}} 樓・{{total_area_ping}} 坪・{{total_price_wan}} 萬・車位 {{parking_evidence}}・距離 {{distance_min_m}}–{{distance_max_m}} 公尺・{{imputation_label}}・[內政部查詢](https://lvr.land.moi.gov.tw/)
{{/each}}
{{/each}}

- 房貸 {{monthly_mortgage}}・月租 ~{{estimated_rent}}（參考）・現金流 ~{{monthly_cash_flow}}/月（參考）
{{#if scenario_requires_review}}

- 需人工確認：{{scenario_manual_review_reason}}

{{/if}}
- 覆核：{{valuation_review_line}}
- 推薦理由：{{recommendation_reason}}
- 風險：{{risks_or_manual_checks}}

{{/each}}

{{else}}

- 無已驗證用途或符合 unknown-use 條件式規則、且所有 controlling/supported 情境皆通過
  `−10% < P25 開價溢價 ≤ p*/2` 的推薦物件。

{{/if}}

### 接近門檻候選

{{#if near_threshold}}

{{#each near_threshold}}

#### {{rank}}. [{{title}}]({{url}}) ｜ 開價溢價 {{premium_percent}}%・差在 {{near_threshold_reason}}・{{use_decision_label}}

- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 登記用途 {{registered_use_value}}（來源 {{registered_use_source}}・{{registered_use_detail}}）

| 登記用途情境 | 建物單價 P25／P50／P75 | 含車位總價 P25／P50／P75 | A／B／C 筆數 | 狀態 | 判斷 |
|---|---:|---:|---:|---|---|
{{#each market_scenarios}}
| {{use_label}} | {{building_p25_wan}}／{{building_p50_wan}}／{{building_p75_wan}} 萬/坪 | {{bundle_p25_wan}}／{{bundle_p50_wan}}／{{bundle_p75_wan}} 萬 | {{grade_a_count}}／{{grade_b_count}}／{{grade_c_count}} | {{scenario_status_summary}} | {{scenario_judgment}} |
{{/each}}

{{#each market_scenarios}}
{{#each influential_comparables}}
- {{../use_label}} 最具影響可比：{{transaction_month}}・{{district}} {{address_or_road}}・{{floor}} 樓・{{total_area_ping}} 坪・{{total_price_wan}} 萬・車位 {{parking_evidence}}・距離 {{distance_min_m}}–{{distance_max_m}} 公尺・{{imputation_label}}・[內政部查詢](https://lvr.land.moi.gov.tw/)
{{/each}}
{{/each}}

- 房貸 {{monthly_mortgage}}・月租 ~{{estimated_rent}}（參考）・現金流 ~{{monthly_cash_flow}}/月（參考）
{{#if scenario_requires_review}}

- 需人工確認：{{scenario_manual_review_reason}}

{{/if}}
- 覆核：{{valuation_review_line}}
- 需人工確認：{{manual_checks}}

{{/each}}

{{else}}

- 無價格接近、用途待確認或需人工複核的候選。

{{/if}}

### ⚠️ 可疑/待查

{{#if suspicious}}

{{#each suspicious}}

#### {{rank}}. [{{title}}]({{url}}) ｜ `{{suspicious_label}}`

- {{tenure_line}}
- 命中訊號：{{suspicious_signals}}
- 登記用途 {{registered_use_value}}（來源 {{registered_use_source}}・{{registered_use_detail}}）

| 登記用途情境 | 建物單價 P25／P50／P75 | 含車位總價 P25／P50／P75 | A／B／C 筆數 | 狀態 | 判斷 |
|---|---:|---:|---:|---|---|
{{#each market_scenarios}}
| {{use_label}} | {{building_p25_wan}}／{{building_p50_wan}}／{{building_p75_wan}} 萬/坪 | {{bundle_p25_wan}}／{{bundle_p50_wan}}／{{bundle_p75_wan}} 萬 | {{grade_a_count}}／{{grade_b_count}}／{{grade_c_count}} | {{scenario_status_summary}} | {{scenario_judgment}} |
{{/each}}

{{#each market_scenarios}}
{{#each influential_comparables}}
- {{../use_label}} 最具影響可比：{{transaction_month}}・{{district}} {{address_or_road}}・{{floor}} 樓・{{total_area_ping}} 坪・{{total_price_wan}} 萬・車位 {{parking_evidence}}・距離 {{distance_min_m}}–{{distance_max_m}} 公尺・{{imputation_label}}・[內政部查詢](https://lvr.land.moi.gov.tw/)
{{/each}}
{{/each}}

{{#if scenario_requires_review}}

- 需人工確認：{{scenario_manual_review_reason}}

{{/if}}
- 覆核：{{valuation_review_line}}
- 理由：{{suspicious_reason}}（信心：{{suspicious_confidence}}・{{detail_page_checked}}）

{{/each}}

{{else}}

- 無 agent 標記為可疑/待查的物件。

{{/if}}

### 目標日排除物件

{{#if excluded}}

{{#each excluded}}

#### {{rank}}. [{{title}}]({{url}})

- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・開價溢價 {{premium_percent}}%
- {{tenure_line}}
- 登記用途 {{registered_use_value}}（來源 {{registered_use_source}}・{{registered_use_detail}}）

| 登記用途情境 | 建物單價 P25／P50／P75 | 含車位總價 P25／P50／P75 | A／B／C 筆數 | 狀態 | 判斷 |
|---|---:|---:|---:|---|---|
{{#each market_scenarios}}
| {{use_label}} | {{building_p25_wan}}／{{building_p50_wan}}／{{building_p75_wan}} 萬/坪 | {{bundle_p25_wan}}／{{bundle_p50_wan}}／{{bundle_p75_wan}} 萬 | {{grade_a_count}}／{{grade_b_count}}／{{grade_c_count}} | {{scenario_status_summary}} | {{scenario_judgment}} |
{{/each}}

{{#each market_scenarios}}
{{#each influential_comparables}}
- {{../use_label}} 最具影響可比：{{transaction_month}}・{{district}} {{address_or_road}}・{{floor}} 樓・{{total_area_ping}} 坪・{{total_price_wan}} 萬・車位 {{parking_evidence}}・距離 {{distance_min_m}}–{{distance_max_m}} 公尺・{{imputation_label}}・[內政部查詢](https://lvr.land.moi.gov.tw/)
{{/each}}
{{/each}}

{{#if scenario_requires_review}}

- 需人工確認：{{scenario_manual_review_reason}}

{{/if}}
- 覆核：{{valuation_review_line}}
- 排除：{{exclusion_reason}}

{{/each}}

{{else}}

- 目標日無需列出的排除物件。

{{/if}}

### 需要人工確認

- 實際可租金額與出租天數
- 屋況、漏水、頂樓防水、修繕成本
- 貸款成數、銀行估價、利率條件
- 是否有增建、頂加、權狀或用途問題
- 登記用途／使用執照、貸款、稅務與轉售風險（用途未知或條件式推薦必列）
- 實價登錄可比物件是否足夠接近

### 規則來源

- 共用通知規則見 `docs/reporting-rules.md`；投資門檻、排序與模板細節見 `profiles/example-investment/evaluation.md`。
