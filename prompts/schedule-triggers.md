# Schedule Triggers — 每日監測排程用 trigger（Codex / Claude Code 通用）

這份檔案是**排程觸發訊息**的可複製範本。行為腳本（完整 SOP）在
`prompts/daily-run.md`；這裡只負責把它需要的三個變數注入：**profile、tool
name、日期範圍**。排程 agent 不用重寫 SOP，把對應段落整段貼進 trigger 即可。

通用做法：trigger 內容對 Codex 與 Claude Code 完全相同，**唯一要改的是
`tool:` 這一行**——填你這個排程實際執行的 agent（`codex` 或 `claude`），且必須
和真正執行的 agent 相符（見 `prompts/daily-run.md`「監測 profile 與區間」）。

## 變數說明

- `profile`：`example-investment` 或 `example-owner-occupied`。**不得讓 agent 自行猜測**。
- `tool`：`codex` 或 `claude`，**填你這次排程實際在跑的 agent**。
- 範圍：通常**不指定**，由 pipeline 自動取「前一個台北日」（夜跑最常見，
  agent 不自行計算日期）。需要回補特定日才填 `--date` 或 `--from/--to`。

---

## Trigger A — example-investment

```
請依 prompts/daily-run.md 執行每日 iBigFun 監測。
profile: example-investment
tool: <codex 或 claude，填你實際執行的 agent>
範圍: 不指定（用前一個台北日）
全程 headless、不得停下來問人；判斷規則以 AGENTS.md、docs/reporting-rules.md 與 profile 規則檔為準。
```

## Trigger B — example-owner-occupied

```
請依 prompts/daily-run.md 執行每日 iBigFun 監測。
profile: example-owner-occupied
tool: <codex 或 claude，填你實際執行的 agent>
範圍: 不指定（用前一個台北日）
全程 headless、不得停下來問人；判斷規則以 AGENTS.md、docs/reporting-rules.md 與 profile 規則檔為準。
```

---

## 錯開時間（重要）

iBigFun 是**單一共享登入**——同一帳號同時 fetch 會互踢登入 session
（見 `docs/automation-state.md`、`AGENTS.md`）。所以兩個 profile **絕不能同時
跑**。二擇一：

- **建議：同一個 job 內依序跑**——`example-investment` 完整跑完（report 已寫、notify
  已送）再啟動 `example-owner-occupied`。最安全，不會踢到自己。
- **或：兩個 job 錯開排程**——間隔抓 ≥ 30 分鐘（單一 profile 的
  fetch+enrich+report+notify 通常數分鐘內完成；30 分鐘留足緩衝給
  ORS 路由重試與報告撰寫）。例：

  | 時間（Asia/Taipei） | Job |
  | --- | --- |
  | 03:00 | Trigger A（example-investment） |
  | 03:30 | Trigger B（example-owner-occupied） |

排程時段建議放凌晨：夜跑會把你瀏覽器當下的 iBigFun 登入踢掉（設計如此），
凌晨跑對日常使用干擾最小。

## 排程前置（首次）

排程環境需先滿足 `AGENTS.md`「First Run — Prerequisites」，否則 headless 會
靜默失敗：

- `ai-notify` 在 PATH（`which ai-notify`）。
- `.env` 已填：`IBIGFUN_ACCOUNT` / `IBIGFUN_PASSWORD`（見 `docs/credentials.md`）、
  `ORS_API_KEY`（enrich 步走路距離用）。
- `npm install` 已跑過。

## 失敗時的行為

trigger 不需處理失敗——`prompts/daily-run.md` 內建唯一逃生口
（`npm run pipeline -- fail ...`）：登入被 CAPTCHA/2FA/風控擋住或
fetch/enrich 不可恢復時，記錄 run-level 失敗並送出**一則** `status=fail`
通知後停止，絕不繞過登入控制、不無限重試。
