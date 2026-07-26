## iBigFun 每日自住房源監測（範例） - {{date}}

**結論：{{conclusion}}**

### 快速摘要

- Profile：owner-occupied
- 新刊登物件：{{new_listing_count}} 筆
- 符合條件：{{matched_count}} 筆
- 候選/需確認：{{candidate_count}} 筆
- 排除：{{excluded_count}} 筆
- 官方行情｜可靠：{{market_reliable_count}} 筆・待覆核：{{market_review_count}} 筆・不可用：{{market_unavailable_count}} 筆・資料偏舊：{{market_stale_count}} 筆
- 主要排除原因：{{main_exclusion_reasons}}
- Filter 對照狀態：{{filter_verification_status}}
- 自住條件：總價 <= 8000 萬、類型 電梯大樓（house_type=17）、7 樓以上、主建物 >= 30 坪、屋齡 <= 25 年、平面車位

### 符合條件

{{#if matched}}

{{#each matched}}

#### {{rank}}. [{{title}}]({{url}}) ｜ {{match_summary}}

- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
- 行情狀態 {{market_status}}｜官方中位 {{market_median_wan}} 萬/坪（P25–P75 {{market_p25_wan}}–{{market_p75_wan}}）・信心 {{market_confidence}}・可比 {{comparable_count}} 筆・階段 {{selected_stage}}・官方資料 {{official_source_date}}（{{market_freshness}}）
{{#if market_requires_review}}

- 需人工確認：{{market_manual_review_reason}}

{{/if}}
- 覆核：{{valuation_review_line}}
- 亮點：{{strengths}}
- 需確認：{{manual_checks}}

{{/each}}

{{else}}

- 無符合自住條件且值得立即查看的物件。

{{/if}}

### 候選/需確認

{{#if candidates}}

{{#each candidates}}

#### {{rank}}. [{{title}}]({{url}}) ｜ {{candidate_reason}}

- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
- 行情狀態 {{market_status}}｜官方中位 {{market_median_wan}} 萬/坪（P25–P75 {{market_p25_wan}}–{{market_p75_wan}}）・信心 {{market_confidence}}・可比 {{comparable_count}} 筆・階段 {{selected_stage}}・官方資料 {{official_source_date}}（{{market_freshness}}）
{{#if market_requires_review}}

- 需人工確認：{{market_manual_review_reason}}

{{/if}}
- 覆核：{{valuation_review_line}}
- 需確認：{{manual_checks}}

{{/each}}

{{else}}

- 無候選物件。

{{/if}}

### 排除摘要

- 排除筆數：{{excluded_count}} 筆
- 主要原因：{{main_exclusion_reasons}}

### 規則來源

- Profile config：`profile.json`
- Profile rules：`evaluation.md`
- 共通規則：`docs/reporting-rules.md`
