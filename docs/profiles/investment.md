# Investment Profile

Use this profile for rental-yield-oriented investment screening.

## Criteria

- Mortgage assumption: 80% loan-to-value, 2.6% annual interest, 30-year principal and interest repayment.
- 篩選主指標為**開價溢價**：`溢價 = (開價單價 − 成交行情單價) / 成交行情單價 * 100`，
  門檻錨定各市議價率換算的 `p*`（見 `data/negotiation-rate.md`，`p* = r/(1−r)`）。
- 推薦：`−10% < 溢價 ≤ p*/2` 且 走路可靠在內（`withinWalk === true` 或 triage likely-within）
  且 乾淨（非 suspicious/likely-auction）且 行情資料可靠不過期。
- 接近門檻：`p*/2 < 溢價 ≤ p*`，或溢價達推薦級但只差在行情待確認／走路待確認。
- 排除：`溢價 > p*`。
- 異常低（`溢價 ≤ −10%`）先進可疑/待查驗證，**不直接推薦**；驗證乾淨且行情可靠後依溢價歸桶。
- 區域閘門（硬排除）：`regionGate` 為 `out-of-region`（最近站不在目標白名單）或
  `in-region-too-far`（白名單站但可靠步行 >10 分）的物件一律排除，且**不逐筆列出**，
  只進「快速摘要」的稽核計數行（見 `docs/reporting-rules.md` Region Gate 與
  `data/region-allowlist.md`）。`regionGate === 'review'`（`withinWalk === null`）不排除，
  送 triage／人工。
- 租金覆蓋率與現金流僅供參考顯示，不參與分桶或排序。

## Estimation

- 行情：優先用好時價 AVM 逐址估值（限邊界物件），否則用實價登錄／可比成交。詳見
  `docs/reporting-rules.md`（Market Price & Premium）。
- 行情資料若僅有過期／弱／逾時／跨站來源，物件不可標推薦。
- 租金：agent 粗估同區同類型可比租金，僅供參考、不影響分桶；一律標低信心與人工確認。
- 地上權／使用權等非自由持分物件：開價不可直接比自由持分行情，依 `docs/reporting-rules.md`
  的「非自由持分（地上權／使用權）校正」處理（標可疑/待查或排除，不得標推薦）。

## Report Buckets

- `推薦物件`: `−10% < 溢價 ≤ p*/2`，走路可靠在內、乾淨、行情可靠。
- `接近門檻候選`: `p*/2 < 溢價 ≤ p*`，或溢價達推薦級但資料/走路待人工確認。
- `區域閘門（計數）`: `out-of-region` 與 `in-region-too-far` 物件不分桶逐列，只在
  快速摘要稽核計數行分別計數（目標捷運站外／站內走路過遠）。
- `可疑/待查`: 可疑或疑似法拍（含異常低溢價 `≤ −10%`）應降權。
- `目標日排除物件`: 其餘（含 `溢價 > p*`）值得摘要的物件。

## Notification Format

Use `templates/investment-notify-template.md` for structure. These details are
investment-specific and should not be applied to owner-occupied reports:

- Each listing section header is `#### {rank}. [title](url)`; do not emit a `- 狀態：...` line because the section heading already names the bucket.
- Append inline metrics to the header: recommended `｜ 開價溢價 {premium_percent}%`; near-threshold `｜ 開價溢價 {premium_percent}%・差在 {near_threshold_reason}`; suspicious `｜ \`{suspicious_label}\`` where suspicious_label is `clean` / `suspicious` / `likely-auction`.
- Do not emit the old raw `刊登日` / `publishedDate` line in recommended or
  near-threshold listings; do emit `{{tenure_line}}` exactly as shown in the
  template.
- Recommended and near-threshold use the full compact layout: walk line, one
  tenure line `{{tenure_line}}`, one basics line
  `總價／坪數／單價・樓層・屋齡・地址`, one financial line
  `行情・房貸・月租(參考)・現金流(參考)`, then reason/risk or manual-check.
- 月租與現金流為參考欄位，標 `（參考）`；不再輸出覆蓋率。
- Pre-excluded, suspicious, and excluded listings use the shorter layouts shown in the template.
- Emit the 🚶 walk line in 推薦 and 接近門檻 only; do not emit it in 可疑/待查 or 目標日排除. 區域閘門物件只計數、不逐列，故無 walk line。
- If the target-date new-listing count is 10 or lower, list all excluded properties. If it is above 10, list only the 5 excluded properties closest to the threshold.
- 推薦、接近門檻、排除三桶一律按開價溢價**由低到高**排序（溢價越低越前），次鍵總價低者優先。
