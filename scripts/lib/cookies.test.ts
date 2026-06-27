import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applySetCookies, cookieHeader, loadJar, saveJar, type Jar } from './cookies.ts';

test('applySetCookies stores name=value and ignores attributes', () => {
  const jar: Jar = {};
  applySetCookies(jar, ['ibigfun_session=abc123; Path=/; HttpOnly; Secure', 'api_token=tok; Secure']);
  assert.equal(jar.ibigfun_session, 'abc123');
  assert.equal(jar.api_token, 'tok');
});

test('applySetCookies overwrites an existing cookie', () => {
  const jar: Jar = { ibigfun_session: 'old' };
  applySetCookies(jar, ['ibigfun_session=new; Path=/']);
  assert.equal(jar.ibigfun_session, 'new');
});

test('cookieHeader joins with "; "', () => {
  assert.equal(cookieHeader({ a: '1', b: '2' }), 'a=1; b=2');
});

test('loadJar returns {} for a missing file, round-trips via saveJar', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jar-')), 'c.json');
  assert.deepEqual(loadJar(p), {});
  saveJar(p, { ibigfun_session: 'z' });
  assert.deepEqual(loadJar(p), { ibigfun_session: 'z' });
});
