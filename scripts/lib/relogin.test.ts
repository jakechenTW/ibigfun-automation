import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWithRelogin } from './relogin.ts';

const isSignin = (url: string) => url.includes('/user/signin');

test('no signin redirect -> returns without logging in', async () => {
  let navs = 0;
  let logins = 0;
  await openWithRelogin({
    navigate: async () => { navs++; return 'https://site/lists'; },
    login: async () => { logins++; },
    isSignin,
    maxRelogin: 2,
  });
  assert.equal(navs, 1);
  assert.equal(logins, 0);
});

test('kicked once then recovers -> logs in once, retries', async () => {
  let navs = 0;
  let logins = 0;
  await openWithRelogin({
    navigate: async () => { navs++; return navs === 1 ? 'https://site/user/signin' : 'https://site/lists'; },
    login: async () => { logins++; },
    isSignin,
    maxRelogin: 2,
  });
  assert.equal(navs, 2);
  assert.equal(logins, 1);
});

test('always kicked -> throws after maxRelogin, bounded login calls', async () => {
  let navs = 0;
  let logins = 0;
  let relogins = 0;
  await assert.rejects(
    openWithRelogin({
      navigate: async () => { navs++; return 'https://site/user/signin'; },
      login: async () => { logins++; },
      isSignin,
      maxRelogin: 2,
      onRelogin: () => { relogins++; },
    }),
    /Repeated signin redirects/,
  );
  assert.equal(navs, 3); // attempts 0,1,2
  assert.equal(logins, 2); // no login after the final navigation
  assert.equal(relogins, 2);
});

test('login failure propagates (e.g. BlockedError on missing creds)', async () => {
  await assert.rejects(
    openWithRelogin({
      navigate: async () => 'https://site/user/signin',
      login: async () => { throw new Error('missing creds'); },
      isSignin,
      maxRelogin: 2,
    }),
    /missing creds/,
  );
});
