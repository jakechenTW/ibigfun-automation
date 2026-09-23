{{conclusion}}

本次取得 {{fetched_listing_count}}｜推薦 {{recommended_count}}｜候選 {{candidate_count}}｜風險 {{suspicious_count}}｜排除 {{excluded_count}}

{{#if data_warning}}

> ⚠️ {{data_warning}}

{{/if}}

{{#if recommended}}

### 推薦物件

{{#each recommended}}

#### {{rank}}. [{{title}}]({{url}})

- 推薦：{{recommendation_reason}}
{{#if risks_or_manual_checks}}
- 注意：{{risks_or_manual_checks}}
{{/if}}
- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
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
- {{walk_line}}
- {{tenure_line}}
- {{market_summary_line}}
{{#if valuation_review_line}}
- 覆核：{{valuation_review_line}}
{{/if}}

{{/each}}

{{/if}}

{{#if suspicious}}

### ⚠️ 風險物件／待查

{{#each suspicious}}

#### {{rank}}. [{{title}}]({{url}}) ｜ `{{suspicious_label}}`

- 風險：{{suspicious_reason}}（{{suspicious_confidence}}・{{detail_page_checked}}）
- {{price}} 萬・{{ping}} 坪・{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
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

{{#if out_of_region_count}}
- 目標捷運站外：{{out_of_region_count}} 筆
{{/if}}
{{#if in_region_too_far_count}}
- 站內走路過遠：{{in_region_too_far_count}} 筆
{{/if}}
{{#if tenure_expired_count}}
- 刊登超過上限：{{tenure_expired_count}} 筆
{{/if}}
{{#if other_hard_exclusion_count}}
- 其他硬性排除：{{other_hard_exclusion_count}} 筆
{{/if}}
{{#if main_exclusion_reasons}}
- 主要原因：{{main_exclusion_reasons}}
{{/if}}

{{/if}}
