# AI 可疑/法拍物件判斷設計

日期:2026-06-27

## 背景與問題

目前「法拍/特殊處分」物件靠寫死的關鍵字比對偵測:`scripts/lib/exclude.ts`
的 `AUCTION_KEYWORDS` 命中標題即視為法拍,`scripts/lib/walk.ts` 把它推進
`hardExclusion`,該筆物件直接從報告移除。

使用者不想要這個判斷是寫死的關鍵字。希望改由 agent 綜合判斷物件品質——例如點
開販售頁面發現「完全沒有室內圖」「資訊過少」等軟訊號——來標記可疑物件,法拍只是
這個廣義「爛/可疑物件」類別下的一個 case。

## 目標(已與使用者確認的決策)

1. **判斷目標**:廣義標記「資訊過少/可疑/爛」物件,法拍是其中一個 case(不是只做
   精準法拍偵測)。
2. **資料來源**:agent 在報告步驟**選擇性**點進詳情頁查證,**不**新增爬詳情頁的
   腳本步驟,不動爬蟲基礎建設。
3. **關鍵字去留**:現有關鍵字比對**降級為提示訊號**,不再自動硬排除;最終決定權
   交給 agent。
4. **處理動作**:agent 判定可疑後**軟標記 + 降權,絕不自動移除**。

## 非目標(YAGNI)

- 不訓練任何模型、不引入新的 ML 服務。
- 不擴充 `scripts/fetch.ts` 去逐筆 follow 詳情頁、不抓圖片進結構化資料。
- 不對每一筆物件都點進詳情頁(成本控制)。
- 不改動 MRT 步行距離的硬排除邏輯。

## 架構與職責劃分

維持現有「腳本做確定性、agent 做判斷」的原則:

```
fetch.ts        → 不動。仍只抓列表頁欄位。
enrich.ts       → 小改:關鍵字從硬排除降級為 advisory 訊號(見「程式碼改動」)。
報告步驟(agent)→ 新增「品質/可疑判斷」,含選擇性點進詳情頁。  ← 主要工作落這
reporting-rules → 新增判斷準則一節,改寫法拍硬排除條文。       ← 判斷邏輯寫在這
template        → 新增「可疑/待查」區塊與摘要欄位。
```

核心精神:法拍/爛物件的判斷從「程式碼裡的關鍵字硬排除」變成「reporting-rules 裡
給 agent 的準則 + agent 的現場判斷」。程式碼複雜度幾乎不增加。

## 程式碼改動(小)

### `scripts/lib/exclude.ts`

- `hasAuctionKeyword` 與 `AUCTION_KEYWORDS` **保留**。它仍是個便宜、可靠的訊號,
  只是不再直接導致排除。

### `scripts/lib/enrich-offline.ts`

- 維持計算 `hasAuction`(已存在於 `OfflineEnriched`)。

### `scripts/lib/walk.ts`

- **移除**第 110 行把 `hasAuction` 推進 `hardExclusion.reasons` 的邏輯。
- 改成在最終 `EnrichedListing` 上保留一個 advisory 欄位,讓 agent 看得到但不自動
  排除。具體形狀:新增 `signals: { auctionKeyword: boolean }`。
- `hardExclusion` 之後**只剩**「>10 分鐘步行(資料可靠時)」這一條客觀硬排除。

### `scripts/lib/types.ts`

- `EnrichedListing` 新增 `signals: { auctionKeyword: boolean }`。

### 測試

- `scripts/lib/exclude.test.ts`:關鍵字偵測本身的測試保留(函式行為不變)。
- `scripts/lib/walk.test.ts`:更新——命中關鍵字的物件**不再**出現在
  `hardExclusion`,而是 `signals.auctionKeyword === true`;`hardExclusion` 只由
  步行距離觸發。
- `scripts/lib/enrich-offline.test.ts`:若有斷言 `hasAuction`,確認仍正確。

## Agent 判斷準則(寫進 `docs/reporting-rules.md`)

把現有「Hard Exclusions」中的法拍條文(目前第 21–22 行:
「Exclude auction and special-disposition listings…」與其證據條)**改寫**為一個新
區塊「品質/可疑判斷(Quality / Suspicious-Listing Judgment, Agent)」,定義四件事:

### 1. 可疑訊號清單(weigh,不單獨定罪)

- `signals.auctionKeyword`(enrich 來的提示)= 標題出現法拍/銀拍/金拍/法院拍賣/
  拍賣/投標/應買等字眼。
- 完全沒有室內圖,或只有外觀/地圖/格局圖。
- 資訊量過少:描述極短、關鍵欄位大量空白。
- 來源站/標籤/備註露出特殊處分字樣。

### 2. 何時該點進詳情頁

- 觸發條件:命中任一上述訊號,**或**該物件其他條件夠好(會進推薦/接近門檻)而值得
  查證時。
- 動作:開該筆 `url`(常是 591/樂居/rakuya 等來源站,非 ibigfun.com,不影響
  iBigFun 登入 session),檢視圖片數與資訊密度。
- **明確限制:不要每筆都點。** 只查「可疑」或「邊界但有潛力」的物件,以控制成本。

### 3. 判定與輸出

- 三態:`clean` / `suspicious` / `likely-auction`。
- 每筆附:理由 + 信心 + 是否實際點進詳情頁查證。
- **鐵則:proxy 訊號(如「沒室內圖」)不可單獨作為移除理由;法拍也不再自動移除,
  一律改為標記。**

### 4. 與排名的關係

- `suspicious` / `likely-auction` → **降權**:即使數字達標,也不放進「推薦」,降到
  接近門檻或可疑區,並標注理由。與既有「資料不足不可標 recommended」的精神一致。

## 報告呈現(`templates/daily-notify-template.md` + 摘要)

- 改寫「快速摘要」第 17 行的前置排除說明:移除「法拍/銀拍/法院拍賣/投標等特殊處分
  案」字樣,前置排除只描述客觀的捷運距離條件。
- 「前置排除」區塊(現第 19–39 行)語意收斂為只列客觀硬排除(>800m / >10 分鐘
  步行);法拍不再進這區。
- **新增「⚠️ 可疑/待查」區塊**,放在「接近門檻候選」之後、「目標日排除物件」之前。
  每筆列:標題連結、可疑標籤(`suspicious`/`likely-auction`)、命中訊號、是否已
  點進詳情頁、理由與信心。
- 快速摘要新增一行:`- 可疑/待查:{{suspicious_count}} 筆`。

## 資料流(end-to-end)

1. `fetch.ts` 抓列表頁(不變)。
2. `enrich.ts` 計算確定性欄位;`signals.auctionKeyword` 標出關鍵字命中;
   `hardExclusion` 只剩步行距離。
3. 報告步驟:agent 讀 enriched 資料,對命中訊號或邊界有潛力的物件選擇性點進詳情頁,
   給出 `clean`/`suspicious`/`likely-auction` 判定。
4. 可疑物件降權、進「可疑/待查」區塊;其餘照常推薦/接近門檻/排除。
5. 依 `templates/daily-notify-template.md` 產報告並通知。

## 錯誤處理 / 邊界

- 詳情頁打不開或來源站擋爬:記為「未能查證」,**不**升級為移除;保留軟標記與低信心。
- 關鍵字命中但 agent 查證後判定非法拍(如標題提到「非法拍」「法拍屋旁」):agent
  可下修為 `clean` 並記理由——關鍵字只是提示,不是定罪。
- proxy 誤判風險(預售/新成屋常無室內圖):由「軟標記不移除」這條設計吸收,使用者
  仍看得到該物件。

## 測試策略

- 純邏輯(`exclude.ts` / `walk.ts` 的 `signals` 與 `hardExclusion` 行為)以
  `npm test` 覆蓋。
- agent 的判斷屬非確定性,不寫自動化測試;以 `reporting-rules.md` 的準則 + 報告
  區塊呈現作為規格,靠人工檢視日報驗證。

## 影響檔案清單

- `scripts/lib/walk.ts`(改)
- `scripts/lib/types.ts`(改)
- `scripts/lib/walk.test.ts`(改)
- `scripts/lib/enrich-offline.test.ts`(視斷言而定)
- `docs/reporting-rules.md`(改:法拍硬排除 → 品質/可疑判斷區塊)
- `templates/daily-notify-template.md`(改:摘要欄 + 新增可疑/待查區塊)
- `AGENTS.md`(視需要:第 4 步 enrich 描述提到「auction keywords」硬排除,需同步
  改為 advisory 訊號的說法)
