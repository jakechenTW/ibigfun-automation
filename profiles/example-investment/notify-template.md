## iBigFun 每日投資房源監測（範例） - {{date}}

**結論：{{conclusion}}**

### 快速摘要

- 新刊登物件：{{new_listing_count}} 筆
- iBigFun 查詢：[開啟目標日篩選](https://www.ibigfun.com/lists/latest?page=1&expand=0&method=all_case&on_market=1&city=1&price_segment=%2C2500&floor_segment=2%2C4&total_floor=%2C5&add_date={{date}}&add_date_max={{date}})
- 區域閘門｜目標捷運站外：{{out_of_region_count}} 筆・站內走路過遠：{{in_region_too_far_count}} 筆・待人工確認：{{manual_review_count}} 筆
- 推薦物件：{{recommended_count}} 筆
- 接近門檻：{{near_threshold_count}} 筆
- 目標日排除：{{excluded_count}} 筆
- 可疑/待查：{{suspicious_count}} 筆
- 主要排除原因：{{main_exclusion_reasons}}
- 房貸假設：8 成貸、年利率 2.6%、30 年本息平均攤還
- 推薦門檻：`開價溢價 ≤ 該市 p*/2`（`p*` 由議價率換算，見 `data/negotiation-rate.md`）
- 接近門檻：`p*/2 < 開價溢價 ≤ p*`
- 排除：`開價溢價 > p*`；可疑/待查：`開價溢價 ≤ −10%`（異常低）或法拍/資訊過少等軟標記
- 區域閘門：最近捷運站不在目標白名單（目標捷運站外）或白名單站但可靠步行 >10 分（站內走路過遠）即排除，只計數不逐列（見 `data/region-allowlist.md`）
- 可疑/待查：法拍／資訊過少／無室內圖等由 agent 軟標記,降權但不自動移除

### 推薦物件

{{#if recommended}}

{{#each recommended}}

#### {{rank}}. [{{title}}]({{url}}) ｜ 開價溢價 {{premium_percent}}%

- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 行情 {{market_unit_price}} 萬/坪・房貸 {{monthly_mortgage}}・月租 ~{{estimated_rent}}（參考）・現金流 ~{{monthly_cash_flow}}/月（參考）
- 推薦理由：{{recommendation_reason}}
- 風險：{{risks_or_manual_checks}}

{{/each}}

{{else}}

- 無符合 `開價溢價 ≤ p*/2` 的推薦物件。

{{/if}}

### 接近門檻候選

{{#if near_threshold}}

{{#each near_threshold}}

#### {{rank}}. [{{title}}]({{url}}) ｜ 開價溢價 {{premium_percent}}%・差在 {{near_threshold_reason}}

- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 行情 {{market_unit_price}} 萬/坪・房貸 {{monthly_mortgage}}・月租 ~{{estimated_rent}}（參考）・現金流 ~{{monthly_cash_flow}}/月（參考）
- 需人工確認：{{manual_checks}}

{{/each}}

{{else}}

- 無 `p*/2 < 開價溢價 ≤ p*` 的接近門檻候選。

{{/if}}

### ⚠️ 可疑/待查

{{#if suspicious}}

{{#each suspicious}}

#### {{rank}}. [{{title}}]({{url}}) ｜ `{{suspicious_label}}`

- {{tenure_line}}
- 命中訊號：{{suspicious_signals}}
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
