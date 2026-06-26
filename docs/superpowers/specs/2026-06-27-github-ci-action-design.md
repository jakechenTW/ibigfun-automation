# GitHub CI Action — Design

**Date:** 2026-06-27
**Status:** Approved

## Goal

Add a GitHub Actions workflow that runs the repository's deterministic checks
(unit tests + TypeScript typecheck) on every push and pull request, giving a
safety net that catches regressions in the pure library code before merge.

## Scope

In scope:

- A single CI workflow: `.github/workflows/ci.yml`.
- Run `npm test` (the pure unit-test suite) and `npx tsc --noEmit`.

Explicitly out of scope (and why):

- **No scrape/enrich on a schedule.** Those steps need the single shared
  iBigFun account; running them in CI would kick the user's own browser
  session. They also stop short of the agent-judgment steps (triage, market
  price, report writing), which cannot run in plain GitHub Actions.
- **No secrets.** The test suite is pure library code (`scripts/lib/*.test.ts`)
  and never launches a browser or calls an external API.
- **No `playwright install`.** No test launches a browser, so the chromium
  download is unnecessary.

## Workflow

File: `.github/workflows/ci.yml`

**Triggers:** `push` (all branches) and `pull_request`. This catches breakage
on feature branches and on PRs targeting `main`.

**Job `test`** on `ubuntu-latest`:

1. `actions/checkout@v4`
2. `actions/setup-node@v4` with `node-version: 22` and `cache: npm`
3. `npm ci` — reproducible install from `package-lock.json`
4. `npm test` — runs the 13 pure unit-test files via `node --import tsx --test`
5. `npx tsc --noEmit` — typecheck (kept as a separate step so the log shows
   plainly which check failed)

## Rationale

- **Node 22** matches `@types/node ^22` in `package.json`.
- **`npm ci`** requires the committed `package-lock.json` (present) and gives
  deterministic installs.
- **Separate test and typecheck steps** rather than a combined command: clearer
  failure attribution in the Actions log.

## Success criteria

- Workflow runs on push and PR.
- Green when `npm test` and `npx tsc --noEmit` both pass (they pass locally
  today).
- No secrets configured; no browser downloaded; run completes in well under a
  minute of compute beyond install.
