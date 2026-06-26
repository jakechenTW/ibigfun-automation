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

## Browser Login Flow

1. Try the target iBigFun page in the in-app browser.
2. If the browser redirects to `/user/signin`, load `IBIGFUN_ACCOUNT` and `IBIGFUN_PASSWORD` from the project-local `.env`.
3. Fill the visible login form only. The page may contain duplicate hidden login inputs, so prefer visible fields rather than matching by duplicate IDs alone.
4. After login, reopen the target filtered URL with the explicit report date.
5. Do not log, print, screenshot, or include either credential value in memory, reports, notifications, or debug output.

## Operational Rule

If iBigFun blocks login with CAPTCHA, 2FA, account-risk checks, missing credentials, or repeated login failure, stop and ask for manual confirmation. Do not bypass those controls.
