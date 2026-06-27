import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableProfileIds,
  loadProfile,
  resolveProfileFromArgs,
  profileFlags,
  type Profile,
} from './profiles.ts';

test('availableProfileIds lists committed profiles in stable order', () => {
  assert.deepEqual(availableProfileIds(), ['investment', 'owner-occupied']);
});

test('loadProfile validates and returns investment metadata', () => {
  const p = loadProfile('investment');
  assert.equal(p.id, 'investment');
  assert.equal(p.displayName, 'iBigFun 投資房源監測');
  assert.equal(p.notifyTask, '每日 iBigFun 投資房源監測');
  assert.equal(p.ruleDocPath, 'docs/profiles/investment.md');
  assert.equal(p.templatePath, 'templates/investment-notify-template.md');
  assert.equal(p.fetchFilters.enabled, false);
});

test('loadProfile keeps owner-occupied coded filters readable and unverified', () => {
  const p = loadProfile('owner-occupied');
  assert.equal(p.id, 'owner-occupied');
  assert.equal(p.requiresFilterVerification, true);
  assert.equal(p.fetchFilters.enabled, false);
  assert.equal(p.fetchFilters.city?.nameZh, '台北市');
  assert.deepEqual(p.fetchFilters.towns?.map((t) => t.id), ['1', '4', '6', '8', '9']);
  assert.ok(p.fetchFilters.towns?.every((t) => t.nameZh === '待驗證'));
  assert.equal(p.fetchFilters.houseType?.id, '17');
  assert.deepEqual(p.hardCriteria.houseType, { id: '17', nameZh: '待驗證' });
  assert.equal(p.fetchFilters.priceMaxWan, 7000);
  assert.equal(p.fetchFilters.floorMin, 7);
  assert.equal(p.fetchFilters.mainPingMin, 30);
  assert.equal(p.fetchFilters.ageMax, 25);
  assert.equal(p.fetchFilters.parking, '平面');
});

test('loadProfile rejects an unknown id with available ids', () => {
  assert.throws(
    () => loadProfile('missing'),
    /unknown profile "missing"; available profiles: investment, owner-occupied/,
  );
});

test('resolveProfileFromArgs requires --profile', () => {
  assert.throws(
    () => resolveProfileFromArgs(['--date', '2026-06-26']),
    /--profile is required; available profiles: investment, owner-occupied/,
  );
});

test('resolveProfileFromArgs accepts --profile value and --profile=value', () => {
  assert.equal(resolveProfileFromArgs(['--profile', 'investment']).id, 'investment');
  assert.equal(resolveProfileFromArgs(['--profile=owner-occupied']).id, 'owner-occupied');
});

test('resolveProfileFromArgs rejects a missing flag value', () => {
  assert.throws(
    () => resolveProfileFromArgs(['--profile', '--date', '2026-06-26']),
    /--profile is required; available profiles: investment, owner-occupied/,
  );
});

test('profileFlags reproduces the selected profile flag', () => {
  const p = { id: 'owner-occupied' } as Profile;
  assert.equal(profileFlags(p), '--profile owner-occupied');
});
