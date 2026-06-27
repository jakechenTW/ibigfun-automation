import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from './journal.ts';

test('redact replaces secret-looking keys with [redacted]', () => {
  const out = redact({
    cookie: 'ibigfun_session=abc',
    password: 'hunter2',
    IBIGFUN_ACCOUNT: 'me@example.com',
    authorization: 'Bearer x',
    httpStatus: 429,
    url: '/on-market/123/history',
  }) as Record<string, unknown>;
  assert.equal(out.cookie, '[redacted]');
  assert.equal(out.password, '[redacted]');
  assert.equal(out.IBIGFUN_ACCOUNT, '[redacted]'); // matches /account/i
  assert.equal(out.authorization, '[redacted]');
  assert.equal(out.httpStatus, 429); // safe field kept
  assert.equal(out.url, '/on-market/123/history');
});

test('redact recurses into nested objects and arrays', () => {
  const out = redact({ resp: { setCookie: 'x', status: 200 }, ids: [1, 2] }) as any;
  assert.equal(out.resp.setCookie, '[redacted]'); // matches /cookie/i
  assert.equal(out.resp.status, 200);
  assert.deepEqual(out.ids, [1, 2]);
});

test('redact truncates long strings to a bounded snippet', () => {
  const long = 'a'.repeat(800);
  const out = redact(long) as string;
  assert.ok(out.length < 600);
  assert.ok(out.endsWith('…'));
});

import * as fs from 'node:fs';
import { appendJournal, readJournal } from './journal.ts';
import { runDir } from './runpaths.ts';

test('appendJournal then readJournal round-trips and redacts data', () => {
  const profileId = 'investment';
  const date = '0002-02-02'; // throwaway run dir
  try {
    appendJournal(profileId, date, { ts: 't1', step: 'fetch', level: 'info', event: 'step.start', msg: 'go' });
    appendJournal(profileId, date, { ts: 't2', step: 'fetch', level: 'error', event: 'history.drop',
      msg: 'boom', data: { cookie: 'secret', listingId: 5 } });
    const evs = readJournal(profileId, date);
    assert.equal(evs.length, 2);
    assert.equal(evs[0].event, 'step.start');
    assert.deepEqual(evs[1].data, { cookie: '[redacted]', listingId: 5 });
  } finally {
    fs.rmSync(runDir(profileId, date), { recursive: true, force: true });
  }
});

test('appendJournal caps an over-long msg to a bounded snippet', () => {
  const profileId = 'owner-occupied';
  const date = '0005-05-05';
  try {
    appendJournal(profileId, date, { ts: 't', step: 'notify', level: 'error', event: 'notify.sent', msg: 'x'.repeat(900) });
    const evs = readJournal(profileId, date);
    assert.ok(evs[0].msg.length < 600);
    assert.ok(evs[0].msg.endsWith('…'));
  } finally {
    fs.rmSync(runDir(profileId, date), { recursive: true, force: true });
  }
});
