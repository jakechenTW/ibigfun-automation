/**
 * Centralized iBigFun API configuration: paths, signals, and runtime knobs.
 *
 * The scraper uses pure-fetch calls to iBigFun's JSON APIs rather than
 * browser automation. Credentials are loaded from the environment; cookies are
 * cached in COOKIE_JAR_PATH between runs.
 */

/** Substring that signals iBigFun bounced us to the login page. */
export const SIGNIN_PATH_FRAGMENT = '/user/signin';

/**
 * Substrings that indicate a control we must not bypass (CAPTCHA / 2FA /
 * account-risk). If any appears on the signin page, the scraper stops and asks
 * for manual confirmation rather than attempting to proceed.
 */
export const BLOCKING_SIGNALS = [
  'captcha',
  'recaptcha',
  '驗證碼',
  '兩步驟',
  '二階段',
  '雙重',
  '風險',
  '異常',
];

/** Safety cap on pagination so a runaway loop can't exhaust the API. */
export const MAX_PAGES = 50;

/** Where the cookie jar is cached between runs (git-ignored). */
export const COOKIE_JAR_PATH = '.cookies.json';

/** Max listings fetched concurrently when pulling per-listing history. */
export const HISTORY_CONCURRENCY = 4;

/** Retry budget per history API call (in addition to the first attempt). */
export const HISTORY_RETRIES = 3;

/** Base backoff (ms) for history retries; doubles each attempt. */
export const HISTORY_RETRY_BASE_MS = 500;
