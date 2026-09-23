{{conclusion}}

本次取得 {{fetched_listing_count}}｜符合 {{matched_count}}｜候選 {{candidate_count}}｜風險 {{risk_count}}｜排除 {{excluded_count}}

{{#if data_warning}}

> ⚠️ {{data_warning}}

{{/if}}

{{#if matched}}

### 符合條件

{{#each matched}}

#### {{rank}}. [{{title}}]({{url}})

- 符合：{{strengths}}
- 下一步：{{manual_checks}}
- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
- {{walk_line}}
- {{tenure_line}}
- {{market_summary_line}}
{{#if valuation_review_line}}
- 覆核：{{valuation_review_line}}
{{/if}}

{{/each}}

{{/if}}

{{#if candidates}}

### 候選／資料待確認

{{#each candidates}}

#### {{rank}}. [{{title}}]({{url}})

- 下一步：{{manual_checks}}
- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
- {{walk_line}}
- {{tenure_line}}
- {{market_summary_line}}
{{#if valuation_review_line}}
- 覆核：{{valuation_review_line}}
{{/if}}

{{/each}}

{{/if}}

{{#if risks}}

### ⚠️ 風險物件／待查

{{#each risks}}

#### {{rank}}. [{{title}}]({{url}}) ｜ `{{risk_label}}`

- 風險：{{risk_reason}}（{{risk_confidence}}・{{detail_page_checked}}）
- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
- {{walk_line}}
- {{tenure_line}}
- {{market_summary_line}}
{{#if valuation_review_line}}
- 覆核：{{valuation_review_line}}
{{/if}}

{{/each}}

{{/if}}

{{#if excluded_count}}

### 排除摘要

{{#if tenure_expired_count}}
- 刊登超過上限：{{tenure_expired_count}} 筆
{{/if}}
{{#if hard_criteria_excluded_count}}
- 自住硬性條件不符：{{hard_criteria_excluded_count}} 筆
{{/if}}
{{#if other_hard_exclusion_count}}
- 其他硬性排除：{{other_hard_exclusion_count}} 筆
{{/if}}
{{#if main_exclusion_reasons}}
- 主要原因：{{main_exclusion_reasons}}
{{/if}}

{{/if}}
