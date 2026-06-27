# iBigFun Automation Credentials

Use a dedicated iBigFun account for automation instead of a personal primary account.

## Storage

Credentials are stored in a project-local `.env` file. Copy `.env.example` to `.env` and fill it locally:

```bash
cp .env.example .env
```

Use these names:

- `IBIGFUN_ACCOUNT`: iBigFun automation login phone/email
- `IBIGFUN_PASSWORD`: iBigFun automation password

The real `.env` file is ignored by `.gitignore`.

## Retrieval Pattern

Automation code and browser-login helpers should load credentials from the local environment:

```bash
IBIGFUN_ACCOUNT
IBIGFUN_PASSWORD
```

Do not print either value in logs, notifications, reports, screenshots, or debugging output.

## Session Storage

Login is a form POST to `https://www.ibigfun.com/user/login` (no browser, no
CSRF token). On success the server sets an `ibigfun_session` cookie. The cookie
jar is persisted locally to `.cookies.json` (git-ignored) and reused on
subsequent runs, replacing the old `storageState.json`.

The full login flow and API endpoints are documented in `docs/fetching.md`. This
file owns only how the secrets are stored and the rule for stopping on blocked
login.

## Operational Rule

If iBigFun blocks login with CAPTCHA, 2FA, account-risk checks, missing
credentials, a login response with no `ibigfun_session` cookie, or repeated
login failure, the run raises `BlockedError` and stops immediately. Do not
bypass those controls.

Interactive agents must stop and ask the user for manual confirmation.
Headless workers must use the pipeline failure escape hatch and include the
agent identity explicitly:

```bash
npm run pipeline -- fail --profile <profile> [--date <d> | --from <a> --to <b>] \
  --reason "<short>" --tool <codex|claude>
```
