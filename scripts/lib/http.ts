// scripts/lib/http.ts
/**
 * Browserless HTTP/session layer. Logs in via a plain form POST, persists a
 * cookie jar, and calls the iBigFun JSON APIs with those cookies. Reuses the
 * pure relogin loop (relogin.ts) to recover from a mid-run session kick.
 */
import { SIGNIN_URL, LOGIN_URL, SEARCH_LIST_URL, buildSearchBody, historyUrl, OFF_MARKET_URL, buildOffMarketBody, type FetchMap } from './api.ts';
import type { SearchListResponse, HistoryResponse, OffMarketResponse, HistoryEntry, OffMarketEntry } from './api.ts';
import { applySetCookies, cookieHeader, loadJar, saveJar, type Jar } from './cookies.ts';
import { SIGNIN_PATH_FRAGMENT, BLOCKING_SIGNALS, COOKIE_JAR_PATH, HISTORY_RETRIES, HISTORY_RETRY_BASE_MS } from './config.ts';
import { openWithRelogin } from './relogin.ts';
import { BlockedError } from './errors.ts';
import type { CollectDeps } from './extract.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Load project-local .env into process.env without overwriting existing vars. */
export function loadEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Missing .env is fine if vars are already exported; login fails loudly later.
  }
}

let jar: Jar | null = null;
function getJar(): Jar {
  if (jar === null) jar = loadJar(COOKIE_JAR_PATH);
  return jar;
}

/** True when a data response actually returned the signin page (a kick). */
export function looksLikeSignin(res: {
  status: number;
  finalUrl: string;
  contentType: string;
  text?: string;
}): boolean {
  // A redirect to the signin path is always a kick.
  if (res.finalUrl.includes(SIGNIN_PATH_FRAGMENT)) return true;
  // Trust the body shape over the content-type header: some valid data
  // endpoints (e.g. query_off_market_by_id) return a JSON document with a
  // text/html content-type. A real logged-out bounce returns an HTML page.
  const body = (res.text ?? '').trimStart();
  if (body) return !(body.startsWith('{') || body.startsWith('['));
  // No body to inspect: fall back to the header heuristic (html on a data URL).
  if (res.contentType.includes('text/html')) {
    return res.finalUrl.includes('/api/') || res.finalUrl.includes('/on-market/');
  }
  return false;
}

/** Throw a loud, typed error when an API response is not a 200/"ok" envelope. */
export function assertApiOk(label: string, httpStatus: number, apiStatus: string | undefined): void {
  if (httpStatus !== 200) {
    throw new Error(`${label} returned HTTP ${httpStatus}`);
  }
  if (apiStatus !== undefined && apiStatus !== 'ok') {
    throw new Error(`${label} returned status "${apiStatus}"`);
  }
}

async function rawGet(url: string): Promise<{ status: number; finalUrl: string; contentType: string; text: string; setCookies: string[] }> {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, cookie: cookieHeader(getJar()), accept: 'application/json, text/javascript, */*; q=0.01' },
    redirect: 'manual',
  });
  return {
    status: r.status,
    finalUrl: r.headers.get('location') ?? url,
    contentType: r.headers.get('content-type') ?? '',
    text: await r.text(),
    setCookies: (r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [],
  };
}

async function rawPostForm(url: string, body: string, referer: string): Promise<{ status: number; finalUrl: string; contentType: string; text: string; setCookies: string[] }> {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json, text/javascript, */*; q=0.01',
      cookie: cookieHeader(getJar()),
      referer,
    },
    body,
    redirect: 'manual',
  });
  return {
    status: r.status,
    finalUrl: r.headers.get('location') ?? url,
    contentType: r.headers.get('content-type') ?? '',
    text: await r.text(),
    setCookies: (r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [],
  };
}

/** GET signin (prime cookies + scan for blocking controls), then POST login. */
export async function login(): Promise<void> {
  const j = getJar();
  const s = await fetch(SIGNIN_URL, { headers: { 'user-agent': UA, cookie: cookieHeader(j) }, redirect: 'manual' });
  applySetCookies(j, (s.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []);
  const body = (await s.text()).toLowerCase();
  const hit = BLOCKING_SIGNALS.find((sig) => body.includes(sig.toLowerCase()));
  if (hit) {
    throw new BlockedError(
      `Login is gated by a control ("${hit}") that must not be bypassed. Complete it manually, then re-run.`,
    );
  }
  const account = process.env.IBIGFUN_ACCOUNT;
  const password = process.env.IBIGFUN_PASSWORD;
  if (!account || !password) {
    throw new BlockedError('Missing IBIGFUN_ACCOUNT / IBIGFUN_PASSWORD. Copy .env.example to .env (see docs/credentials.md).');
  }
  const form = new URLSearchParams({ mobile: account, password, return_url: '' }).toString();
  const l = await rawPostForm(LOGIN_URL, form, SIGNIN_URL);
  applySetCookies(j, l.setCookies);
  if (!j.ibigfun_session) {
    throw new BlockedError('Login did not establish a session cookie; credentials or login flow may have changed.');
  }
  saveJar(COOKIE_JAR_PATH, j);
}

/** Run a request, re-logging-in and retrying if bounced to signin. */
async function withRelogin<T>(attempt: () => Promise<{ kicked: boolean; value?: T }>): Promise<T> {
  let out: T | undefined;
  await openWithRelogin({
    navigate: async () => {
      const r = await attempt();
      if (r.kicked) return SIGNIN_URL;
      out = r.value;
      return SEARCH_LIST_URL;
    },
    login: () => login(),
    isSignin: (u) => u.includes(SIGNIN_PATH_FRAGMENT),
    maxRelogin: 2,
    onRelogin: () =>
      console.error('  session was kicked (account logged in elsewhere); re-logging in — this logs out any other session.'),
  });
  return out as T;
}

/** Retry an async call with exponential backoff. Empty results are NOT errors. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown = new Error('withRetry: no attempts made');
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < opts.retries) await sleep(opts.baseMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

async function fetchPage(from: string, to: string, page: number, filters?: FetchMap): Promise<SearchListResponse> {
  return withRelogin(async () => {
    const r = await rawPostForm(SEARCH_LIST_URL, buildSearchBody(from, to, page, filters), 'https://www.ibigfun.com/lists/latest');
    applySetCookies(getJar(), r.setCookies);
    if (looksLikeSignin(r)) return { kicked: true };
    const parsed = JSON.parse(r.text) as SearchListResponse;
    assertApiOk('/api/search/list', r.status, parsed.status);
    return { kicked: false, value: parsed };
  });
}

async function fetchOnMarketHistory(id: number): Promise<HistoryEntry[]> {
  return withRetry(
    () =>
      withRelogin(async () => {
        const r = await rawGet(historyUrl(id));
        applySetCookies(getJar(), r.setCookies);
        if (looksLikeSignin(r)) return { kicked: true };
        const parsed = JSON.parse(r.text) as HistoryResponse;
        assertApiOk(`history ${id}`, r.status, parsed.status);
        return { kicked: false, value: parsed.data ?? [] };
      }),
    { retries: HISTORY_RETRIES, baseMs: HISTORY_RETRY_BASE_MS },
  );
}

async function fetchOffMarketHistory(uuid: string): Promise<OffMarketEntry[]> {
  return withRetry(
    () =>
      withRelogin(async () => {
        const r = await rawPostForm(OFF_MARKET_URL, buildOffMarketBody(uuid), 'https://www.ibigfun.com/lists/latest');
        applySetCookies(getJar(), r.setCookies);
        if (looksLikeSignin(r)) return { kicked: true };
        const parsed = JSON.parse(r.text) as OffMarketResponse;
        assertApiOk('query_off_market_by_id', r.status, parsed.status);
        return { kicked: false, value: parsed.data ?? [] };
      }),
    { retries: HISTORY_RETRIES, baseMs: HISTORY_RETRY_BASE_MS },
  );
}

/** Ensure we hold a session: log in when the jar has no session cookie. */
async function ensureSession(): Promise<void> {
  if (!getJar().ibigfun_session) await login();
}

/** Real dependencies for collectListings (network-backed).
 *  `filters` (when given) are applied to every /api/search/list page. */
export function defaultDeps(filters?: FetchMap): CollectDeps {
  return {
    ensureSession,
    fetchPage: (from, to, page) => fetchPage(from, to, page, filters),
    fetchOnMarketHistory,
    fetchOffMarketHistory,
  };
}
