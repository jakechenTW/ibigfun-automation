# 每筆物件「已刊登多久」設計（刊登紀錄 / Days on Market）

日期:2026-06-27

## 背景與問題

每日報告目前每筆物件顯示「刊登日」,但那只是該物件**最近一次重新上架**的日期。
因為抓取用 `add_date == add_date_max == 目標日` 篩選,報告內幾乎每筆的 `publishedDate`
都等於目標日,「刊登多久」算出來永遠是約 1 天,沒有意義。

使用者想知道的是物件**實際在市場上賣了多久**——這是判斷「賣不掉 / 開價偏高 / 待查」
的有用訊號。

## 資料來源:iBigFun 列表頁的「刊登紀錄」

iBigFun 列表頁每一列右側有「刊登紀錄」下拉。展開後是一張表,列出**同一個物件跨所有
來源(591 / 樂屋網 / 永慶 / 好房網 / 信義 / 5168 …)、跨時間的完整刊登史**,連已下架的
記錄都列出(以 `(下架)…` 純文字呈現)。每列為 `[總價, 案件名稱(連結), 來源, 刊登日]`。

實測一筆 1588 萬物件:iBigFun 主列「刊登日」是 2026-06-26,但刊登紀錄最早一筆(含下架)
是 **2025-09-07**,期間價格一路 1588 萬未變——即此物件實際已在市場上賣了約 9.5 個月、
從沒降價。

### 已驗證的兩個關鍵事實(2026-06-27 對 live DOM)

1. **刊登紀錄表內嵌在列表頁 DOM**:展開/收合不打任何 XHR,只是切換顯示。
2. **每一列各有一張,未展開時也在 DOM**:整頁同時存在約 20 張(每列一張),只展開 1 筆
   時其餘仍在 DOM。故 scraper 用一次 `$$eval` 即可抓全部列的刊登史,**不必逐筆點開、
   不會多打請求**。

## 目標(已與使用者確認的決策)

1. **起算日 = 最早一筆(含下架)**:`daysOnMarket` 以刊登史中**所有**記錄(含 `(下架)`)
   的最早日期為起點,反映物件「總共被拿出來賣了多久」。
2. **範圍 = 天數 + 降價訊號,純資訊呈現**:同時顯示已刊登天數與期間有無降價;**不**改
   推薦 / 接近門檻 / 排除 / 可疑的任何判斷門檻。
3. **架構 = 方案 A**:抓取層存原始刊登史,enrich 層做決定性衍生,範本只排版。
4. **疊在 compact 範本之上**:`feat/notify-template-compact-walk` 的 compact 範本已移除
   沒用的「刊登日」欄;本設計用一行 🕒 取代它,放回有用的「已刊登多久」。假設 compact
   範本先合併。

## 非目標(YAGNI)

- 不把「長期掛賣不降價」做成 agent 可疑 / 待查的硬規則(維持純資訊;agent 仍可在風險
  欄自然帶到)。
- 不畫價格曲線、不做歷史趨勢圖;只保留原始史 + 幾個衍生純量。
- 不改投資門檻、排序、排除 / 可疑判斷邏輯。
- 不改快速摘要區。

## 架構(方案 A)

`fetch`(抓取 + 正規化)解析並存**原始刊登史**;`enrich`(決定性衍生)算出天數與降價
摘要;範本只把算好的值排成一行。完全沿用現有「fetch=正規化、enrich=決定性衍生、報告
層只排版不算數」的分工。

## ① 資料模型 `scripts/lib/types.ts`

抓取層 —— `Listing` 新增原始刊登史:

```ts
interface ListingHistoryEntry {
  date: string;          // "2026-06-05"
  source: string;        // "樂屋網" | "591" | "永慶房屋" …
  price: string | null;  // 原始字串 "1588" / "1,588";缺則 null
  active: boolean;        // false = (下架) 那種純文字列
}
// Listing 增加：
//   listingHistory: ListingHistoryEntry[]   // 無 / 解析失敗則 []
```

enrich 層 —— `EnrichedListing` 新增決定性衍生 `tenure`:

```ts
interface ListingTenure {
  firstListedDate: string | null;  // 全部記錄(含下架)的最早日期
  daysOnMarket: number | null;     // 目標日 − firstListedDate(天);無史則 null
  recordCount: number;             // 刊登史總筆數
  sourceCount: number;             // 不重複來源數
  priceTrend: 'flat' | 'dropped' | 'raised' | 'unknown';
  firstPrice: number | null;       // 最早記錄價(萬)
  latestPrice: number | null;      // 最新記錄價(萬)
}
// EnrichedListing 增加：
//   tenure: ListingTenure
```

## ② 抓取解析 `scripts/lib/extract.ts` + `scripts/lib/config.ts`

- 每個 `cardRow` 內含一張內嵌刊登紀錄表(已驗證未展開也在 DOM)。在 `SELECTORS.list`
  新增 `historyTable` / `historyRow` 選擇器,實作時對 live DOM 釘死,沿用現有
  `SELECTORS_VERIFIED` 流程與 `docs/fetching.md` 的重新確認方法。
- 逐列解析 `<td>`,以內容判欄位(對欄序穩健):用 `\d{4}-\d{2}-\d{2}` 認日期欄、數字
  (去逗號)認價格欄、來源取來源欄文字;**跳過表頭排序列**。
- `active`:名稱欄是連結 → 上架 `true`;名稱欄為純文字且以 `(下架)` 開頭 → `false`。
- 解析失敗或該列無刊登紀錄表 → `listingHistory: []`(不丟錯,向後相容)。
- 抓取為一次 `$$eval`,不點任何下拉。

## ③ enrich 衍生 `scripts/lib/enrich.ts`(純函式、可測)

由 `listingHistory` 計算 `tenure`:

- `firstListedDate` = 全部 `date` 取最小(字串 `YYYY-MM-DD` 可直接字典序比較)。
- `daysOnMarket` = 目標日 − `firstListedDate`,以天計(enrich 已知目標日)。
- `recordCount` = 總筆數;`sourceCount` = 不重複 `source` 數。
- `priceTrend`:忽略 null 價後 —— 全部相等→`flat`;最新 < 最早→`dropped`;
  最新 > 最早→`raised`;完全無價→`unknown`。「最新 / 最早」依日期排序取兩端。
- `firstPrice` / `latestPrice` 帶數字供「1680→1588」呈現。
- `listingHistory` 為空 → `firstListedDate=null`、`daysOnMarket=null`、`recordCount=0`、
  `sourceCount=0`、`priceTrend='unknown'`、價格皆 null(真正首次上架的新物件)。

## ④ 範本 🕒 行 `templates/daily-notify-template.md`

疊在 compact 範本上:compact 已移除沒用的「刊登日」,改用一行 🕒 放回有用的「已刊登
多久」,**每個區塊**(推薦 / 接近門檻 / 前置排除 / 可疑 / 目標日排除)都放,緊接 🚶 行
之後(無 🚶 的區塊就單獨成行)。

```
- 🕒 已刊登 280 天・未降價（最早 2025-09-07・12 來源）
```

變體:

- 曾降價:`🕒 已刊登 95 天・曾降價 1680→1588萬（最早 2026-03-24・8 來源）`
- 曾調漲:`🕒 已刊登 60 天・曾調漲 1500→1588萬（最早 2026-04-28・5 來源）`
- 新上架(`recordCount <= 1` 或無史):`🕒 本日新上架`
- 資料不明(解析不到):`🕒 刊登史不明`

`docs/reporting-rules.md` 補一段 🕒 行的組字規則,對齊現有 🚶 行寫法。**不改任何投資
門檻 / 排序 / 排除 / 可疑判斷**。

## ⑤ 測試 `npm test`

純邏輯(enrich 衍生)以 fixture 覆蓋:

- 多來源含下架 → `firstListedDate` 取最早(下架那筆)。
- `daysOnMarket` 計算正確(跨月)。
- `priceTrend` 四種:flat / dropped / raised / unknown。
- 價格去逗號(`"1,588"` → 1588)。
- 僅 1 筆 / 空史 → 新上架 / null 行為。

抓取解析:加一個 DOM fixture(一張刊登紀錄表 HTML)→ 預期 `listingHistory`,涵蓋上架
連結列與 `(下架)` 純文字列。

## 受影響檔案

- `scripts/lib/types.ts` —— 新增 `ListingHistoryEntry`、`ListingTenure`,擴充 `Listing`、
  `EnrichedListing`。
- `scripts/lib/config.ts` —— 新增刊登紀錄表選擇器。
- `scripts/lib/extract.ts` —— 解析內嵌刊登紀錄表 → `listingHistory`。
- `scripts/lib/enrich.ts` —— 由 `listingHistory` 算 `tenure`。
- `templates/daily-notify-template.md` —— 各區塊新增 🕒 行。
- `docs/reporting-rules.md` —— 🕒 行組字規則。
- `docs/fetching.md` —— Fields To Extract 補 `listingHistory`。
- 測試檔 —— enrich 衍生 + extract DOM fixture。

## 相依與順序

compact 範本(`feat/notify-template-compact-walk`)**已合併進 `main`**(merge commit
`e1b6160`),本設計直接疊在其上,🕒 行對齊已落地的 compact 版型。本功能在獨立分支
`feat/listing-tenure-days-on-market` 開發。
