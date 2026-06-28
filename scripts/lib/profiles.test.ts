import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableProfileIds, loadProfile, resolveProfileFromArgs, profileFlags, type Profile } from './profiles.ts';

test('availableProfileIds discovers on-disk profile folders, sorted', () => {
  const ids = availableProfileIds();
  assert.ok(ids.includes('investment-taipei'));
  assert.ok(ids.includes('owner-occupied-taipei'));
  assert.deepEqual(ids, [...ids].sort());
});

test('loadProfile returns id (=folder), displayName, and fetch map', () => {
  const p = loadProfile('investment-taipei');
  assert.equal(p.id, 'investment-taipei');
  assert.equal(p.displayName, 'iBigFun 台北投資房源監測');
  assert.deepEqual(p.fetch.price_segment, { max: 2500 });
  assert.equal(p.fetch.city, '1');
});

test('loadProfile reads owner-occupied fetch arrays + ranges', () => {
  const p = loadProfile('owner-occupied-taipei');
  assert.deepEqual(p.fetch.town, ['1', '4', '6', '8', '9']);
  assert.deepEqual(p.fetch.house_type, ['17']);
  assert.deepEqual(p.fetch.house_age_segment, { max: 25 });
  assert.equal(p.fetch.parking, '平面');
});

test('loadProfile rejects an unknown id with available ids', () => {
  assert.throws(() => loadProfile('missing'), /unknown profile "missing"; available profiles: /);
});

test('resolveProfileFromArgs requires --profile and accepts both forms', () => {
  assert.throws(() => resolveProfileFromArgs(['--date', '2026-06-26']), /--profile is required/);
  assert.equal(resolveProfileFromArgs(['--profile', 'investment-taipei']).id, 'investment-taipei');
  assert.equal(resolveProfileFromArgs(['--profile=owner-occupied-taipei']).id, 'owner-occupied-taipei');
});

test('profileFlags reproduces the selected profile flag', () => {
  assert.equal(profileFlags({ id: 'investment-taipei' } as Profile), '--profile investment-taipei');
});
