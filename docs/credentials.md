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

Future automation code should load credentials from the local environment:

```bash
IBIGFUN_ACCOUNT
IBIGFUN_PASSWORD
```

Do not print either value in logs, notifications, reports, screenshots, or debugging output.

## Operational Rule

If iBigFun blocks login with CAPTCHA, 2FA, or account-risk checks, stop and ask for manual confirmation. Do not bypass those controls.
