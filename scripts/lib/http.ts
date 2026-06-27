// scripts/lib/http.ts
/**
 * Browserless HTTP/session layer. Logs in via a plain form POST, persists a
 * cookie jar, and calls the iBigFun JSON APIs with those cookies. Reuses the
 * pure relogin loop (relogin.ts) to recover from a mid-run session kick.
 */
import { SIGNIN_URL, LOGIN_URL, SEARCH_LIST_URL, O2O_SAME_URL, buildSearchBody } from './api.ts';
import type { SearchListResponse, O2oResponse } from './api.ts';
import { applySetCookies, cookieHeader, loadJar, saveJar, type Jar } from './cookies.ts';
import { SIGNIN_PATH_FRAGMENT, BLOCKING_SIGNALS, COOKIE_JAR_PATH } from './config.ts';
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
export function looksLikeSignin(res: { status: number; finalUrl: string; contentType: string }): boolean {
  if (res.finalUrl.includes(SIGNIN_PATH_FRAGMENT)) return true;
  // A data endpoint returning HTML means we were bounced to a login page.
  if (!res.finalUrl.includes(SIGNIN_PATH_FRAGMENT) && res.contentType.includes('text/html')) {
    const isDataUrl = res.finalUrl.includes('/api/') || res.finalUrl.includes('o2o-same');
    if (isDataUrl) return true;
  }
  return false;
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

async function fetchPage(date: string, page: number): Promise<SearchListResponse> {
  return withRelogin(async () => {
    const r = await rawPostForm(SEARCH_LIST_URL, buildSearchBody(date, page), 'https://www.ibigfun.com/lists/latest');
    applySetCookies(getJar(), r.setCookies);
    if (looksLikeSignin(r)) return { kicked: true };
    return { kicked: false, value: JSON.parse(r.text) as SearchListResponse };
  });
}

async function fetchHistory(ids: number[]): Promise<O2oResponse['data']> {
  if (ids.length === 0) return {};
  return withRelogin(async () => {
    const r = await rawGet(`${O2O_SAME_URL}?ids=${ids.join('%2C')}`);
    applySetCookies(getJar(), r.setCookies);
    if (looksLikeSignin(r)) return { kicked: true };
    return { kicked: false, value: (JSON.parse(r.text) as O2oResponse).data ?? {} };
  });
}

/** Ensure we hold a session: log in when the jar has no session cookie. */
async function ensureSession(): Promise<void> {
  if (!getJar().ibigfun_session) await login();
}

/** Real dependencies for collectListings (network-backed). */
export function defaultDeps(): CollectDeps {
  return { ensureSession, fetchPage, fetchHistory };
}
