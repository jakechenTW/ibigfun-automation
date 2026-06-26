import * as fs from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  SELECTORS,
  SIGNIN_PATH_FRAGMENT,
  BLOCKING_SIGNALS,
  STORAGE_STATE_PATH,
} from './config.ts';

/**
 * Raised when login cannot proceed safely (missing creds, CAPTCHA/2FA/risk, or
 * repeated failure). The orchestrator catches this and exits non-zero with a
 * clear message — never bypassing the control. Messages never include secrets.
 */
export class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedError';
  }
}

/**
 * Shim injected into every page before its scripts run. tsx/esbuild transpiles
 * the functions we pass to page.$$eval with a `__name` keep-names helper that
 * is undefined in the browser context; defining it as a no-op makes those
 * evaluations work. Passed as a raw string so it is not itself transpiled.
 */
const NAME_SHIM = 'globalThis.__name = globalThis.__name || function (f) { return f; };';

/** True when HEADED is set to a truthy value (for selector verification). */
function isHeaded(): boolean {
  const v = (process.env.HEADED ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Load project-local .env into process.env without overwriting existing vars. */
export function loadEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Missing .env is fine if the vars are already exported; login will fail
    // later with a clear BlockedError if the credentials are truly absent.
  }
}

/**
 * Launch a browser and a context, reusing a saved session when present.
 *
 * Set `HEADED=1` to run with a visible browser (slowed down) when confirming
 * the selectors in config.ts against the live site — see docs/fetching.md.
 */
export async function createSession(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const headed = isHeaded();
  const browser = await chromium.launch({
    headless: !headed,
    slowMo: headed ? 250 : 0,
  });
  const context = await browser.newContext(
    fs.existsSync(STORAGE_STATE_PATH)
      ? { storageState: STORAGE_STATE_PATH }
      : {},
  );
  await context.addInitScript(NAME_SHIM);
  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * If `page` is on the signin page, log in with .env credentials (visible fields
 * only) and persist the session. No-op when already authenticated.
 *
 * Throws BlockedError on missing creds, CAPTCHA/2FA/risk signals, or a login
 * that still lands on signin.
 */
export async function ensureLoggedIn(
  page: Page,
  context: BrowserContext,
): Promise<void> {
  if (!page.url().includes(SIGNIN_PATH_FRAGMENT)) return;

  const bodyText = ((await page.textContent('body')) ?? '').toLowerCase();
  const hit = BLOCKING_SIGNALS.find((s) => bodyText.includes(s.toLowerCase()));
  if (hit) {
    throw new BlockedError(
      `Login is gated by a control ("${hit}") that must not be bypassed. ` +
        'Complete it manually, then re-run.',
    );
  }

  const account = process.env.IBIGFUN_ACCOUNT;
  const password = process.env.IBIGFUN_PASSWORD;
  if (!account || !password) {
    throw new BlockedError(
      'Missing IBIGFUN_ACCOUNT / IBIGFUN_PASSWORD. Copy .env.example to .env ' +
        'and fill it (see docs/credentials.md).',
    );
  }

  await page.fill(SELECTORS.login.account, account);
  await page.fill(SELECTORS.login.password, password);
  // The visible form has no clickable submit button; Enter submits it. Wait for
  // the URL to leave the signin page (networkidle never fires on this SPA).
  await page.locator(SELECTORS.login.password).press('Enter');
  await page
    .waitForURL((url) => !url.toString().includes(SIGNIN_PATH_FRAGMENT), { timeout: 30000 })
    .catch(() => {});

  if (page.url().includes(SIGNIN_PATH_FRAGMENT)) {
    throw new BlockedError(
      'Still on the signin page after submitting credentials. Check the ' +
        'credentials and the login selectors in scripts/lib/config.ts.',
    );
  }

  await context.storageState({ path: STORAGE_STATE_PATH });
}
