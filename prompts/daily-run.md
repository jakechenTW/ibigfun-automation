# Daily iBigFun Monitor — Worker Prompt (headless, autonomous)

你是每日 iBigFun profile-aware 房源監測 agent，以 headless 自動方式執行。**全程不得停下來問人**——沒有人在看。判斷規則以 `AGENTS.md`、`docs/reporting-rules.md` 與 profile 規則檔為準；本檔釘死「精確指令」與「headless 失敗/續跑政策」。

## 監測 profile 與區間（由 trigger 注入）

Trigger 必須提供 profile，例如 `investment` 或 `owner-occupied`。你不得自行猜測 profile。
Trigger 必須提供實際 tool name（`codex` 或 `claude`），且必須和真正執行的 agent 相符。

可複製的排程 trigger 範本（含兩個 profile 與錯開時間建議，Codex / Claude Code 通用）見 `prompts/schedule-triggers.md`。

Trigger 也會在訊息裡告訴你要監測的區間。把它對應成 pipeline 參數，**你不自行計算日期**：

- 給了起訖（from / to）→ `--from <from> --to <to>`
- 給了單一日期 → `--date <date>`
- 沒給 → 省略參數，pipeline 自動用「前一個台北日」（最常見的夜跑）

下文用 `[profile 參數]` 代表 `--profile <profile>`，用 `[範圍參數]` 代表日期或區間參數（可能是空字串），用 `[tool 參數]` 代表必要的 `--tool <codex|claude>`。

## 動手前先讀

`AGENTS.md`、`docs/reporting-rules.md`、`docs/credentials.md`、`docs/automation-state.md`、`profiles/<profile>.json`，以及 profile 裡指定的規則檔與模板——估價、評估、走路距離三角定位、可疑物件判斷都以它們為準。

## 執行流程（指令照抄）

1. 跑 orchestrator：

   ```
   npm run pipeline -- run [profile 參數] [範圍參數]
   ```

   它會跑 fetch + enrich，然後**停在 agent `report` 步**並印出需求；已經 ok 的步會被 skip（重跑＝自動續跑）。若它印出 `report` 步的需求，繼續第 2 步；若它以非 0 結束（fetch/enrich 失敗），跳到「Headless 失敗政策」。

2. 親手完成 `report` 步：對 `state/runs/<profile>/<label>/enriched.json` 做 `withinWalk:null` 三角定位、估價/評估、跨日彙整，依 `docs/reporting-rules.md`、profile 規則檔與 profile 模板寫出**一份**合併報告到 orchestrator 指定的 `state/runs/<profile>/<label>/report.md`。

3. 標記完成（會自動觸發 notify，idempotent）：

   ```
   npm run pipeline -- mark report [profile 參數] [範圍參數] --status ok --artifact state/runs/<profile>/<label>/report.md \
     --status-notify <ok|warn|fail> --title "<short>" [tool 參數]
   npm run pipeline -- run [profile 參數] [範圍參數]
   ```

   第二行重跑會把 `notify` 步送出。完成。

## status 對應

- `warn`：有推薦/符合條件、接近門檻/候選、資料偏舊、登入 fallback、未驗證 filter 對照，或有任何 manual-review 項。
- `owner-occupied`：`fetchFilters.enabled=true` 後為完整自住 discovery；依一般 status 規則判斷（有符合/候選/manual 即 `warn`，乾淨無符合且資料新鮮可 `ok`）。若任何 town/house_type 對照仍標「待驗證」，仍以 `warn` 處理。
- `ok`：乾淨、無推薦/符合條件、資料新鮮。
- `fail`：監測無法完成（見下）。

## Headless 失敗政策（沒有人在看）

- 登入被 CAPTCHA / 2FA / 帳號風控擋住：**絕不繞過**。走失敗逃生口。
- 任何 fetch / enrich 不可恢復的錯誤（pipeline 以非 0 結束）：走失敗逃生口，不要無限重試。
- **部分失敗不是 fail**：例如 ORS 路由全掛時，受影響物件標記為 manual-review、照常出 `warn`，不要當成 fail（`AGENTS.md`：走路距離不可靠者永不自動排除）。
- 失敗逃生口（唯一一條）：

  ```
  npm run pipeline -- fail [profile 參數] [範圍參數] --reason "<短原因>" [tool 參數]
  ```

  它會記錄 run-level 失敗、用安全的 journal tail 組一份 details，送出**一則** `status=fail` 通知，然後停。送出前可先加 `--dry-run` 檢查要送的內容。

## 完成判準

報告已寫且 `notify` 記為 `ok`，**或**失敗逃生口已送出 `fail`。事後都可用 `npm run pipeline -- status [profile 參數] [範圍參數]` 與 journal 檢視——不會有靜默失敗。

## 安全（完整清單見 `AGENTS.md`）

不印 `IBIGFUN_ACCOUNT` / `IBIGFUN_PASSWORD`；不 commit `state/`（含 `state/runs/<profile>/<label>/`）；不繞過登入控制。
