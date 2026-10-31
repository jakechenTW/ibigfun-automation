import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createWalkRouter } from './walk-router.ts';
import { finalizeWalk } from './walk.ts';
import { enrichOffline } from './enrich-offline.ts';
import type { Listing } from './types.ts';

const origin = { lat: 25.033, lng: 121.522 };
const candidate = { exit: { stationId: 'O06', line: 'L', nameZh: '東門', exitId: '4', lat: 25.0335, lng: 121.5285 }, distanceM: 600 };

for (const scenario of [
  { name: 'ORS 12 minutes and Valhalla 9 minutes passes', ors: 960, vh: 720, expected: true, provider: 'valhalla' },
  { name: 'ORS passing route needs no second provider', ors: 720, vh: 960, expected: true, provider: 'ors', vhCalls: 0 },
  { name: 'both reliable routes over 800 meters fail', ors: 960, vh: 1000, expected: false, provider: 'ors' },
  { name: 'unavailable ORS and reliable far Valhalla fails', ors: null, vh: 960, expected: false, provider: 'valhalla' },
  { name: 'implausible ORS and reliable Valhalla passes', ors: 2000, vh: 720, expected: true, provider: 'valhalla' },
  { name: 'two implausible routes remain unresolved', ors: 2000, vh: 2000, expected: null, provider: null },
  { name: 'Valhalla failure retains reliable ORS exclusion', ors: 960, vh: null, expected: false, provider: 'ors' },
  { name: 'both providers failing remains unresolved', ors: null, vh: null, expected: null, provider: null },
  { name: 'missing ORS key still allows Valhalla to pass', ors: null, vh: 720, expected: true, provider: 'valhalla', noKey: true },
  { name: 'missing ORS key and failing Valhalla remains recoverable', ors: null, vh: null, expected: null, provider: null, noKey: true },
]) {
  test(scenario.name, async (t) => {
    const cwd = process.cwd();
    const temp = fs.mkdtempSync(path.join(tmpdir(), 'walk-router-'));
    process.chdir(temp);
    const originalFetch = globalThis.fetch;
    t.after(() => {
      process.chdir(cwd);
      globalThis.fetch = originalFetch;
      fs.rmSync(temp, { recursive: true, force: true });
    });
    let vhCalls = 0;
    globalThis.fetch = (async (url) => {
      if (String(url).includes('openrouteservice')) {
        if (scenario.ors === null) return new Response('unavailable', { status: 500 });
        return Response.json({ distances: [[scenario.ors]] });
      }
      vhCalls++;
      if (scenario.vh === null) return new Response('unavailable', { status: 403 });
      return Response.json({ sources_to_targets: { distances: [[scenario.vh / 1000]] } });
    }) as typeof fetch;
    const router = createWalkRouter({ apiKey: 'noKey' in scenario ? undefined : 'test', baseUrl: 'https://routing.example', sleep: async () => {} }, { event: () => {} });
    const input = { coordinate: origin, candidates: [candidate], coordConsistent: true };
    const result = await router.route(input);
    const offline = enrichOffline({
      title: 'test', addressOrArea: '台北市中正區', coordinate: origin, listingHistory: [],
      url: null, nearbyStation: null, publishedDate: null, totalPrice: null, totalPing: null,
      unitPrice: null, floor: null, totalFloors: null, typeLayout: null, age: null, parking: null,
      realPriceUrl: null, id: null, source: null, sourceLink: null, room: null, livingRoom: null,
      bathroom: null, queryHouseType: null, buildingType: null,
    } satisfies Listing, []);
    const enriched = finalizeWalk({ ...offline, ...input }, result.distances, { targetDate: '2026-10-29', maxDaysOnMarket: 365 });
    assert.equal(enriched.withinWalk, scenario.expected);
    assert.equal(enriched.regionGate, scenario.expected === null ? 'review' : scenario.expected ? 'in' : 'in-region-too-far');
    assert.equal(result.evidence.selectedProvider, scenario.provider);
    assert.equal(vhCalls, scenario.vhCalls ?? 1);
    assert.equal(router.stats.routeErrors,
      (scenario.ors === null && !('noKey' in scenario) ? 1 : 0)
      + (scenario.vh === null && vhCalls > 0 ? 1 : 0));
    // A repeated successful route uses its own provider cache, never the other provider's cache.
    if (scenario.expected === true) {
      await router.route(input);
      assert.equal(vhCalls, scenario.vhCalls ?? 1);
    }
    const calls = vhCalls;
    await router.route({ ...input, coordConsistent: false });
    assert.equal(vhCalls, calls);
  });
}

test('cache persistence failure stops routing instead of becoming a provider failure', async (t) => {
  const cwd = process.cwd();
  const temp = fs.mkdtempSync(path.join(tmpdir(), 'walk-router-write-'));
  const originalFetch = globalThis.fetch;
  process.chdir(temp);
  t.after(() => {
    process.chdir(cwd);
    globalThis.fetch = originalFetch;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ distances: [[720]] });
  }) as typeof fetch;
  const router = createWalkRouter({ apiKey: 'test', baseUrl: 'https://routing.example', sleep: async () => {} }, { event: () => {} });
  fs.mkdirSync('state/route-cache.json', { recursive: true });
  await assert.rejects(router.route({ coordinate: origin, candidates: [candidate], coordConsistent: true }), /EISDIR/);
  assert.equal(calls, 1);
});
