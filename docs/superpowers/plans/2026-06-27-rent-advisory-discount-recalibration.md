# 租金降為參考 + 開價溢價門檻重構 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 investment profile 的篩選改為以「開價溢價」把關（門檻錨定各市議價率）、把租金降為純參考、並把「行情」錨定到好時價 AVM（限邊界物件）。

**Architecture:** 純文件 + 一張新參考表的改動。篩選與估算邏輯本就在 agent 端（docs/規則），不在程式碼；fetch/enrich 不變。唯一的程式檔 `scripts/lib/finance.ts` 只改註解。好時價為 agent 端互動查詢（無公開 API），不進無頭管線。

**Tech Stack:** Markdown 文件、TypeScript（僅 `finance.ts` 註解）、Node test runner（`npm test`）。

## Global Constraints

- 指標定義（逐字）：`開價溢價 = (物件開價單價 − 成交行情單價) / 成交行情單價 * 100`；`典型溢價 p* = r / (1 − r)`，`r` = 各市成交議價率（永慶定義，分母為開價）。
- 分桶門檻（逐字）：推薦 `−10% < 溢價 ≤ p*/2`；接近 `p*/2 < 溢價 ≤ p*`；排除 `溢價 > p*`；可疑/待查含 `溢價 ≤ −10%`；前置排除＝可靠步行 >10 分（不變）。
- 排序（逐字）：推薦／接近／排除三桶一律按開價溢價**由低到高**，次鍵總價低者優先。
- 議價率種子（永慶 2025 Q3／2025-09，來源 `https://estate.ltn.com.tw/article/25718`）：台北 14.0、台南 12.4、新北 12.2、高雄 11.8、桃園 10.8、新竹 10.8、台中 10.7（%）。
- 租金：純參考，**永不影響分桶或排序**；顯示 `月租 ~X（參考·低信心）` 與 `現金流 ~Y/月（參考）`，**拿掉覆蓋率**。
- 行情來源優先序：① 好時價 AVM（邊界物件、agent 端互動查詢、MAPE≈8–10% 當信心帶）② 實價登錄／樂居可比成交 ③ 僅弱/過期資料則不可標推薦。
- 不改 fetch/enrich 程式邏輯；不建租金資料集；不逆向好時價 endpoint、不做全量瀏覽器自動化、不串接好時價官方 API（無）。
- 規格來源：`docs/superpowers/specs/2026-06-27-rent-advisory-discount-recalibration-design.md`。
- 提交訊息結尾須含：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

> **關於測試：** 本計畫無程式邏輯改動（`finance.ts` 僅改註解），故不新增自動化測試（spec 明訂零新測試）。每個任務的驗收以「文件內容正確一致」為主；最後一個任務跑 `npm test` 確認既有測試（含 `finance.test.ts`）維持綠燈，並提供一次實跑報表的人工驗收清單。

---

### Task 1: 議價率參考表 + data/README 說明

**Files:**
- Create: `data/negotiation-rate.md`
- Modify: `data/README.md`（在 `## taipei_mrt_exits.csv` 段落之後新增一段）

**Interfaces:**
- Consumes: 無（本任務是後續所有溢價門檻引用的基礎資料）。
- Produces: 檔案 `data/negotiation-rate.md`，含欄位 `city / rate / p* / source_quarter / source_url` 與換算公式 `p* = r/(1−r)`；供 `docs/reporting-rules.md`、`docs/profiles/investment.md`、模板引用。

- [ ] **Step 1: 建立 `data/negotiation-rate.md`**

完整內容如下（`p*` 已由 `r/(1−r)` 算好並四捨五入到小數一位）：

```markdown
# 各縣市成交議價率（議價空間）參考表

investment profile 用此表把「開價」校準到「成交行情」，計算開價溢價門檻。
詳見 `docs/reporting-rules.md`（開價溢價 / Calculations）與 `docs/profiles/investment.md`。

## 換算公式

- 成交議價率 `r`（永慶定義，分母為開價）：`r = (開價 − 成交) / 開價`。
- 典型開價溢價 `p*`（相對成交，供溢價門檻使用）：`p* = r / (1 − r)`。
- 推薦門檻 `溢價 ≤ p*/2`、接近門檻上界 `溢價 ≤ p*`（見 investment profile）。

## 維護

- 來源：永慶房屋每季公布的七都成交議價率（中古屋）。
- 每季永慶季報公布後手動更新 `rate` 與 `source_quarter`，比照 `data/taipei_mrt_exits.csv` 的手動刷新模式。
- `source_quarter` 超過 2 季未更新時，報表快速摘要標註「議價率資料偏舊」。
- 表中無對應縣市時，agent 退而使用最接近的都會區或全國概值，並於該物件註記。
- investment profile 目前只抓台北市（city=1），故台北列為主要使用列；其餘列為其他都會區預留。

## 參考表

| city | rate (%) | p* (%) | source_quarter | source_url |
|---|---|---|---|---|
| 台北市 | 14.0 | 16.3 | 2025Q3 | https://estate.ltn.com.tw/article/25718 |
| 台南市 | 12.4 | 14.2 | 2025Q3 | https://estate.ltn.com.tw/article/25718 |
| 新北市 | 12.2 | 13.9 | 2025Q3 | https://estate.ltn.com.tw/article/25718 |
| 高雄市 | 11.8 | 13.4 | 2025Q3 | https://estate.ltn.com.tw/article/25718 |
| 桃園市 | 10.8 | 12.1 | 2025Q3 | https://estate.ltn.com.tw/article/25718 |
| 新竹縣市 | 10.8 | 12.1 | 2025Q3 | https://estate.ltn.com.tw/article/25718 |
| 台中市 | 10.7 | 12.0 | 2025Q3 | https://estate.ltn.com.tw/article/25718 |
```

- [ ] **Step 2: 在 `data/README.md` 新增說明段落**

在 `## taipei_mrt_exits.csv` 整段（到其 Distance rules 結尾）之後，插入：

```markdown
## `negotiation-rate.md`

各縣市成交議價率（中古屋）參考表，investment profile 用來把開價校準到成交行情、
計算開價溢價門檻。每市一列，附 `p* = r/(1−r)` 換算與來源季別。資料來自永慶房屋
每季公布的七都成交議價率，每季手動更新。詳見該檔檔頭與 `docs/reporting-rules.md`。
```

- [ ] **Step 3: 驗證內容**

Run: `grep -E "台北市 \| 14.0 \| 16.3" data/negotiation-rate.md && grep "negotiation-rate.md" data/README.md`
Expected: 兩個 grep 都各印出一行（種子表第一列與 README 新段落標題都存在）。

- [ ] **Step 4: 提交**

```bash
git add data/negotiation-rate.md data/README.md
git commit -m "feat(data): add per-city 議價率 reference table (2025Q3 seed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: reporting-rules.md — 開價溢價、行情估算、租金參考化

**Files:**
- Modify: `docs/reporting-rules.md`（`## Calculations` 段、`## Market Price & Rent Estimation` 段）

**Interfaces:**
- Consumes: `data/negotiation-rate.md`（Task 1）。
- Produces: 共用計算與估算規則——開價溢價公式、`p*` 換算、行情來源優先序（好時價邊界物件 + MAPE 信心帶）、租金參考化。供 `docs/profiles/investment.md` 與模板引用。

- [ ] **Step 1: 取代 `## Calculations` 段**

把現有 `## Calculations` 區塊（從 `## Calculations` 到 `...30-year principal and interest repayment.` 那幾條 bullet）整段換成：

```markdown
## Calculations

- 開價溢價（asking premium）須用：`(物件開價單價 − 成交行情單價) / 成交行情單價 * 100`。
  正值＝開價高於成交行情（常態）；負值＝開價低於成交行情（罕見、強訊號）。
- 典型開價溢價 `p*` 由各市成交議價率 `r` 換算：`p* = r / (1 − r)`，`r` 取自
  `data/negotiation-rate.md`。
- 投資 profile 的分桶門檻（推薦 `溢價 ≤ p*/2`、接近 `p*/2 < 溢價 ≤ p*`、排除 `溢價 > p*`、
  可疑含 `溢價 ≤ −10%`）見 `docs/profiles/investment.md`。
- Monthly mortgage payment must use total price, 80% loan-to-value, 2.6% annual interest, and 30-year principal and interest repayment.
- 租金覆蓋率 `估計月租 / 月房貸` 與現金流 `月租 − 房貸` 僅供參考顯示，不參與分桶或排序
  （見下方 Rent 段）。
```

- [ ] **Step 2: 取代 `## Market Price & Rent Estimation` 整段**

把從 `## Market Price & Rent Estimation` 到其 `### Source Visibility` 子段結尾（即下一個 `## Manual Checks` 之前）整段換成：

```markdown
## Market Price (成交行情) & Premium

成交行情單價是開價溢價計算的基準。開價（iBigFun 上的委託價）系統性高於成交行情，
因此幾乎每筆物件的溢價為正；以成交行情為錨點、用各市議價率換算的 `p*` 畫門檻，
正是為了吸收這個結構性落差。

### 行情來源優先序

1. **好時價 AVM（邊界物件優先）**：對接近門檻／數字夠強值得驗證的物件，agent 以好時價
   逐址估值（單價 萬/坪 + 總價 萬）當成交行情錨點。涵蓋 19 縣市，免費，公布 MAPE ≈ 8–10%
   作為行情信心帶。只對邊界物件查，比照下方 Quality / Suspicious-Listing 開詳情頁的
   bounded 模式；不對全量物件查、不逆向其內部 endpoint、不做無頭全量自動化。
2. iBigFun 自身的實價登錄連結，或 agent 蒐集的可比成交（依面積、屋齡、樓層、型態比對）。
3. 僅有過期／弱／逾時／跨站資料時，物件**不可標 recommended**，降到接近門檻或排除並標人工確認。

### Source Visibility

每筆物件的行情估計都要在備註標明來源（好時價／實價登錄／樂居）與信心。好時價查不到的
縣市／地址退回第 2 項並註記。

## Rent (預估月租金，僅供參考)

- 租金降為純參考：只顯示 `月租 ~X（參考·低信心）` 與 `現金流 ~Y/月（參考）`
  （現金流 = 月租 − 房貸），**永不影響分桶或排序**。
- 由 agent 粗估同區同類型可比租金即可；不建租金資料集。標來源（若有）與低信心。
- 一律提醒人工確認實際可租金額與空置期。
```

- [ ] **Step 3: 驗證一致性**

Run: `grep -c "覆蓋率 >= 1.0" docs/reporting-rules.md; grep -c "開價溢價" docs/reporting-rules.md; grep -c "好時價" docs/reporting-rules.md`
Expected: 第一個為 `0`（舊覆蓋率硬門檻已不在共用規則），第二、三個 `>= 1`。

- [ ] **Step 4: 提交**

```bash
git add docs/reporting-rules.md
git commit -m "docs(rules): replace discount/rent-coverage gate with 開價溢價 + 好時價 行情

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: investment.md — Criteria / Estimation / Buckets / Notification

**Files:**
- Modify: `docs/profiles/investment.md`（`## Criteria`、`## Estimation`、`## Report Buckets`、`## Notification Format`）

**Interfaces:**
- Consumes: `docs/reporting-rules.md`（Task 2）的溢價公式、行情優先序、租金參考化；`data/negotiation-rate.md`（Task 1）。
- Produces: investment profile 的分桶門檻、估算來源、inline 指標與排序規則，供模板（Task 4）對齊。

- [ ] **Step 1: 取代 `## Criteria` 段**

```markdown
## Criteria

- Mortgage assumption: 80% loan-to-value, 2.6% annual interest, 30-year principal and interest repayment.
- 篩選主指標為**開價溢價**：`溢價 = (開價單價 − 成交行情單價) / 成交行情單價 * 100`，
  門檻錨定各市議價率換算的 `p*`（見 `data/negotiation-rate.md`，`p* = r/(1−r)`）。
- 推薦：`−10% < 溢價 ≤ p*/2` 且 走路可靠在內（`withinWalk === true` 或 triage likely-within）
  且 乾淨（非 suspicious/likely-auction）且 行情資料可靠不過期。
- 接近門檻：`p*/2 < 溢價 ≤ p*`，或溢價達推薦級但只差在行情待確認／走路待確認。
- 排除：`溢價 > p*`。
- 異常低（`溢價 ≤ −10%`）先進可疑/待查驗證，**不直接推薦**；驗證乾淨且行情可靠後依溢價歸桶。
- 硬排除（走路）：僅當 `withinWalk === false`（可靠且 >10 分），或 triage `likely-far` 且
  確定性路線 >10 分。`withinWalk === null` 不硬排除，送 triage／人工。
- 租金覆蓋率與現金流僅供參考顯示，不參與分桶或排序。
```

- [ ] **Step 2: 取代 `## Estimation` 段**

```markdown
## Estimation

- 行情：優先用好時價 AVM 逐址估值（限邊界物件），否則用實價登錄／可比成交。詳見
  `docs/reporting-rules.md`（Market Price & Premium）。
- 行情資料若僅有過期／弱／逾時／跨站來源，物件不可標推薦。
- 租金：agent 粗估同區同類型可比租金，僅供參考、不影響分桶；一律標低信心與人工確認。
```

- [ ] **Step 3: 取代 `## Report Buckets` 段**

```markdown
## Report Buckets

- `推薦物件`: `−10% < 溢價 ≤ p*/2`，走路可靠在內、乾淨、行情可靠。
- `接近門檻候選`: `p*/2 < 溢價 ≤ p*`，或溢價達推薦級但資料/走路待人工確認。
- `前置排除`: 可靠步行路線超過 10 分鐘。
- `可疑/待查`: 可疑或疑似法拍（含異常低溢價 `≤ −10%`）應降權。
- `目標日排除物件`: 其餘（含 `溢價 > p*`）值得摘要的物件。
```

- [ ] **Step 4: 更新 `## Notification Format` 段的 inline 指標與排序**

把該段中與覆蓋率／折扣／排序相關的 bullet 換成下列（其餘 bullet 如 tenure_line、compact layout 結構、`detail_page_checked` 等保持原樣）：

```markdown
- Each listing section header is `#### {rank}. [title](url)`; do not emit a `- 狀態：...` line because the section heading already names the bucket.
- Append inline metrics to the header: recommended `｜ 開價溢價 {premium_percent}%`; near-threshold `｜ 開價溢價 {premium_percent}%・差在 {near_threshold_reason}`; suspicious `｜ \`{suspicious_label}\`` where suspicious_label is `clean` / `suspicious` / `likely-auction`.
- Do not emit the old raw `刊登日` / `publishedDate` line in recommended or near-threshold listings; do emit `{{tenure_line}}` exactly as shown in the template.
- Recommended and near-threshold use the full compact layout: walk line, one tenure line `{{tenure_line}}`, one basics line `總價／坪數／單價・樓層・屋齡・地址`, one financial line `行情・房貸・月租(參考)・現金流(參考)`, then reason/risk or manual-check.
- 月租與現金流為參考欄位，標 `（參考）`；不再輸出覆蓋率。
- Pre-excluded, suspicious, and excluded listings use the shorter layouts shown in the template.
- Emit the 🚶 walk line in 前置排除, 推薦, and 接近門檻 only; do not emit it in 可疑/待查 or 目標日排除.
- If the target-date new-listing count is 10 or lower, list all excluded properties. If it is above 10, list only the 5 excluded properties closest to the threshold.
- 推薦、接近門檻、排除三桶一律按開價溢價**由低到高**排序（溢價越低越前），次鍵總價低者優先。
```

- [ ] **Step 5: 驗證一致性**

Run: `grep -c "覆蓋率" docs/profiles/investment.md; grep -c "開價溢價" docs/profiles/investment.md`
Expected: 第一個為 `2`（Criteria 末「租金覆蓋率…僅供參考」與 Notification「不再輸出覆蓋率」兩處，皆為刻意保留的「參考/移除」語句，非門檻），第二個 `>= 3`。

- [ ] **Step 6: 提交**

```bash
git add docs/profiles/investment.md
git commit -m "docs(investment): 開價溢價 buckets/thresholds; rent advisory; premium sort

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: investment-notify-template.md — 標題/財務列/門檻說明/排序/空狀態

**Files:**
- Modify: `templates/investment-notify-template.md`

**Interfaces:**
- Consumes: Task 3 的 inline 指標命名（`{{premium_percent}}`、`{{near_threshold_reason}}`、`（參考）` 標註）與排序規則。
- Produces: 報表渲染結構，供日常 agent 產報時填入。

- [ ] **Step 1: 更新頂部門檻說明（快速摘要區）**

把這兩行：

```markdown
- 推薦門檻：`低於行情 >= 10%` 且 `租金覆蓋率 >= 1.0`
- 接近門檻：`租金覆蓋率 >= 0.8`
```

換成：

```markdown
- 推薦門檻：`開價溢價 ≤ 該市 p*/2`（`p*` 由議價率換算，見 `data/negotiation-rate.md`）
- 接近門檻：`p*/2 < 開價溢價 ≤ p*`
- 排除：`開價溢價 > p*`；可疑/待查：`開價溢價 ≤ −10%`（異常低）或法拍/資訊過少等軟標記
```

（其下原有的 `- 前置排除：…` 與 `- 可疑/待查：…法拍…` 兩行保留。）

- [ ] **Step 2: 更新「推薦物件」標題列與財務列**

標題列：把
`#### {{rank}}. [{{title}}]({{url}}) ｜ 低於行情 {{discount_percent}}%・覆蓋率 {{rent_coverage}}`
換成
`#### {{rank}}. [{{title}}]({{url}}) ｜ 開價溢價 {{premium_percent}}%`

財務列：把
`- 行情 {{market_unit_price}} 萬/坪・月租 ~{{estimated_rent}}・房貸 {{monthly_mortgage}}・現金流 {{monthly_cash_flow}}/月`
換成
`- 行情 {{market_unit_price}} 萬/坪・房貸 {{monthly_mortgage}}・月租 ~{{estimated_rent}}（參考）・現金流 ~{{monthly_cash_flow}}/月（參考）`

- [ ] **Step 3: 更新「推薦物件」空狀態**

把
`- 無符合 \`低於行情 >= 10%\` 且 \`租金覆蓋率 >= 1.0\` 的物件。`
換成
`- 無符合 \`開價溢價 ≤ p*/2\` 的推薦物件。`

- [ ] **Step 4: 更新「接近門檻候選」標題列、財務列、空狀態**

標題列：把
`#### {{rank}}. [{{title}}]({{url}}) ｜ 覆蓋率 {{rent_coverage}}・差在 {{near_threshold_reason}}`
換成
`#### {{rank}}. [{{title}}]({{url}}) ｜ 開價溢價 {{premium_percent}}%・差在 {{near_threshold_reason}}`

財務列：把該區塊的
`- 行情 {{market_unit_price}} 萬/坪・月租 ~{{estimated_rent}}・房貸 {{monthly_mortgage}}・現金流 {{monthly_cash_flow}}/月`
換成
`- 行情 {{market_unit_price}} 萬/坪・房貸 {{monthly_mortgage}}・月租 ~{{estimated_rent}}（參考）・現金流 ~{{monthly_cash_flow}}/月（參考）`

空狀態：把
`- 無租金覆蓋率達 \`0.8\` 的接近門檻候選。`
換成
`- 無 \`p*/2 < 開價溢價 ≤ p*\` 的接近門檻候選。`

- [ ] **Step 5: 更新「目標日排除物件」的指標列**

把
`- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・覆蓋率 {{rent_coverage}}`
換成
`- {{price}} 萬／{{ping}} 坪／{{unit_price}} 萬/坪・開價溢價 {{premium_percent}}%`

- [ ] **Step 6: 驗證一致性**

Run: `grep -c "rent_coverage\|discount_percent\|覆蓋率\|低於行情" templates/investment-notify-template.md; grep -c "premium_percent\|開價溢價" templates/investment-notify-template.md`
Expected: 第一個為 `0`（舊指標全數移除），第二個 `>= 5`。

- [ ] **Step 7: 提交**

```bash
git add templates/investment-notify-template.md
git commit -m "docs(template): 開價溢價 headers/sort; rent+cashflow advisory; drop coverage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: finance.ts 註解 + 既有測試綠燈 + 人工驗收

**Files:**
- Modify: `scripts/lib/finance.ts`（`discountPercent` 與 `rentCoverage` 的 doc 註解）

**Interfaces:**
- Consumes: 無（純註解）。
- Produces: 與新指標一致的程式註解；不改任何函式行為，既有 `finance.test.ts` 不變。

- [ ] **Step 1: 更新 `discountPercent` 註解**

把
```typescript
/** Discount vs market, in percent: positive means below market. */
```
換成
```typescript
/**
 * Discount vs market, in percent: positive means below market.
 * NOTE: the investment screen now frames the metric as 開價溢價 (asking premium)
 * = −discountPercent. Kept as a utility; see docs/reporting-rules.md (Calculations).
 */
```

- [ ] **Step 2: 更新 `rentCoverage` 註解**

把
```typescript
/** Rent coverage ratio: monthly rent / monthly mortgage payment. */
```
換成
```typescript
/**
 * Rent coverage ratio: monthly rent / monthly mortgage payment.
 * Advisory display only — the investment screen no longer gates buckets on this
 * (rent is too unreliable to gate). See docs/reporting-rules.md (Rent).
 */
```

- [ ] **Step 3: 跑既有測試，確認綠燈**

Run: `npm test`
Expected: PASS（含 `scripts/lib/finance.test.ts`；註解改動不影響任何斷言）。

- [ ] **Step 4: 提交**

```bash
git add scripts/lib/finance.ts
git commit -m "docs(finance): mark rentCoverage advisory; note 開價溢價 framing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: 人工驗收（實跑一次報表）**

對最近一個有資料的日期跑一次 investment 報表並逐項確認（不需提交產出，報表為 git-ignored 狀態）：

```bash
npm run pipeline -- run --profile investment --date <最近有資料日>
```

驗收清單：
- 推薦／接近依**開價溢價門檻**（`p*/2`、`p*`）分桶，`p*` 取自 `data/negotiation-rate.md` 對應市別。
- 三桶排序皆為**開價溢價由低到高**，次鍵總價低者優先。
- 租金以 `月租 ~X（參考）`、`現金流 ~Y/月（參考）` 呈現，報表中**無覆蓋率**字樣，且租金未改變任何分桶。
- 頂部門檻說明顯示溢價門檻；行情備註標明來源（好時價／實價登錄／樂居）與信心，邊界物件有好時價錨點。
- 異常低（`溢價 ≤ −10%`）物件落在可疑/待查、未直接進推薦。

---

## Self-Review

**Spec coverage：**
- 租金降參考 → Task 2（Rent 段）、Task 3（Estimation/Criteria）、Task 4（財務列去覆蓋率）、Task 5（finance 註解）。✓
- 開價溢價指標 + p* 換算 → Task 1（表）、Task 2（Calculations）、Task 3（Criteria）。✓
- 分桶門檻（含 −10% 可疑、走路不變）→ Task 3（Criteria/Buckets）、Task 4（門檻說明）。✓
- 排序由低到高 → Task 3（Notification）、Task 4（門檻/驗收）。✓
- 議價率參考表 + 2025Q3 種子 + 維護/新鮮度 → Task 1。✓
- 行情優先序（好時價邊界物件 + MAPE 信心帶 + 來源可見）→ Task 2（Market Price 段）、Task 3（Estimation）。✓
- 模板 inline/財務/空狀態/排序 → Task 4。✓
- finance.ts 僅註解、既有測試綠燈 → Task 5。✓

**Placeholder scan：** 無 TBD/TODO；所有取代內容均為完整逐字段落。✓

**Type/命名一致性：** inline 變數 `{{premium_percent}}`、`{{near_threshold_reason}}`、`{{estimated_rent}}`、`{{monthly_cash_flow}}` 在 Task 3 規則與 Task 4 模板一致；`p*`、`r`、`溢價` 用語跨 Task 1/2/3/4 一致；`finance.ts` 不新增函式，沿用既有 `discountPercent`/`rentCoverage`。✓
</content>
