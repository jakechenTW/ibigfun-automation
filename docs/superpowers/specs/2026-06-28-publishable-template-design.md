# Make `ibigfun-automation` a Publishable Open-Source Template — Design

Date: 2026-06-28

## Goal

Turn this repository into a **usable open-source template**: someone can clone
it, swap in their own profile, and run it — without inheriting the author's
personal investment criteria or a hidden personal notification dependency.

The repo already commits no secrets (`.gitignore` covers `.env`, `state/`,
`.cookies.json`, browser artifacts; credentials use `.env.example`; the design
assumes a dedicated automation account). This work closes the remaining gaps
between "no secrets leak" and "a stranger can actually use it."

## Non-Goals (YAGNI)

- No pluggable notifier abstraction layer (env var + fallback is enough).
- No i18n / English translation of the Chinese real-estate domain docs.
- No CI redesign beyond what the above changes require.
- No git-history rewrite — see Decision: Git History.

## Decisions Locked

- **Publish purpose:** usable open-source template.
- **Profiles:** single repo. Commit example profiles; gitignore the author's
  real profiles. Daily runs keep working locally with the same `--profile` ids.
- **Notify:** `NOTIFY_CMD` env var (default `ai-notify`) with a graceful
  fallback when the command is unset/missing.
- **Git history:** Accept existing history (Option A). The historical profile
  values are search filters (a price ceiling + a district list), not
  credentials or identity, so they do not warrant a history rewrite.

## Design

### 1. Profiles — ship examples, keep real ones private

Profile discovery (`scripts/lib/profiles.ts`, `listProfiles`) scans
`profiles/*/profile.json` on disk. A gitignored private folder is therefore
still auto-discovered locally, so no code change is needed for the author's
daily run to keep working.

Changes:

- Add two committed example profiles:
  - `profiles/example-investment/` — `profile.json` + `evaluation.md` +
    `notify-template.md`.
  - `profiles/example-owner-occupied/` — same three files.
- Example `profile.json` values are rounded and obviously illustrative (e.g.
  price ceiling `3000`, two or three districts), and `displayName` is marked
  `(範例)` / `(example)`.
- The `evaluation.md` and `notify-template.md` in the examples keep the existing
  generic *methodology* (premium thresholds, region-gate logic, bucketing,
  report structure). That methodology is not personal data — it is the part
  worth showcasing. Only the `profile.json` numbers are genericized.
- Untrack the author's real folders:
  `git rm --cached -r profiles/investment-taipei profiles/owner-occupied-taipei`,
  then add them to `.gitignore`. The folders remain on disk, so
  `--profile investment-taipei` and `--profile owner-occupied-taipei` keep
  working unchanged.
- Document the convention in `.gitignore` (comment) and `profiles/README.md`:
  the template ships only `example-*` profiles; your own tuned profiles are
  private and gitignored.

Docs that reference the old profile ids as run examples
(`AGENTS.md`, `README.md`, `profiles/README.md`, `prompts/`) are updated to use
the `example-*` ids in their illustrative commands, so a cloner's copy-paste
works against a profile that actually exists in the clone.

### 2. Notify — `NOTIFY_CMD` env + graceful fallback

Today `runNotify` (`scripts/lib/notify.ts`) hard-codes `spawnSync('ai-notify', …)`.

Changes:

- `runNotify` resolves the command from `NOTIFY_CMD` (default `'ai-notify'`).
- Before spawning, check whether the command is runnable. If `NOTIFY_CMD` is
  unset/empty AND the default `ai-notify` is not on `PATH` (or the resolved
  command is not found), do **not** fail the run. Instead:
  - Ensure the rendered report is at the `--details-file` path (the pipeline
    already writes `report.md`).
  - Print a clear, single-line notice:
    `notification skipped — no notifier (set NOTIFY_CMD); report at <path>`.
  - Return `exitCode: 0` so the pipeline treats it as a successful, if silent,
    notification.
- When `NOTIFY_CMD` *is* set but the spawn fails, keep current behavior (return
  the non-zero exit code + stderr) — an explicitly configured notifier that
  breaks is a real error.
- `composeNotifyArgs` / `composeNotifyCommand` stay pure and command-agnostic
  (the command name is applied at spawn time). `composeNotifyCommand` uses the
  resolved command name for display.
- Document the notifier argv contract
  (`--tool / --status / --task / --title / --details-file`) so a cloner can wire
  their own notifier (Slack, email, etc.). Location: extend `docs/credentials.md`
  or add `docs/notifications.md` (implementer's choice; one home, linked from
  `AGENTS.md`'s source-of-truth map).
- `.env.example` gains a commented `NOTIFY_CMD=` with a one-line explanation.

Tests:

- Add coverage for the fallback branch (no notifier → exit 0 + skip notice) and
  the configured-but-failing branch (non-zero exit preserved). Existing
  `composeNotifyArgs` tests stay green.

### 3. Licensing & legal framing

- Add `LICENSE` — **MIT**.
- Add a short disclaimer in `README.md` (and a NOTICE paragraph): for
  personal/educational use; users must respect iBigFun's Terms of Service and
  rate limits and use a dedicated automation account. This is a login-based
  scraper of a third-party site, so the framing is explicit.
- `package.json`: keep `"private": true` (prevents accidental `npm publish`),
  add `license: "MIT"`, `repository`, `author`, and update the `description` to
  match the template framing.

### 4. Docs & repo hygiene

- **README**: reframe from internal "workspace" to a template:
  - What it is and what it explicitly does **not** do (no GUI; Taiwan / iBigFun
    specific; needs your own data inputs).
  - Prerequisites: Node toolchain, an ORS API key, a notifier (or none →
    fallback), a dedicated iBigFun account.
  - A quickstart that ends in a working **dry-run** against an `example-*`
    profile, requiring no real credentials to reach "it ran."
- **`docs/superpowers/`** (~30 plan + spec files): **keep as-is.** They are
  internal development history that harmlessly demonstrates the engineering
  process; removing them rewrites nothing of value. (This design doc lives here
  too.)
- Cross-doc consistency pass so every committed run-command example references
  an `example-*` profile id.

## Affected Files (indicative, not exhaustive)

- `profiles/example-investment/{profile.json,evaluation.md,notify-template.md}` (new)
- `profiles/example-owner-occupied/{profile.json,evaluation.md,notify-template.md}` (new)
- `profiles/investment-taipei/`, `profiles/owner-occupied-taipei/` (untrack + gitignore)
- `.gitignore` (private-profile convention + the two real folders)
- `scripts/lib/notify.ts` (+ `scripts/lib/notify.test.ts`)
- `.env.example` (`NOTIFY_CMD`)
- `LICENSE` (new), `package.json`, `README.md`
- `docs/credentials.md` or `docs/notifications.md` (notifier contract)
- `AGENTS.md`, `profiles/README.md`, `prompts/*` (example-id consistency)

## Verification

- `npm test` passes (including new notify fallback tests).
- Fresh clone simulation: with `profiles/example-investment` only and no
  `NOTIFY_CMD`/`ai-notify`, the pipeline reaches a rendered report and a
  "notification skipped" notice without erroring (using `--dry-run` or offline
  where a live fetch needs credentials).
- `git ls-files profiles/` shows only `example-*` profiles and `README.md` — no
  `*-taipei` folders.
- `git ls-files` shows `LICENSE`.
- The author's real run (`--profile investment-taipei`) still resolves locally.
