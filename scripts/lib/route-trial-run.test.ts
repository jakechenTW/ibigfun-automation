import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  runRouteTrial,
  type RouteTrialDeps,
  type RouteTrialOptions,
} from './route-trial-run.ts';
import { routeTrialRequestPath, routeTrialResultPath } from './runpaths.ts';
import {
  loadValhallaTrialCache,
  trialEndpointKey,
} from './valhalla-trial-cache.ts';
import type { EnrichResult, EnrichedListing, FetchResult, Listing } from './types.ts';

const range = { from: '2026-08-01', to: '2026-08-01', label: '2026-08-01' } as const;
const profileId = 'test-profile';
const baseUrl = 'https://valhalla.test/private-path';
const exitsCsv = [
  'station_id,line,name_zh,exit_id,latitude,longitude',
  'G15,G,甲站,1,25.032,121.518',
  'G15,G,甲站,2,25.033,121.519',
  'R10,R,乙站,1,25.034,121.520',
  '',
].join('\n');

function listing(id: number, coordinate: Listing['coordinate']): Listing {
  return {
    title: `私密物件 ${id}`,
    url: `https://secret.invalid/${id}`,
    addressOrArea: '台北市私密路段',
    nearbyStation: '私密捷運站',
    coordinate,
    publishedDate: '2026-08-01',
    totalPrice: '1500萬',
    totalPing: '30坪',
    unitPrice: '50萬/坪',
    floor: '3',
    totalFloors: '10',
    typeLayout: '華廈',
    age: '20',
    parking: '無車位',
    realPriceUrl: null,
    listingHistory: [],
    id,
    source: '591',
    sourceLink: `https://secret.invalid/${id}`,
    room: 2,
    livingRoom: 1,
    bathroom: 1,
    queryHouseType: null,
    buildingType: null,
  };
}

function enriched(
  original: Listing,
  walk: EnrichedListing['walk'] = null,
): EnrichedListing {
  return {
    ...original,
    totalPriceWan: 1500,
    totalPriceNtd: 15_000_000,
    totalPingNum: 30,
    unitPriceWan: 50,
    ageNum: 20,
    monthlyMortgage: 48_000,
    district: '中山區',
    walk,
    withinWalk: walk === null ? null : true,
    regionGate: 'review',
    reliability: {
      coordPresent: original.coordinate !== null,
      coordConsistent: original.coordinate === null ? null : true,
      routeOk: walk === null ? null : true,
      ratio: walk === null ? null : 1.2,
      reason: null,
    },
    signals: { auctionKeyword: false },
    hardExclusion: { excluded: false, reasons: [] },
    tenure: {
      firstListedDate: null,
      daysOnMarket: null,
      recordCount: 0,
      sourceCount: 0,
      priceTrend: 'unknown',
      firstPrice: null,
      latestPrice: null,
    },
    tenureGate: 'review',
    marketEstimate: {
      status: 'unavailable',
      confidence: 'low',
      subjectOwnershipEvidence: 'unspecified',
      subjectLocationEvidence: null,
      marketUnitPriceMedian: null,
      marketUnitPriceP25: null,
      marketUnitPriceP75: null,
      selectedStage: null,
      sourceFreshness: {
        transactionCheckedAt: null,
        doorplateCheckedAt: null,
        transactionStale: false,
        doorplateStale: false,
      },
      unavailableReasons: ['fixture'],
      comparables: [],
      excludedCandidates: [],
    },
    marketScenarios: {
      registeredUse: { value: 'unknown', source: 'unknown', detail: null },
      parkingFamily: 'unknown',
      parkingCountAssumption: null,
      sourceFreshness: {
        transactionCheckedAt: null,
        doorplateCheckedAt: null,
        transactionStale: false,
        doorplateStale: false,
      },
      scenarios: [],
      reasons: ['fixture'],
    },
  };
}

interface Workspace {
  rootDir: string;
  runDirectory: string;
  requestPath: string;
  listingsPath: string;
  enrichedPath: string;
  mrtPath: string;
  orsCachePath: string;
}

function createWorkspace(
  t: test.TestContext,
  listings: Listing[] = [listing(700001, null)],
  indexes: number[] = listings.map((_item, index) => index),
): Workspace {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-trial-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const runDirectory = path.join(rootDir, 'state', 'runs', profileId, range.label);
  fs.mkdirSync(runDirectory, { recursive: true });
  const requestPath = path.join(rootDir, routeTrialRequestPath(profileId, range.label));
  const listingsPath = path.join(runDirectory, 'listings.json');
  const enrichedPath = path.join(runDirectory, 'enriched.json');
  const mrtPath = path.join(rootDir, 'data', 'taipei_mrt_exits.csv');
  const orsCachePath = path.join(rootDir, 'state', 'route-cache.json');
  fs.mkdirSync(path.dirname(mrtPath), { recursive: true });
  fs.writeFileSync(requestPath, `${JSON.stringify({
    schemaVersion: 1,
    profileId,
    rangeLabel: range.label,
    listingIndexes: indexes,
  }, null, 2)}\n`);
  const fetched: FetchResult = {
    from: range.from,
    to: range.to,
    fetchedAt: '2026-08-02T00:00:00.000Z',
    count: listings.length,
    listings,
  };
  const enrichedListings = listings.map((item) => enriched(item));
  const enrichedResult: EnrichResult = {
    from: range.from,
    to: range.to,
    enrichedAt: '2026-08-02T00:05:00.000Z',
    count: enrichedListings.length,
    withinWalkCount: 0,
    manualReviewCount: enrichedListings.length,
    hardExcludedCount: 0,
    tenureEligible: 0,
    tenureExpired: 0,
    tenureReview: enrichedListings.length,
    outOfRegionCount: 0,
    inRegionTooFarCount: 0,
    marketReliable: 0,
    marketReview: 0,
    marketUnavailable: enrichedListings.length,
    marketDataStale: 0,
    listings: enrichedListings,
  };
  fs.writeFileSync(listingsPath, `${JSON.stringify(fetched, null, 2)}\n`);
  fs.writeFileSync(enrichedPath, `${JSON.stringify(enrichedResult, null, 2)}\n`);
  fs.writeFileSync(mrtPath, exitsCsv);
  fs.writeFileSync(orsCachePath, '{"private-ors-cache":[321]}\n');
  return {
    rootDir,
    runDirectory,
    requestPath,
    listingsPath,
    enrichedPath,
    mrtPath,
    orsCachePath,
  };
}

function options(rootDir: string): RouteTrialOptions {
  return {
    rootDir,
    profileId,
    range,
    valhallaBaseUrl: baseUrl,
    requestDelayMs: 1000,
  };
}

test('runRouteTrial maps missing and malformed local inputs to fixed categories before routing', async (t) => {
  const cases: Array<{
    name: string;
    target: keyof Pick<Workspace, 'requestPath' | 'listingsPath' | 'enrichedPath' | 'mrtPath'>;
    contents?: string;
    expected: string;
  }> = [
    { name: 'missing request', target: 'requestPath', expected: 'Valhalla trial request is missing or invalid' },
    { name: 'malformed request', target: 'requestPath', contents: '{private-json', expected: 'Valhalla trial request is missing or invalid' },
    { name: 'missing listings', target: 'listingsPath', expected: 'Valhalla trial listings input is missing or invalid' },
    { name: 'malformed listings', target: 'listingsPath', contents: '{private-json', expected: 'Valhalla trial listings input is missing or invalid' },
    { name: 'missing enriched', target: 'enrichedPath', expected: 'Valhalla trial enriched input is missing or invalid' },
    { name: 'malformed enriched', target: 'enrichedPath', contents: '{private-json', expected: 'Valhalla trial enriched input is missing or invalid' },
    { name: 'missing MRT', target: 'mrtPath', expected: 'Valhalla trial MRT input is missing or invalid' },
    { name: 'malformed MRT', target: 'mrtPath', contents: 'private-invalid-csv', expected: 'Valhalla trial MRT input is missing or invalid' },
    {
      name: 'blank MRT latitude',
      target: 'mrtPath',
      contents: 'station_id,line,name_zh,exit_id,latitude,longitude\nG15,G,甲站,1,,121.5\n',
      expected: 'Valhalla trial MRT input is missing or invalid',
    },
    {
      name: 'out-of-range MRT latitude',
      target: 'mrtPath',
      contents: 'station_id,line,name_zh,exit_id,latitude,longitude\nG15,G,甲站,1,91,121.5\n',
      expected: 'Valhalla trial MRT input is missing or invalid',
    },
  ];

  for (const inputCase of cases) {
    await t.test(inputCase.name, async (subtest) => {
      const workspace = createWorkspace(subtest);
      if (inputCase.contents === undefined) fs.rmSync(workspace[inputCase.target]);
      else fs.writeFileSync(workspace[inputCase.target], inputCase.contents);
      let routeCalls = 0;

      await assert.rejects(
        runRouteTrial(options(workspace.rootDir), {
          route: async () => {
            routeCalls += 1;
            return [];
          },
        }),
        (error: Error) => error.message === inputCase.expected,
      );
      assert.equal(routeCalls, 0);
    });
  }
});

test('runRouteTrial rejects out-of-range listing coordinates before routing', async (t) => {
  const workspace = createWorkspace(t, [listing(700002, { lat: 91, lng: 121.5 })]);
  let routeCalls = 0;

  await assert.rejects(
    runRouteTrial(options(workspace.rootDir), {
      route: async () => {
        routeCalls += 1;
        return [20, 200, 300];
      },
    }),
    (error: Error) => error.message === 'Valhalla trial listings input is missing or invalid',
  );
  assert.equal(routeCalls, 0);
});

test('runRouteTrial delegates request binding and index validation to selection safely', async (t) => {
  const cases: Array<Record<string, unknown>> = [
    { schemaVersion: 2, profileId, rangeLabel: range.label, listingIndexes: [0] },
    { schemaVersion: 1, profileId: 'private-wrong-profile', rangeLabel: range.label, listingIndexes: [0] },
    { schemaVersion: 1, profileId, rangeLabel: '2099-01-01-private', listingIndexes: [0] },
    { schemaVersion: 1, profileId, rangeLabel: range.label, listingIndexes: [99_999] },
  ];

  for (const request of cases) {
    const workspace = createWorkspace(t);
    fs.writeFileSync(workspace.requestPath, JSON.stringify(request));
    let routeCalls = 0;
    await assert.rejects(
      runRouteTrial(options(workspace.rootDir), {
        route: async () => {
          routeCalls += 1;
          return [];
        },
      }),
      (error: Error) => error.message === 'Valhalla trial request is missing or invalid',
    );
    assert.equal(routeCalls, 0);
  }
});

test('runRouteTrial maps malformed dedicated cache safely before routing', async (t) => {
  const workspace = createWorkspace(t);
  fs.writeFileSync(path.join(workspace.rootDir, 'state', 'valhalla-trial-cache.json'), '{private-cache');
  let routeCalls = 0;

  await assert.rejects(
    runRouteTrial(options(workspace.rootDir), {
      route: async () => {
        routeCalls += 1;
        return [];
      },
    }),
    (error: Error) => error.message === 'Valhalla trial cache is invalid',
  );
  assert.equal(routeCalls, 0);
});

test('runRouteTrial writes an unavailable zero-route artifact without touching either cache', async (t) => {
  const workspace = createWorkspace(t);
  const orsBefore = fs.readFileSync(workspace.orsCachePath);
  let routeCalls = 0;
  let cacheWrites = 0;

  const result = await runRouteTrial(options(workspace.rootDir), {
    route: async () => {
      routeCalls += 1;
      return [];
    },
    saveCache: () => { cacheWrites += 1; },
    now: () => new Date('2026-08-12T01:02:03.000Z'),
  });

  assert.equal(routeCalls, 0);
  assert.equal(cacheWrites, 0);
  assert.deepEqual(fs.readFileSync(workspace.orsCachePath), orsBefore);
  assert.equal(result.artifactPath, path.join(
    workspace.rootDir,
    routeTrialResultPath(profileId, range.label),
  ));
  assert.deepEqual(result.artifact.summary, {
    requested: 1,
    completed: 0,
    cacheHits: 0,
    apiCalls: 0,
    unavailable: 1,
  });
  assert.deepEqual(result.artifact.comparisons, [{
    listingIndex: 0,
    listingId: 700001,
    ors: { status: 'unavailable', stationZh: null, exitId: null, distanceM: null, minutes: null },
    valhalla: { status: 'unavailable', stationZh: null, exitId: null, distanceM: null, minutes: null },
    error: null,
  }]);
  assert.equal(result.artifact.generatedAt, '2026-08-12T01:02:03.000Z');
  assert.equal(result.artifact.valhallaEndpoint, 'https://valhalla.test');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.artifactPath, 'utf8')), result.artifact);
  assert.deepEqual(fs.readdirSync(workspace.runDirectory).sort(), [
    'enriched.json',
    'listings.json',
    'route-trial-request.json',
    'route-trial.json',
  ]);
});

test('runRouteTrial accepts the MRT dataset convention of blank exit identifiers', async (t) => {
  const workspace = createWorkspace(t);
  fs.writeFileSync(workspace.mrtPath, [
    'station_id,line,name_zh,exit_id,latitude,longitude',
    'G15,G,甲站,,25.032,121.518',
    '',
  ].join('\n'));

  const result = await runRouteTrial(options(workspace.rootDir), {
    now: () => new Date('2026-08-12T01:02:03.000Z'),
  });

  assert.equal(result.artifact.summary.requested, 1);
  assert.equal(result.artifact.summary.unavailable, 1);
});

test('runRouteTrial classifies cross-artifact identity drift as invalid enriched input', async (t) => {
  const workspace = createWorkspace(t);
  const result = JSON.parse(fs.readFileSync(workspace.enrichedPath, 'utf8')) as EnrichResult;
  result.listings[0] = { ...result.listings[0], id: 999999 };
  fs.writeFileSync(workspace.enrichedPath, JSON.stringify(result));

  await assert.rejects(
    runRouteTrial(options(workspace.rootDir)),
    (error: Error) => error.message === 'Valhalla trial enriched input is missing or invalid',
  );
});

function replaceEnrichedWalks(workspace: Workspace, distances: number[]): void {
  const result = JSON.parse(fs.readFileSync(workspace.enrichedPath, 'utf8')) as EnrichResult;
  result.listings = result.listings.map((item, index) => enriched(item, {
    stationZh: 'ORS私密站',
    line: 'ORS',
    exitId: `ORS-${index}`,
    distanceM: distances[index],
    minutes: 99,
  }));
  result.withinWalkCount = result.listings.length;
  result.manualReviewCount = 0;
  fs.writeFileSync(workspace.enrichedPath, `${JSON.stringify(result, null, 2)}\n`);
}

test('runRouteTrial deduplicates routes, isolates unique cache hits, rate limits misses, and continues failures', async (t) => {
  const coordinateA = { lat: 25.0321, lng: 121.5181 };
  const coordinateB = { lat: 25.0339, lng: 121.5199 };
  const coordinateC = { lat: 25.0327, lng: 121.5187 };
  const coordinateD = { lat: 25.0342, lng: 121.5202 };
  const listings = [
    listing(710001, coordinateA),
    listing(710002, coordinateA),
    listing(720001, coordinateB),
    listing(720002, coordinateB),
    listing(730001, coordinateC),
    listing(740001, coordinateD),
  ];
  const workspace = createWorkspace(t, listings);
  replaceEnrichedWalks(workspace, [111, 222, 333, 444, 555, 666]);
  const orsBefore = fs.readFileSync(workspace.orsCachePath);
  const endpointKey = trialEndpointKey(baseUrl);
  const cachedRouteKey = '25.03390,121.51990|R10:1,G15:2,G15:1';
  fs.writeFileSync(
    path.join(workspace.rootDir, 'state', 'valhalla-trial-cache.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      endpoints: {
        [endpointKey]: {
          routes: {
            [cachedRouteKey]: {
              distances: [20, 200, 300],
              cachedAt: '2026-08-10T00:00:00.000Z',
            },
          },
        },
      },
    }, null, 2)}\n`,
  );
  const events: string[] = [];
  const progress: string[] = [];
  const origins: Array<{ lat: number; lng: number }> = [];
  let routeActive = false;
  const route: RouteTrialDeps['route'] = async (origin, dests, routeOptions) => {
    assert.equal(routeActive, false);
    assert.equal(routeOptions?.baseUrl, baseUrl);
    assert.equal(dests.length, 3);
    routeActive = true;
    origins.push({ ...origin });
    events.push(`route-${origins.length}`);
    await Promise.resolve();
    routeActive = false;
    if (origin.lat === coordinateC.lat) throw new Error('synthetic-provider-secret');
    return origin.lat === coordinateA.lat ? [20, 200, 300] : [40, 200, 300];
  };

  const result = await runRouteTrial(options(workspace.rootDir), {
    route,
    sleep: async (ms) => {
      assert.equal(routeActive, false);
      assert.equal(ms, 1000);
      events.push('sleep');
    },
    now: () => new Date('2026-08-12T01:02:03.000Z'),
    progress: (message) => progress.push(message),
  });

  assert.deepEqual(origins, [coordinateA, coordinateC, coordinateD]);
  assert.deepEqual(events, ['route-1', 'sleep', 'route-2', 'sleep', 'route-3']);
  assert.deepEqual(progress, [
    'Valhalla trial 1/3',
    'Valhalla trial 2/3',
    'Valhalla trial 3/3',
  ]);
  assert.deepEqual(result.artifact.summary, {
    requested: 6,
    completed: 5,
    cacheHits: 1,
    apiCalls: 3,
    unavailable: 1,
  });
  assert.deepEqual(result.artifact.comparisons.map((item) => item.ors.distanceM), [
    111, 222, 333, 444, 555, 666,
  ]);
  assert.deepEqual(result.artifact.comparisons.map((item) => item.valhalla.distanceM), [
    20, 20, 20, 20, null, 40,
  ]);
  assert.deepEqual(result.artifact.comparisons.map((item) => item.error), [
    null,
    null,
    null,
    null,
    'Valhalla matrix transport failure',
    null,
  ]);
  const savedCache = loadValhallaTrialCache(workspace.rootDir);
  const savedRoutes = savedCache.endpoints[endpointKey].routes;
  assert.deepEqual(savedRoutes['25.03210,121.51810|G15:1,G15:2,R10:1'], {
    distances: [20, 200, 300],
    cachedAt: '2026-08-12T01:02:03.000Z',
  });
  assert.equal(Object.hasOwn(savedRoutes, '25.03270,121.51870|G15:2,G15:1,R10:1'), false);
  assert.deepEqual(savedRoutes['25.03420,121.52020|R10:1,G15:2,G15:1'], {
    distances: [40, 200, 300],
    cachedAt: '2026-08-12T01:02:03.000Z',
  });
  assert.deepEqual(fs.readFileSync(workspace.orsCachePath), orsBefore);
});

test('runRouteTrial converts every provider failure category to safe unavailable evidence and continues', async (t) => {
  const failures = [
    { thrown: new Error('Valhalla matrix HTTP 503'), expected: 'Valhalla matrix HTTP 503' },
    { thrown: new Error('Valhalla matrix timeout after 15000ms'), expected: 'Valhalla matrix timeout after 15000ms' },
    { thrown: new Error('Valhalla matrix invalid matrix shape'), expected: 'Valhalla matrix invalid matrix shape' },
    { thrown: new Error('private transport with coordinates'), expected: 'Valhalla matrix transport failure' },
  ];

  for (const failure of failures) {
    await t.test(failure.expected, async (subtest) => {
      const first = listing(750001, { lat: 25.0321, lng: 121.5181 });
      const second = listing(750002, { lat: 25.0342, lng: 121.5202 });
      const workspace = createWorkspace(subtest, [first, second]);
      const calls: number[] = [];
      const result = await runRouteTrial(options(workspace.rootDir), {
        route: async (origin) => {
          calls.push(origin.lat);
          if (calls.length === 1) throw failure.thrown;
          return [40, 200, 300];
        },
        sleep: async () => {},
        now: () => new Date('2026-08-12T01:02:03.000Z'),
      });

      assert.equal(calls.length, 2);
      assert.equal(result.artifact.comparisons[0].error, failure.expected);
      assert.equal(result.artifact.comparisons[0].valhalla.status, 'unavailable');
      assert.equal(result.artifact.comparisons[1].error, null);
      assert.equal(result.artifact.comparisons[1].valhalla.status, 'reliable');
      const cache = loadValhallaTrialCache(workspace.rootDir);
      const routes = cache.endpoints[trialEndpointKey(baseUrl)].routes;
      assert.equal(Object.keys(routes).length, 1);
    });
  }
});

test('runRouteTrial does not downgrade dedicated cache persistence failure to provider evidence', async (t) => {
  const workspace = createWorkspace(t, [
    listing(760001, { lat: 25.0321, lng: 121.5181 }),
  ]);

  await assert.rejects(
    runRouteTrial(options(workspace.rootDir), {
      route: async () => [20, 200, 300],
      saveCache: () => { throw new Error('Valhalla trial cache persistence failed'); },
      now: () => new Date('2026-08-12T01:02:03.000Z'),
    }),
    (error: Error) => error.message === 'Valhalla trial cache persistence failed',
  );
  assert.equal(fs.existsSync(path.join(
    workspace.rootDir,
    routeTrialResultPath(profileId, range.label),
  )), false);
});

function createCliProfile(rootDir: string): void {
  const profileDirectory = path.join(rootDir, 'profiles', profileId);
  fs.mkdirSync(profileDirectory, { recursive: true });
  fs.writeFileSync(path.join(profileDirectory, 'profile.json'), `${JSON.stringify({
    displayName: 'Test profile',
    fetch: {},
    evaluation: { maxDaysOnMarket: 30 },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(profileDirectory, 'evaluation.md'), '# Test evaluation\n');
  fs.writeFileSync(path.join(profileDirectory, 'notify-template.md'), 'Test template\n');
}

function writeFetchPreload(rootDir: string): string {
  const preloadPath = path.join(rootDir, 'fetch-preload.mjs');
  fs.writeFileSync(preloadPath, [
    "import fs from 'node:fs';",
    'globalThis.fetch = async (input, init) => {',
    '  const capture = process.env.TRIAL_FETCH_CAPTURE;',
    '  if (capture) fs.appendFileSync(capture, `${String(input)}\\n`);',
    "  if (process.env.TRIAL_FETCH_MODE === 'invalid') {",
    "    return new Response(JSON.stringify({ private: 'invalid-response-secret' }), { status: 200 });",
    '  }',
    '  const body = JSON.parse(String(init?.body));',
    '  const distances = body.targets.map((_target, index) => [0.02, 0.2, 0.3][index]);',
    '  return new Response(JSON.stringify({ sources_to_targets: { distances: [distances] } }), {',
    "    status: 200, headers: { 'Content-Type': 'application/json' },",
    '  });',
    '};',
    '',
  ].join('\n'));
  return preloadPath;
}

function cliCommand(
  sourceRoot: string,
  preloadPath: string | null,
  argv: string[],
): string[] {
  return [
    '--import',
    import.meta.resolve('tsx'),
    ...(preloadPath === null ? [] : ['--import', pathToFileURL(preloadPath).href]),
    path.join(sourceRoot, 'scripts', 'route-trial.ts'),
    ...argv,
  ];
}

function runChild(
  command: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('route-trial CLI rejects unknown, repeated, and positional arguments before routing', (t) => {
  const sourceRoot = path.resolve(import.meta.dirname, '..', '..');
  const workspace = createWorkspace(t, [listing(770001, { lat: 25.0321, lng: 121.5181 })]);
  createCliProfile(workspace.rootDir);
  const capturePath = path.join(workspace.rootDir, 'fetch-capture.txt');
  const preloadPath = writeFetchPreload(workspace.rootDir);
  const cases = [
    ['--profile', profileId, '--date', range.from, '--unknown', 'private'],
    ['--profile', profileId, '--profile', profileId, '--date', range.from],
    ['--profile', profileId, '--date', range.from, '--date', range.from],
    ['--profile', profileId, '--date', range.from, 'private-positional'],
  ];

  for (const argv of cases) {
    const result = spawnSync(
      process.execPath,
      cliCommand(sourceRoot, preloadPath, argv),
      {
        cwd: workspace.rootDir,
        encoding: 'utf8',
        env: { ...process.env, TRIAL_FETCH_CAPTURE: capturePath },
      },
    );
    assert.equal(result.status, 2, `${argv.join(' ')}\n${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'BAD INPUT: Invalid route trial arguments\n');
  }
  assert.equal(fs.existsSync(capturePath), false);
});

test('route-trial CLI maps local input errors to aggregate exit 2 messages', (t) => {
  const sourceRoot = path.resolve(import.meta.dirname, '..', '..');
  const workspace = createWorkspace(t);
  createCliProfile(workspace.rootDir);
  fs.rmSync(workspace.requestPath);
  const result = spawnSync(
    process.execPath,
    cliCommand(sourceRoot, null, ['--profile', profileId, '--date', range.from]),
    { cwd: workspace.rootDir, encoding: 'utf8' },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'BAD INPUT: Valhalla trial request is missing or invalid\n');
  assert.equal(result.stderr.includes(workspace.rootDir), false);
  assert.doesNotMatch(result.stderr, /700001|25\.0|private-json/);
});

test('route-trial CLI maps unexpected result persistence failure to fixed exit 1', (t) => {
  const sourceRoot = path.resolve(import.meta.dirname, '..', '..');
  const workspace = createWorkspace(t);
  createCliProfile(workspace.rootDir);
  fs.mkdirSync(path.join(workspace.rootDir, routeTrialResultPath(profileId, range.label)));
  const result = spawnSync(
    process.execPath,
    cliCommand(sourceRoot, null, ['--profile', profileId, '--date', range.from]),
    { cwd: workspace.rootDir, encoding: 'utf8' },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'ERROR: Valhalla trial result persistence failed\n');
  assert.equal(result.stderr.includes(workspace.rootDir), false);
});

test('route-trial CLI succeeds when the real provider stack returns invalid evidence', async (t) => {
  const sourceRoot = path.resolve(import.meta.dirname, '..', '..');
  const workspace = createWorkspace(t, [listing(780001, { lat: 25.0321, lng: 121.5181 })]);
  createCliProfile(workspace.rootDir);
  const preloadPath = writeFetchPreload(workspace.rootDir);
  const secret = 'provider-failure-path-secret';
  const result = await runChild(
    process.execPath,
    cliCommand(sourceRoot, preloadPath, ['--profile', profileId, '--date', range.from]),
    workspace.rootDir,
    {
      ...process.env,
      TRIAL_FETCH_MODE: 'invalid',
      VALHALLA_URL: `https://valhalla.test/${secret}`,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^Valhalla trial 1\/1\n$/);
  const output = JSON.parse(result.stdout) as {
    artifact: string;
    summary: { requested: number; completed: number; cacheHits: number; apiCalls: number; unavailable: number };
  };
  assert.deepEqual(output.summary, {
    requested: 1,
    completed: 0,
    cacheHits: 0,
    apiCalls: 1,
    unavailable: 1,
  });
  assert.equal(fs.existsSync(path.join(workspace.rootDir, output.artifact)), true);
  const artifactBytes = fs.readFileSync(path.join(workspace.rootDir, output.artifact), 'utf8');
  assert.equal(`${result.stdout}\n${result.stderr}\n${artifactBytes}`.includes(secret), false);
  assert.equal(artifactBytes.includes('invalid-response-secret'), false);
});

test('route-trial CLI emits only aggregate JSON/progress and isolates VALHALLA_URL paths in cache', async (t) => {
  const sourceRoot = path.resolve(import.meta.dirname, '..', '..');
  const workspace = createWorkspace(t, [listing(790001, { lat: 25.0321, lng: 121.5181 })]);
  createCliProfile(workspace.rootDir);
  const preloadPath = writeFetchPreload(workspace.rootDir);
  const capturePath = path.join(workspace.rootDir, 'fetch-capture.txt');
  const secrets = ['first-endpoint-secret', 'second-endpoint-secret'];
  const outputs: Array<{ stdout: string; stderr: string }> = [];

  for (const secret of secrets) {
    const result = await runChild(
      process.execPath,
      cliCommand(sourceRoot, preloadPath, ['--profile', profileId, '--date', range.from]),
      workspace.rootDir,
      {
        ...process.env,
        TRIAL_FETCH_CAPTURE: capturePath,
        VALHALLA_URL: `https://valhalla.test/${secret}`,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, 'Valhalla trial 1/1\n');
    outputs.push(result);
  }

  const captured = fs.readFileSync(capturePath, 'utf8').trim().split('\n');
  assert.deepEqual(captured, secrets.map((secret) =>
    `https://valhalla.test/${secret}/sources_to_targets`));
  const cache = loadValhallaTrialCache(workspace.rootDir);
  assert.equal(Object.keys(cache.endpoints).length, 2);
  for (const output of outputs) {
    const parsed = JSON.parse(output.stdout) as {
      artifact: string;
      summary: { requested: number; completed: number; cacheHits: number; apiCalls: number; unavailable: number };
    };
    assert.deepEqual(Object.keys(parsed).sort(), ['artifact', 'summary']);
    assert.equal(parsed.artifact, routeTrialResultPath(profileId, range.label));
    assert.deepEqual(parsed.summary, {
      requested: 1,
      completed: 1,
      cacheHits: 0,
      apiCalls: 1,
      unavailable: 0,
    });
    const artifactBytes = fs.readFileSync(path.join(workspace.rootDir, parsed.artifact), 'utf8');
    for (const secret of secrets) {
      assert.equal(`${output.stdout}\n${output.stderr}\n${artifactBytes}`.includes(secret), false);
    }
    assert.equal(output.stdout.includes(String(790001)), false);
    assert.equal(output.stdout.includes('25.0321'), false);
  }
});
