## {{status_icon}} {{date}} 自住房源｜{{headline}}

{{conclusion}}

**新案 {{new_listing_count}}｜符合 {{matched_count}}｜候選 {{candidate_count}}｜風險 {{risk_count}}｜排除 {{excluded_count}}**

{{#if data_warning}}

> ⚠️ {{data_warning}}

{{/if}}

### 符合條件

{{#if matched}}

{{#each matched}}

#### {{rank}}. [{{title}}]({{url}})

- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
- {{walk_line}}
- {{tenure_line}}
- {{market_summary_line}}
{{#if valuation_review_line}}
- 覆核：{{valuation_review_line}}
{{/if}}
- 符合：{{strengths}}
- 下一步：{{manual_checks}}

{{/each}}

{{else}}

- 今日無符合條件的物件。

{{/if}}

### 候選／資料待確認

{{#if candidates}}

{{#each candidates}}

#### {{rank}}. [{{title}}]({{url}})

- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
- {{walk_line}}
- {{tenure_line}}
- {{market_summary_line}}
{{#if valuation_review_line}}
- 覆核：{{valuation_review_line}}
{{/if}}
- 下一步：{{manual_checks}}

{{/each}}

{{else}}

- 今日無候選物件。

{{/if}}

### ⚠️ 風險物件／待查

{{#if risks}}

{{#each risks}}

#### {{rank}}. [{{title}}]({{url}}) ｜ `{{risk_label}}`

- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
- {{walk_line}}
- {{tenure_line}}
- {{market_summary_line}}
{{#if valuation_review_line}}
- 覆核：{{valuation_review_line}}
{{/if}}
- 風險：{{risk_reason}}（{{risk_confidence}}・{{detail_page_checked}}）

{{/each}}

{{else}}

- 今日無風險物件。

{{/if}}

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
