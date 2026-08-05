# Investment Profile

Use this profile for rental-yield-oriented investment screening.

## Criteria

- Mortgage assumption: 80% loan-to-value, 2.6% annual interest, 30-year principal and interest repayment.
- 刊登年限：`tenureGate === 'expired'` 一律排除；`review` 不得自動推薦，乾淨物件放入
  `候選／資料待確認`；`eligible` 才繼續其餘條件。非 expired 物件若有已驗證風險，
  `風險物件／待查` 優先於候選或推薦。
- 推薦：`tenureGate === 'eligible'`，區域與步行規則通過（`regionGate === 'in'` 或等效的
  triage `likely-within`），agent verdict 為 `clean`，官方行情 `reliable`、信心非 `low`、
  兩個官方來源均未過期，且車位、產權、用途與其他資料品質規則全部通過。
- 候選：只收錄外觀正常、未命中硬性排除，且因刊登年限、走路、行情或其他可解決的資料不確定
  而無法自動推薦的物件。
- 風險：非 expired 物件若為 `suspicious` / `likely-auction`，或有重大產權、用途、資訊品質風險，
  放入 `風險物件／待查`。
- 排除：包含 `tenureGate === 'expired'`、區域／走路硬性失敗，以及其他無法解決或已確認的硬性失敗。
- 區域閘門（硬排除）：`regionGate` 為 `out-of-region`（最近站不在目標白名單）或
  `in-region-too-far`（白名單站但可靠步行 >10 分）的物件一律排除，且**不逐筆列出**，
  只進「快速摘要」的稽核計數行（見 `docs/reporting-rules.md` Region Gate 與
  `data/region-allowlist.md`）。`regionGate === 'review'`（`withinWalk === null`）不排除，
  送 triage／人工。
- 租金覆蓋率與現金流僅供參考顯示，不參與分桶或排序。

## Estimation

- 行情：使用 enriched `marketEstimate` 的官方中位數及 P25–P75 作為市場脈絡與可靠性證據；
  不用待售開價與官方估值的差異決定分桶或排序。
  完整可比證據留在本地 `enriched.json`，通知只呈現筆數、階段、信心和資料日期。詳見
  `docs/reporting-rules.md`（Market Price Evidence）。
- 僅能對低信心、review/unavailable 或其他有明確可解決行情疑點的少數物件做有界外部覆核；外部值不覆寫官方值。
  若外部覆核影響分桶，必須寫同 run 的 `valuation-review.json`，否則不可改桶。
- 行情資料若過期、弱、review/unavailable，或車位不可分離，物件不可標推薦。
- 租金：agent 粗估同區同類型可比租金，僅供參考、不影響分桶；一律標低信心與人工確認。
- 地上權／使用權等非自由持分物件：依 `docs/reporting-rules.md` 的「產權相容性」處理；
  產權與 profile 或官方證據不相容時標為風險／待查，違反硬性條件時排除，不得推薦。

## Report Buckets

- `推薦物件`: 刊登年限、區域／步行、清潔度、官方行情可靠性及車位／產權／用途品質全部通過。
- `候選／資料待確認`: 乾淨且無硬性失敗，只差刊登年限、走路、行情或其他可解決資料不確定。
- `風險物件／待查`: suspicious/likely-auction 或重大產權／用途／資訊品質風險的非 expired 物件。
- `排除物件`: `tenureGate === 'expired'`、區域／走路硬性失敗與其他硬性失敗。
- `區域閘門（計數）`: `out-of-region` 與 `in-region-too-far` 物件不分桶逐列，只在
  快速摘要稽核計數行分別計數（目標捷運站外／站內走路過遠）。

## Notification Format

Use `notify-template.md` for structure. These details are
investment-specific and should not be applied to owner-occupied reports:

- Each listing section header is `#### {rank}. [title](url)`; do not emit a `- 狀態：...` line because the section heading already names the bucket.
- Do not emit the old raw `刊登日` / `publishedDate` line in recommended or
  candidate listings; do emit `{{tenure_line}}` exactly as shown in the
  template.
- Recommended and candidate listings use the full compact layout: walk line, one
  tenure line `{{tenure_line}}`, one basics line
  `總價／坪數／單價・樓層・屋齡・地址`, one financial/evidence line
  `官方中位/P25–P75・狀態・信心・可比筆數・階段・資料日期・房貸・月租(參考)・現金流(參考)`,
  then compact external-review/reason/risk or manual-check lines.
- 月租與現金流為參考欄位，標 `（參考）`；不再輸出覆蓋率。
- Pre-excluded, risk, and excluded listings use the shorter layouts shown in the template.
- Emit the 🚶 walk line in 推薦 and 候選／資料待確認 only; do not emit it in 風險物件／待查 or 排除物件. 區域閘門物件只計數、不逐列，故無 walk line。
- If the target-date new-listing count is 10 or lower, list all excluded properties. If it is above 10, list only the 5 excluded properties nearest to satisfying the remaining criteria.
- 逐筆顯示的各桶先按已知 `daysOnMarket` 由小到大、再按總價由低到高排序。刊登年限不明的
  乾淨物件只能進候選且排在已知年限之後；若有已驗證風險，仍優先進風險桶並在該桶末位。
