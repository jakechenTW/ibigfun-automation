# 各縣市成交議價率（議價空間）參考表

investment-taipei profile 用此表把「開價」校準到「成交行情」，計算開價溢價門檻。
詳見 `docs/reporting-rules.md`（開價溢價 / Calculations）與 `profiles/investment-taipei/evaluation.md`。

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
