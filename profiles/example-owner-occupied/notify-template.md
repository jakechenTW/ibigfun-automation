## iBigFun 每日自住房源監測（範例） - {{date}}

**結論：{{conclusion}}**

### 快速摘要

- Profile：owner-occupied
- 新刊登物件：{{new_listing_count}} 筆
- 符合條件：{{matched_count}} 筆
- 候選/需確認：{{candidate_count}} 筆
- 排除：{{excluded_count}} 筆
- 用途情境決策｜條件式符合：{{conditional_matched_count}} 筆・用途待確認：{{use_confirmation_count}} 筆・人工複核：{{scenario_manual_review_count}} 筆
- 相容行情稽核（非分桶權威）｜可靠：{{market_reliable_count}} 筆・待覆核：{{market_review_count}} 筆・不可用：{{market_unavailable_count}} 筆・資料偏舊：{{market_stale_count}} 筆
- 主要排除原因：{{main_exclusion_reasons}}
- Filter 對照狀態：{{filter_verification_status}}
- 自住條件：總價 <= 8000 萬、類型 電梯大樓（house_type=17）、7 樓以上、主建物 >= 30 坪、屋齡 <= 25 年、平面車位
- 用途門檻：已驗證用途取 accepted 同用途情境；用途未知須至少兩個 accepted 情境（必含住宅）
  全部有可用 P25／含車位總價且無 diagnostic 或 bundle 衝突，才可標「條件式符合（用途未確認）」
- 實價連結：逐筆 `[內政部查詢]` 只開啟查詢服務入口，須以列示條件定位，並非精確交易列直連

### 符合條件

{{#if matched}}

{{#each matched}}

#### {{rank}}. [{{title}}]({{url}}) ｜ {{match_summary}}・{{use_decision_label}}

- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
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
{{#if use_requires_confirmation}}

- 用途風險確認：合法登記用途／使用執照相容性、貸款與鑑價、稅務、轉售與市場性

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

#### {{rank}}. [{{title}}]({{url}}) ｜ {{candidate_reason}}・{{use_decision_label}}

- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
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
{{#if use_requires_confirmation}}

- 用途風險確認：合法登記用途／使用執照相容性、貸款與鑑價、稅務、轉售與市場性

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
- 用途未知的候選須確認：合法登記用途／使用執照相容性、貸款與鑑價、稅務、轉售與市場性風險

### 規則來源

- Profile config：`profile.json`
- Profile rules：`evaluation.md`
- 共通規則：`docs/reporting-rules.md`
