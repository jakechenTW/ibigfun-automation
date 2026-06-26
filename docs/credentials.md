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

## Browser Login

The browser login flow (when, where, and how to enter these credentials during
a fetch) lives in `docs/fetching.md`. This file owns only how the secrets are
stored and the rule for stopping on blocked login.

## Operational Rule

If iBigFun blocks login with CAPTCHA, 2FA, account-risk checks, missing credentials, or repeated login failure, stop and ask for manual confirmation. Do not bypass those controls.
