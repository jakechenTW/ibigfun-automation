## iBigFun 每日自住房源監測 - {{date}}

**結論：{{conclusion}}**

### 快速摘要

- Profile：owner-occupied
- 新刊登物件：{{new_listing_count}} 筆
- 符合條件：{{matched_count}} 筆
- 候選/需確認：{{candidate_count}} 筆
- 排除：{{excluded_count}} 筆
- 主要排除原因：{{main_exclusion_reasons}}
- Filter 對照狀態：{{filter_verification_status}}
- 自住條件：總價 <= 7000 萬、類型 電梯大樓（house_type=17）、7 樓以上、主建物 >= 30 坪、屋齡 <= 25 年、平面車位

### 符合條件

{{#if matched}}

{{#each matched}}

#### {{rank}}. [{{title}}]({{url}}) ｜ {{match_summary}}

- {{walk_line}}
- {{tenure_line}}
- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・{{floor}}/{{total_floor}} 樓・屋齡 {{age}}・{{address_or_area}}
- 格局 {{room}}房{{living_room}}廳{{bathroom}}衛・車位 {{parking}}・類型 {{type_layout}}
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
