/**
 * Centralized iBigFun page configuration: paths, selectors, and runtime knobs.
 *
 * Selectors below were CONFIRMED against the live authenticated DOM on
 * 2026-06-27 (filtered latest-sale view). The listing view is a single table
 * (`#results table.ttable`) whose rows are listings; most fields live in
 * positional `<td>`s with two `<br>`-separated lines, so extraction reads cells
 * by index (see `td` below and scripts/lib/extract.ts).
 *
 * If iBigFun changes its markup, re-confirm with the approach in
 * docs/fetching.md and update these values.
 */

/** True once selectors are confirmed against the live site. */
export const SELECTORS_VERIFIED = true;

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
  // Login form. The page renders duplicate hidden + visible copies sharing the
  // same ids (see docs/credentials.md), so `:visible` pins the visible field.
  // The form has no clickable visible submit button — submit via Enter on the
  // password field (see scripts/lib/session.ts).
  login: {
    account: '#login-form-username:visible',
    password: '#login-form-password:visible',
  },

  // Listing results. Each listing is a row in the single results table.
  list: {
    // A listing row (filtered to rows that actually contain a title link).
    cardRow: '#results table.ttable tbody > tr',
    titleLink: 'a.subject_href',
    mapLink: 'a.map-address',
    realPriceLink: 'a[href*="/realprice/"]',
    // Per-row cell indices (0-based). Cells hold up to two newline-separated
    // values; extract.ts splits them: price -> [total, unit], ping ->
    // [total, main], landFloor -> [land, floor], typePattern -> [type, layout],
    // ageParking -> [age, parking].
    td: {
      date: 1,
      price: 2,
      ping: 3,
      landFloor: 4,
      typePattern: 5,
      ageParking: 6,
    },
  },
} as const;

/** Safety cap on pagination so a selector mismatch can't loop forever. */
export const MAX_PAGES = 50;

/** Where the browser session is cached between runs (git-ignored). */
export const STORAGE_STATE_PATH = 'storageState.json';
