// scripts/lib/http.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSignin, assertApiOk } from './http.ts';

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
