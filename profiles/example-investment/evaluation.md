# Investment Profile

Use this profile for rental-yield-oriented investment screening.

## Criteria

- Mortgage assumption: 80% loan-to-value, 2.6% annual interest, 30-year principal and interest repayment.
- 刊登年限：`tenureGate === 'expired'` 一律排除；`review` 不得自動推薦，乾淨物件放入
  `候選／資料待確認`；`eligible` 才繼續其餘條件。非 expired 物件若有已驗證風險，
  `風險物件／待查` 優先於候選或推薦。
- 推薦：`tenureGate === 'eligible'`，區域與步行規則通過：`regionGate === 'in'`；若原為
  `regionGate === 'review'`，只有重新定位同時確認「最近站在投資白名單內」且 triage 步行 verdict 為
  `likely-within` 才可視為通過，`likely-within` 單獨不等同 `regionGate === 'in'`。agent verdict 為
  `clean`，官方行情 `reliable`、信心非 `low`、
  兩個官方來源均未過期，且車位、產權、用途與其他資料品質規則全部通過。
- 候選：只收錄 agent verdict 為 `clean`、未命中硬性排除，且因刊登年限、走路、行情或其他可解決的資料不確定
  而無法自動推薦的物件。
- 風險：非 expired 物件若為 `suspicious` / `likely-auction`，或有重大產權、用途、資訊品質風險，
  放入 `風險物件／待查`。
- 排除：包含 `tenureGate === 'expired'`、區域／走路硬性失敗，以及其他無法解決或已確認的硬性失敗。
- 區域閘門（硬排除）：`regionGate` 為 `out-of-region`（最近站不在目標白名單）或
  `in-region-too-far`（白名單站但可靠步行 >10 分）的物件一律排除，且**不逐筆列出**，
  只在「排除摘要」依原因分開計數（見 `docs/reporting-rules.md` Region Gate 與
  `data/region-allowlist.md`）。`regionGate === 'review'`（`withinWalk === null`）不排除，
  送 triage／人工。若 `進入評估` 異常為 0，將警訊寫入 `data_warning`。
- 租金覆蓋率與現金流僅供 workflow/local 參考，不參與分桶或排序，也不出現在通知。

## Estimation

- 行情：使用 enriched `marketEstimate` 的官方中位數及 P25–P75 作為市場脈絡與可靠性證據；
  不用待售開價與官方估值的差異決定分桶或排序。
  完整可比證據留在本地 `enriched.json`；通知只呈現 `market_summary_line`。詳見
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
  `排除摘要` 分別計數（目標捷運站外／站內走路過遠）；零筆原因不顯示。

## Notification Format

- Use `notify-template.md` and the shared concise contract in `docs/reporting-rules.md`.
- Render all `推薦物件`, `候選／資料待確認`, and `風險物件／待查`; never render excluded listings individually.
- Sort each rendered bucket by known `daysOnMarket` ascending and then total price ascending. Unknown tenure follows known tenure; verified risk still remains in the risk bucket.
- Core facts are total price, area, asking unit price, floor, building age, and address/area when available.
- Show `walk_line`, `tenure_line`, `market_summary_line`, and one listing-specific recommendation, review action, or risk phrase.
- Mortgage, estimated rent, cash flow, rental coverage, and financing assumptions remain workflow data but do not appear in the notification.
- The exclusion summary separately counts target-station-outside, in-region-too-far, expired tenure, and other confirmed hard failures.
- Do not emit asking-premium, conservative-price threshold, P25 gate, `p*`, or price-versus-market deal language.
