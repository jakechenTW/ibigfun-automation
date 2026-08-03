# Investment Profile

Use this profile for rental-yield-oriented investment screening.

## Criteria

- Mortgage assumption: 80% loan-to-value, 2.6% annual interest, 30-year principal and interest repayment.
- 篩選主指標為**開價溢價**：`溢價 = (開價單價 − 成交行情單價) / 成交行情單價 * 100`，
  門檻錨定各市議價率換算的 `p*`（見 `data/negotiation-rate.md`，`p* = r/(1−r)`）。
- 推薦的價格 gate：對 controlling 或條件式判斷中的**每個 acceptance-enabled 情境**，使用
  `marketScenarios.scenarios[].askingPremiumConservative`（由含車位總價 P25 計算）分別檢查
  `−10% < 溢價 ≤ p*/2`。不得用 P50、住宅比較情境或情境平均值替未通過的情境補票。
- 已驗證用途：只有同用途 `role: primary` 情境可控制推薦；它須 `reliable`、信心非 low、來源新鮮、
  無 bundle conflict，且通過上述價格 gate。已驗證為非住宅時，`residential-comparison` 僅供比較。
- 用途未知／未驗證：只有至少兩個 acceptance-enabled、資料新鮮且信心非 low 的 supported 情境
  （必含 residential）**全部**通過上述價格 gate，且沒有 diagnostic-only 相反判斷或 bundle conflict，
  才能進推薦，並明確標為「條件式推薦（用途未確認）」。此例外允許情境因
  `registered-use-unverified` 保持 `review`；任何其他 review reason 仍不可推薦。
- 除行情條件外，推薦仍須走路可靠在內（`withinWalk === true` 或 triage likely-within）、乾淨
  （非 suspicious/likely-auction），且兩個官方來源均未過期。中位數單獨達標不可推薦。
- 接近門檻：controlling 情境的 `p*/2 < 溢價 ≤ p*`，或溢價達推薦級但只差在行情／走路待確認。
  用途未知時，只要 pass／fail／insufficient 混合、全部 pass 但不足兩個或缺 residential，或
  diagnostic-only 情境提供相反結果，均列為「用途待確認候選」。沒有 supported 情境或 bundle
  conflict 則同桶標「人工複核」，不可偽裝成接近價格門檻。
- 排除：已驗證用途 controlling 情境 `溢價 > p*`；用途未知時，每個 supported 情境都未通過
  profile P25 gate 則不推薦，列入排除。
- 異常低（`溢價 ≤ −10%`）先進可疑/待查驗證，**不直接推薦**；驗證乾淨且行情可靠後依溢價歸桶。
- 區域閘門（硬排除）：`regionGate` 為 `out-of-region`（最近站不在目標白名單）或
  `in-region-too-far`（白名單站但可靠步行 >10 分）的物件一律排除，且**不逐筆列出**，
  只進「快速摘要」的稽核計數行（見 `docs/reporting-rules.md` Region Gate 與
  `data/region-allowlist.md`）。`regionGate === 'review'`（`withinWalk === null`）不排除，
  送 triage／人工。
- 租金覆蓋率與現金流僅供參考顯示，不參與分桶或排序。

## Estimation

- 行情：使用 enriched `marketScenarios` 的 exact-use 情境；推薦和門檻覆核以各情境的含車位總價
  P25 及 `askingPremiumConservative` 為準。通知呈現情境表、A/B/C 筆數及最多兩筆最具影響可比；
  完整證據仍留在本地 `enriched.json`。詳見
  `docs/reporting-rules.md`（Market Price & Premium）。
- A 級車位是直接證據；B 級只有共享車位 acceptance 通過後才可按 capped weight 使用；C 級只作
  bundle 交叉檢查。不得再因 listing 車位無法直接拆價就一律 unavailable，但 B 未 accepted、車位
  推估缺失或 bundle conflict 仍不得推薦。
- 僅能對低信心、review/unavailable 或中位數才達標的邊界物件做有界外部覆核；外部值不覆寫官方
  情境值，也不能使未 accepted 情境通過。
  若外部覆核影響分桶，必須寫同 run 的 `valuation-review.json`，否則不可改桶。
- 行情資料若過期、弱、情境 unavailable/diagnostic-only/insufficient-sample，或 controlling 情境有
  review reason（用途未知的明確條件式例外除外），物件不可標推薦。
- 租金：agent 粗估同區同類型可比租金，僅供參考、不影響分桶；一律標低信心與人工確認。
- 地上權／使用權等非自由持分物件：開價不可直接比自由持分行情，依 `docs/reporting-rules.md`
  的「非自由持分（地上權／使用權）校正」處理（標可疑/待查或排除，不得標推薦）。

## Report Buckets

- `推薦物件`: 已驗證用途 controlling 情境或符合 shared unknown-use 規則的所有 supported 情境皆為
  `−10% < 溢價 ≤ p*/2`，且走路可靠在內、乾淨、行情證據合格；未知用途須標「條件式推薦」。
- `接近門檻候選`: controlling 情境 `p*/2 < 溢價 ≤ p*`、溢價達推薦級但資料/走路待確認、
  「用途待確認候選」或「人工複核」。
- `區域閘門（計數）`: `out-of-region` 與 `in-region-too-far` 物件不分桶逐列，只在
  快速摘要稽核計數行分別計數（目標捷運站外／站內走路過遠）。
- `可疑/待查`: 可疑或疑似法拍（含異常低溢價 `≤ −10%`）應降權。
- `目標日排除物件`: 其餘（含 controlling 情境 `溢價 > p*` 或未知用途全部 supported 情境皆 fail）
  值得摘要的物件。

## Notification Format

Use `notify-template.md` for structure. These details are
investment-specific and should not be applied to owner-occupied reports:

- Each listing section header is `#### {rank}. [title](url)`; do not emit a `- 狀態：...` line because the section heading already names the bucket.
- Append inline metrics to the header: recommended `｜ 開價溢價 {premium_percent}%`; near-threshold `｜ 開價溢價 {premium_percent}%・差在 {near_threshold_reason}`; suspicious `｜ \`{suspicious_label}\`` where suspicious_label is `clean` / `suspicious` / `likely-auction`.
- Do not emit the old raw `刊登日` / `publishedDate` line in recommended or
  near-threshold listings; do emit `{{tenure_line}}` exactly as shown in the
  template.
- Recommended and near-threshold use the full compact layout: walk line, one
  tenure line `{{tenure_line}}`, one basics line
  `總價／坪數／單價・樓層・屋齡・地址`, the authoritative scenario table plus at most two influential
  comparables per scenario, one financial line `房貸・月租(參考)・現金流(參考)`, then compact
  external-review/reason/risk or manual-check lines.
- 月租與現金流為參考欄位，標 `（參考）`；不再輸出覆蓋率。
- Pre-excluded, suspicious, and excluded listings use the shorter surrounding layouts shown in the template but
  still include the scenario table and compact influential-comparable evidence.
- Emit the 🚶 walk line in 推薦 and 接近門檻 only; do not emit it in 可疑/待查 or 目標日排除. 區域閘門物件只計數、不逐列，故無 walk line。
- If the target-date new-listing count is 10 or lower, list all excluded properties. If it is above 10, list only the 5 excluded properties closest to the threshold.
- 推薦、接近門檻、排除三桶一律按 controlling 開價溢價**由低到高**排序（溢價越低越前），次鍵
  總價低者優先。已驗證用途取同用途 primary 情境；用途未知取所有 supported 情境中最高、最不利的
  `askingPremiumConservative`，不可用住宅情境或平均值美化排序。
