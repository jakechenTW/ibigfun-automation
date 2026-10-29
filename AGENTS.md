# Agent Instructions (iBigFun Automation)

This is the shared entrypoint for Codex and Claude Code.
Read this file before operating in the repository.
The monitor fetches iBigFun sale listings for an explicit profile, prepares a Markdown report, and delivers a notification.
iBigFun aggregates other sites, so canonical listing URLs often point to the originating source.

## Required reading

- Before exploring the codebase, read [docs/agents/domain.md](docs/agents/domain.md).
  It defines the single-context layout and when to read the glossary and architecture decisions.
- Before generating a report or changing monitor behavior, read [docs/running.md](docs/running.md) in full.
  Also read [reporting rules](docs/reporting-rules.md), [credentials](docs/credentials.md), and [automation state](docs/automation-state.md).
  The runbook owns first-run prerequisites, profile/date selection, recovery order, evaluation steps, and pipeline commands.
- Before a profile run, read its `profile.json`, `evaluation.md`, and `notify-template.md` under `profiles/<profile>/`.
  Select the profile explicitly. Never infer it.
  Use [profiles/README.md](profiles/README.md) before creating profiles or applying fetch overrides.
- Before fetching listings, read [docs/fetching.md](docs/fetching.md).
- Before enrichment, walking triage, route trials, or benchmarks, read [docs/routing.md](docs/routing.md).
  Keep report decisions under the shared reporting rules and the selected profile's evaluation policy.
- Before operating or changing market-data updates, candidate evaluation, backtests, acceptance, or storage, read [docs/market-data.md](docs/market-data.md).
- Before approving or delivering reports, read [docs/notifications.md](docs/notifications.md).
  Approve the canonical report through `pipeline mark report`, then deliver through `pipeline run`.
  Never bypass approval with a direct notifier call for report delivery.
- For headless runs, also follow [prompts/daily-run.md](prompts/daily-run.md).
  Before scheduling, read [prompts/schedule-triggers.md](prompts/schedule-triggers.md).
- Before reviewing changes, read [CODING_STANDARDS.md](CODING_STANDARDS.md).
  Use `npm run check` for the shared local and CI validation command.

## Operational boundaries

The independent market-data writer runs once per Taipei calendar day and finishes before profile pipelines start.
Profile enrichment reads only the validated active build/acceptance pair.
Profile workers never refresh, rebuild, backtest, or publish market data as inline recovery.
A failed writer retains last-known-good data, subject to freshness warnings and fail-closed recommendation rules.

Complete the recorded recovery work list before the current run, using each item's original range.
Record failures and continue with other backlog items and the current run.
Never recursively recover or retry indefinitely.

## Safety rules

- Never commit real credentials, cookies, sessions, browser profiles,
  screenshots with secrets, or raw local output containing secrets.
- Never commit local automation state, traces, HAR files, downloaded HTML pages,
  or browser storage files unless sanitized and explicitly requested.
- Use `.env.example` as the committed template; the real `.env` stays local.
- Do not print `IBIGFUN_ACCOUNT` or `IBIGFUN_PASSWORD` in logs, reports,
  notifications, screenshots, or debug output.
- If login is blocked by CAPTCHA, 2FA, or account-risk checks, interactive
  agents stop and ask for manual confirmation. Headless daily workers must use
  `npm run pipeline -- fail ... --tool <codex|claude>`. Do not bypass those
  controls.
- Generated reports and local run state under `state/` (incl.
  `state/runs/<profile>/<label>/`) are git-ignored. Do not commit them unless
  the user explicitly asks.

## Other task references

Issues and specs live in GitHub Issues.
Before working with tickets, read [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
Before labeling issues, read [docs/agents/triage-labels.md](docs/agents/triage-labels.md) and use its five default triage labels.
Use [data/README.md](data/README.md) for static datasets and mappings.
Keep automation memory to recent summaries and short-lived notes.
Promote durable decisions into the relevant reference document.
