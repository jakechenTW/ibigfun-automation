## iBigFun 每日投資房源監測（範例） - {{date}}

**結論：{{conclusion}}**

### 快速摘要

- 新刊登物件：{{new_listing_count}} 筆
- iBigFun 查詢：[開啟目標日篩選](https://www.ibigfun.com/lists/latest?page=1&expand=0&method=all_case&on_market=1&city=1&price_segment=%2C3000&floor_segment=2%2C4&total_floor=%2C5&add_date={{date}}&add_date_max={{date}})
- 區域閘門｜目標捷運站外：{{out_of_region_count}} 筆・站內走路過遠：{{in_region_too_far_count}} 筆・待人工確認：{{manual_review_count}} 筆
- 刊登年限｜超過上限：{{tenure_expired_count}} 筆・待確認：{{tenure_review_count}} 筆
- 推薦物件：{{recommended_count}} 筆
- 候選／資料待確認：{{candidate_count}} 筆
- 風險物件／待查：{{suspicious_count}} 筆
- 排除物件：{{excluded_count}} 筆
- 官方行情｜可靠：{{market_reliable_count}} 筆・待覆核：{{market_review_count}} 筆・不可用：{{market_unavailable_count}} 筆・資料偏舊：{{market_stale_count}} 筆
- 主要排除原因：{{main_exclusion_reasons}}
- 房貸假設：8 成貸、年利率 2.6%、30 年本息平均攤還
- 刊登年限：`expired` 排除；`review` 的乾淨物件只進候選；已驗證風險優先進風險桶
- 區域閘門：最近捷運站不在目標白名單（目標捷運站外）或白名單站但可靠步行 >10 分（站內走路過遠）即排除，只計數不逐列（見 `data/region-allowlist.md`）
- 風險物件／待查：法拍／資訊過少／無室內圖／重大產權或用途疑點由 agent 標記並說明

### 推薦物件

{{#if recommended}}

{{#each recommended}}

#### {{rank}}. [{{title}}]({{url}})

- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 行情狀態 {{market_status}}｜官方中位 {{market_median_wan}} 萬/坪（P25–P75 {{market_p25_wan}}–{{market_p75_wan}}）・信心 {{market_confidence}}・可比 {{comparable_count}} 筆・階段 {{selected_stage}}・官方資料 {{official_source_date}}（{{market_freshness}}）
- 房貸 {{monthly_mortgage}}・月租 ~{{estimated_rent}}（參考）・現金流 ~{{monthly_cash_flow}}/月（參考）
{{#if market_requires_review}}

- 需人工確認：{{market_manual_review_reason}}

{{/if}}
- 覆核：{{valuation_review_line}}
- 推薦理由：{{recommendation_reason}}
- 風險：{{risks_or_manual_checks}}

{{/each}}

{{else}}

- 無同時通過刊登年限、區域／走路、官方行情及資料品質條件的推薦物件。

{{/if}}

### 候選／資料待確認

{{#if candidates}}

{{#each candidates}}

#### {{rank}}. [{{title}}]({{url}}) ｜ {{candidate_reason}}

- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 行情狀態 {{market_status}}｜官方中位 {{market_median_wan}} 萬/坪（P25–P75 {{market_p25_wan}}–{{market_p75_wan}}）・信心 {{market_confidence}}・可比 {{comparable_count}} 筆・階段 {{selected_stage}}・官方資料 {{official_source_date}}（{{market_freshness}}）
- 房貸 {{monthly_mortgage}}・月租 ~{{estimated_rent}}（參考）・現金流 ~{{monthly_cash_flow}}/月（參考）
{{#if market_requires_review}}

- 需人工確認：{{market_manual_review_reason}}

{{/if}}
- 覆核：{{valuation_review_line}}
- 需人工確認：{{manual_checks}}

{{/each}}

{{else}}

- 無只差可解決資料不確定的候選物件。

{{/if}}

### ⚠️ 風險物件／待查

{{#if suspicious}}

{{#each suspicious}}

#### {{rank}}. [{{title}}]({{url}}) ｜ `{{suspicious_label}}`

- {{tenure_line}}
- 命中訊號：{{suspicious_signals}}
- 行情狀態 {{market_status}}｜官方中位 {{market_median_wan}} 萬/坪（P25–P75 {{market_p25_wan}}–{{market_p75_wan}}）・信心 {{market_confidence}}・可比 {{comparable_count}} 筆・階段 {{selected_stage}}・官方資料 {{official_source_date}}（{{market_freshness}}）
{{#if market_requires_review}}

- 需人工確認：{{market_manual_review_reason}}

{{/if}}
- 覆核：{{valuation_review_line}}
- 理由：{{suspicious_reason}}（信心：{{suspicious_confidence}}・{{detail_page_checked}}）

{{/each}}

{{else}}

- 無 agent 標記為風險／待查的物件。

{{/if}}

### 排除物件

{{#if excluded}}

{{#each excluded}}

#### {{rank}}. [{{title}}]({{url}})

- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪
- {{tenure_line}}
- 行情狀態 {{market_status}}｜官方中位 {{market_median_wan}} 萬/坪（P25–P75 {{market_p25_wan}}–{{market_p75_wan}}）・信心 {{market_confidence}}・可比 {{comparable_count}} 筆・階段 {{selected_stage}}・官方資料 {{official_source_date}}（{{market_freshness}}）
{{#if market_requires_review}}

- 需人工確認：{{market_manual_review_reason}}

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
- 實價登錄可比物件是否足夠接近

### 規則來源

- 共用通知規則見 `docs/reporting-rules.md`；投資門檻、排序與模板細節見 `profiles/example-investment/evaluation.md`。
