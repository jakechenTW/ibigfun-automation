// scripts/lib/http.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSignin } from './http.ts';

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
