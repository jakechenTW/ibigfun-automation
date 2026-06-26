/**
 * Centralized iBigFun page configuration: paths, selectors, and runtime knobs.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ VERIFY BEFORE TRUSTING                                                     │
 * │ The selectors below are BEST-EFFORT GUESSES. They were NOT confirmed       │
 * │ against the live authenticated iBigFun DOM (the site is login-gated and    │
 * │ JS-rendered). On the first real run, `SELECTORS_VERIFIED` is false and the │
 * │ scraper prints a prominent warning. Open the page with real credentials,   │
 * │ confirm/adjust each `VERIFY:` selector below, then set                     │
 * │ `SELECTORS_VERIFIED = true`. See docs/fetching.md.                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

/** Flip to true only after confirming every selector against the live site. */
export const SELECTORS_VERIFIED = false;

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

export const SELECTORS = {
  // Login form. Fill the VISIBLE fields only — the page has duplicate hidden
  // login inputs (see docs/credentials.md), so these target the visible form.
  login: {
    // VERIFY:
    account: 'form:visible input[name="account"]',
    // VERIFY:
    password: 'form:visible input[name="password"]',
    // VERIFY:
    submit: 'form:visible button[type="submit"]',
  },

  // Listing results.
  list: {
    // VERIFY: a single listing card/row container.
    card: '.case-list .case-item',
    // VERIFY: title text node within a card.
    title: '.case-item__title',
    // VERIFY: anchor to the listing detail page within a card.
    link: 'a.case-item__link',
    // VERIFY: the Google Maps address link within a card (href parsed for coords).
    mapLink: 'a[href*="google.com/maps"], a[href*="maps.google"]',
    // VERIFY: the iBigFun real-price (實價登錄) link within a card.
    realPriceLink: 'a[href*="real"], a[href*="實價"]',
    // VERIFY: per-field text nodes within a card.
    address: '.case-item__address',
    publishedDate: '.case-item__date',
    totalPrice: '.case-item__price',
    totalPing: '.case-item__ping',
    unitPrice: '.case-item__unit-price',
    floor: '.case-item__floor',
    totalFloors: '.case-item__total-floor',
    typeLayout: '.case-item__type',
    age: '.case-item__age',
    parking: '.case-item__parking',
  },
} as const;

/** Safety cap on pagination so a selector mismatch can't loop forever. */
export const MAX_PAGES = 50;

/** Where the browser session is cached between runs (git-ignored). */
export const STORAGE_STATE_PATH = 'storageState.json';
