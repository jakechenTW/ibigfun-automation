## iBigFun 每日投資房源監測 - {{date}}

**結論：{{conclusion}}**

### 快速摘要

- 新刊登物件：{{new_listing_count}} 筆
- iBigFun 查詢：[開啟目標日篩選](https://www.ibigfun.com/lists/latest?page=1&expand=0&method=all_case&on_market=1&city=1&price_segment=%2C2500&floor_segment=2%2C4&total_floor=%2C5&add_date={{date}}&add_date_max={{date}})
- 前置排除：{{hard_excluded_count}} 筆
- 推薦物件：{{recommended_count}} 筆
- 接近門檻：{{near_threshold_count}} 筆
- 目標日排除：{{excluded_count}} 筆
- 可疑/待查：{{suspicious_count}} 筆
- 主要排除原因：{{main_exclusion_reasons}}
- 房貸假設：8 成貸、年利率 2.6%、30 年本息平均攤還
- 推薦門檻：`低於行情 >= 10%` 且 `租金覆蓋率 >= 1.0`
- 接近門檻：`租金覆蓋率 >= 0.8`
- 前置排除：明確離捷運超過 800 公尺(客觀硬排除)
- 可疑/待查：法拍/資訊過少/無室內圖等由 agent 軟標記,降權但不自動移除

### 前置排除

{{#if hard_excluded}}

{{#each hard_excluded}}

#### {{rank}}. [{{title}}]({{url}})

- 狀態：`前置排除`
- 地址/區域：{{address_or_area}}
- 刊登日：{{published_date}}
- 排除原因：{{hard_exclusion_reason}}
- 證據：{{hard_exclusion_evidence}}

{{/each}}

{{else}}

- 無明確符合前置排除條件的物件。捷運距離看不出來者不以前置排除處理。

{{/if}}

### 推薦物件

{{#if recommended}}

{{#each recommended}}

#### {{rank}}. [{{title}}]({{url}})

- 狀態：`推薦`
- 地址/區域：{{address_or_area}}
- 刊登日：{{published_date}}
- 總價：{{price}} 萬
- 坪數 / 單價：{{ping}} 坪 / {{unit_price}} 萬/坪
- 樓層 / 總樓層：{{floor}} / {{total_floor}}
- 推估區域行情：{{market_unit_price}} 萬/坪
- 低估幅度：{{discount_percent}}%
- 預估月租金：{{estimated_rent}} 元
- 月房貸本利和：{{monthly_mortgage}} 元
- 租金覆蓋率：{{rent_coverage}}
- 現金流估算：{{monthly_cash_flow}} 元/月
- 推薦理由：{{recommendation_reason}}
- 主要風險：{{risks_or_manual_checks}}

{{/each}}

{{else}}

- 無符合 `低於行情 >= 10%` 且 `租金覆蓋率 >= 1.0` 的物件。

{{/if}}

### 接近門檻候選

{{#if near_threshold}}

{{#each near_threshold}}

#### {{rank}}. [{{title}}]({{url}})

- 狀態：`接近門檻`
- 地址/區域：{{address_or_area}}
- 刊登日：{{published_date}}
- 總價：{{price}} 萬
- 坪數 / 單價：{{ping}} 坪 / {{unit_price}} 萬/坪
- 樓層 / 總樓層：{{floor}} / {{total_floor}}
- 推估區域行情：{{market_unit_price}} 萬/坪
- 低估幅度：{{discount_percent}}%
- 預估月租金：{{estimated_rent}} 元
- 月房貸本利和：{{monthly_mortgage}} 元
- 租金覆蓋率：{{rent_coverage}}
- 差一點的原因：{{near_threshold_reason}}
- 需要人工確認：{{manual_checks}}

{{/each}}

{{else}}

- 無租金覆蓋率達 `0.8` 的接近門檻候選。

{{/if}}

### ⚠️ 可疑/待查

{{#if suspicious}}

{{#each suspicious}}

#### {{rank}}. [{{title}}]({{url}})

- 標記：`{{suspicious_label}}`  （clean / suspicious / likely-auction）
- 地址/區域：{{address_or_area}}
- 刊登日：{{published_date}}
- 命中訊號：{{suspicious_signals}}
- 是否點進詳情頁查證：{{detail_page_checked}}
- 理由與信心：{{suspicious_reason}}（信心：{{suspicious_confidence}}）

{{/each}}

{{else}}

- 無 agent 標記為可疑/待查的物件。

{{/if}}

### 目標日排除物件

{{#if excluded}}

{{#each excluded}}

#### {{rank}}. [{{title}}]({{url}})

- 狀態：`排除`
- 地址/區域：{{address_or_area}}
- 刊登日：{{published_date}}
- 關鍵數字：總價 {{price}} 萬、{{ping}} 坪、{{unit_price}} 萬/坪、租金覆蓋率 {{rent_coverage}}
- 行情比較：推估行情 {{market_unit_price}} 萬/坪，低估幅度 {{discount_percent}}%
- 現金流估算：{{monthly_cash_flow}} 元/月
- 排除原因：{{exclusion_reason}}
- 需人工確認：{{manual_checks}}

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

- 投資門檻、排序與通知格式規則見 `docs/reporting-rules.md`。
