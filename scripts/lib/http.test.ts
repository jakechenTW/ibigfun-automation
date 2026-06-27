// scripts/lib/http.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSignin, assertApiOk, withRetry } from './http.ts';

test('a redirect to /user/signin is a kick', () => {
  assert.equal(
    looksLikeSignin({ status: 302, finalUrl: 'https://www.ibigfun.com/user/signin?return_url=/x', contentType: 'text/html' }),
    true,
  );
});

test('an HTML body on a data URL (logged out) is a kick', () => {
  assert.equal(
    looksLikeSignin({ status: 200, finalUrl: 'https://www.ibigfun.com/api/search/list', contentType: 'text/html; charset=utf-8' }),
    true,
  );
});

test('a 200 JSON response is not a kick', () => {
  assert.equal(
    looksLikeSignin({ status: 200, finalUrl: 'https://www.ibigfun.com/api/search/list', contentType: 'application/json; charset=UTF-8' }),
    false,
  );
});

test('assertApiOk passes for a 200 ok envelope', () => {
  assert.doesNotThrow(() => assertApiOk('/api/search/list', 200, 'ok'));
});
test('assertApiOk passes when apiStatus is undefined (200)', () => {
  assert.doesNotThrow(() => assertApiOk('o2o-same', 200, undefined));
});
test('assertApiOk throws on a non-200 status', () => {
  assert.throws(() => assertApiOk('/api/search/list', 502, 'ok'), /HTTP 502/);
});
test('assertApiOk throws on a non-ok api status', () => {
  assert.throws(() => assertApiOk('/api/search/list', 200, 'error'), /status "error"/);
});

test('withRetry returns immediately on success (one call)', async () => {
  let calls = 0;
  const v = await withRetry(async () => { calls++; return 42; }, { retries: 3, baseMs: 0, sleep: async () => {} });
  assert.equal(v, 42);
  assert.equal(calls, 1);
});

test('withRetry retries then succeeds', async () => {
  let calls = 0;
  const v = await withRetry(async () => { calls++; if (calls < 3) throw new Error('x'); return 'ok'; },
    { retries: 3, baseMs: 0, sleep: async () => {} });
  assert.equal(v, 'ok');
  assert.equal(calls, 3);
});

test('withRetry gives up after retries+1 attempts and throws the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('always'); }, { retries: 2, baseMs: 0, sleep: async () => {} }),
    /always/,
  );
  assert.equal(calls, 3);
});

test('withRetry doubles the backoff each attempt', async () => {
  const delays: number[] = [];
  await assert.rejects(
    withRetry(async () => { throw new Error('e'); }, { retries: 3, baseMs: 100, sleep: async (ms) => { delays.push(ms); } }),
  );
  assert.deepEqual(delays, [100, 200, 400]);
});

test('an HTML body on the history URL is a kick', () => {
  assert.equal(
    looksLikeSignin({ status: 200, finalUrl: 'https://api.ibigfun.com/on-market/53200935/history', contentType: 'text/html' }),
    true,
  );
});
