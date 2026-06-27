// scripts/lib/http.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSignin, assertApiOk, withRetry } from './http.ts';

test('a redirect to /user/signin is a kick', () => {
  assert.equal(
    looksLikeSignin({ status: 302, finalUrl: 'https://www.ibigfun.com/user/signin?return_url=/x', contentType: 'text/html', text: '' }),
    true,
  );
});

test('an HTML login body on a data URL is a kick', () => {
  assert.equal(
    looksLikeSignin({ status: 200, finalUrl: 'https://www.ibigfun.com/api/search/list', contentType: 'text/html; charset=utf-8', text: '<!DOCTYPE html><html><body>login</body></html>' }),
    true,
  );
});

test('a JSON body is not a kick (application/json)', () => {
  assert.equal(
    looksLikeSignin({ status: 200, finalUrl: 'https://www.ibigfun.com/api/search/list', contentType: 'application/json; charset=UTF-8', text: '{"status":"ok"}' }),
    false,
  );
});

test('a JSON body with a text/html content-type is NOT a kick (off-market quirk)', () => {
  assert.equal(
    looksLikeSignin({ status: 200, finalUrl: 'https://www.ibigfun.com/api/query_off_market_by_id', contentType: 'text/html; charset=UTF-8', text: '{"status":"ok","msg":"","total_records":3,"data":[]}' }),
    false,
  );
});

test('assertApiOk passes for a 200 ok envelope', () => {
  assert.doesNotThrow(() => assertApiOk('/api/search/list', 200, 'ok'));
});
test('assertApiOk passes when apiStatus is undefined (200)', () => {
  assert.doesNotThrow(() => assertApiOk('history', 200, undefined));
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
  const msgs = ['first', 'middle', 'last'];
  await assert.rejects(
    withRetry(async () => { throw new Error(msgs[calls++]); }, { retries: 2, baseMs: 0, sleep: async () => {} }),
    /last/,
  );
  assert.equal(calls, 3);
});

test('withRetry doubles the backoff each attempt', async () => {
  const delays: number[] = [];
  // rejection is expected here; the assertion under test is the `delays` sequence
  await assert.rejects(
    withRetry(async () => { throw new Error('e'); }, { retries: 3, baseMs: 100, sleep: async (ms) => { delays.push(ms); } }),
  );
  assert.deepEqual(delays, [100, 200, 400]);
});

test('an HTML login body on the history URL is a kick', () => {
  assert.equal(
    looksLikeSignin({ status: 200, finalUrl: 'https://api.ibigfun.com/on-market/53200935/history', contentType: 'text/html', text: '<html>login</html>' }),
    true,
  );
});
