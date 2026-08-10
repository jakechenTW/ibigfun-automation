import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  benchmarkArtifactPath,
  inclusiveDates,
  parseBenchmarkLimit,
  runRouteBenchmark,
  type RouteBenchmarkDeps,
  type RouteBenchmarkOptions,
} from './route-benchmark-run.ts';
import type { Listing } from './types.ts';

test('parseBenchmarkLimit defaults to 25 when --limit is omitted', () => {
  assert.equal(parseBenchmarkLimit(['--profile', 'example-investment']), 25);
});

test('parseBenchmarkLimit accepts one safe integer from 1 through 200', () => {
  assert.equal(parseBenchmarkLimit(['--limit', '1']), 1);
  assert.equal(parseBenchmarkLimit(['--limit=25']), 25);
  assert.equal(parseBenchmarkLimit(['--limit', '200']), 200);
});

test('parseBenchmarkLimit rejects invalid or repeated limits', () => {
  for (const argv of [
    ['--limit', '0'],
    ['--limit', '201'],
    ['--limit', '1.5'],
    ['--limit'],
    ['--limit', '--date', '2026-08-01'],
    ['--limit', '1', '--limit=2'],
  ]) {
    assert.throws(() => parseBenchmarkLimit(argv), /--limit/);
  }
});

test('inclusiveDates enumerates every UTC date in an inclusive range', () => {
  assert.deepEqual(inclusiveDates('2026-07-30', '2026-08-02'), [
    '2026-07-30',
    '2026-07-31',
    '2026-08-01',
    '2026-08-02',
  ]);
});

test('benchmarkArtifactPath includes profile, range label, and sanitized UTC timestamp', () => {
  const rootDir = path.join(path.sep, 'tmp', 'benchmark-root');
  assert.equal(
    benchmarkArtifactPath(
      rootDir,
      'example-investment',
      '2026-08-01',
      new Date('2026-08-10T12:34:56.789Z'),
    ),
    path.join(
      rootDir,
      'state',
      'route-benchmarks',
      'example-investment',
      '2026-08-01',
      'valhalla-20260810T123456789Z.json',
    ),
  );
});

const exitsCsv = [
  'station_id,line,name_zh,exit_id,latitude,longitude',
  'R10,R,甲站,1,25.032,121.518',
  'R10,R,甲站,2,25.033,121.519',
  'G05,G,乙站,1,25.034,121.520',
  '',
].join('\n');

function listing(
  id: number,
  title: string,
  addressOrArea: string,
  url: string,
  coordinate: { lat: number; lng: number },
): Listing {
  return {
    title,
    url,
    addressOrArea,
    nearbyStation: '私密捷運站',
    coordinate,
    publishedDate: null,
    totalPrice: null,
    totalPing: null,
    unitPrice: null,
    floor: null,
    totalFloors: null,
    typeLayout: null,
    age: null,
    parking: null,
    realPriceUrl: null,
    listingHistory: [],
    id,
    source: null,
    sourceLink: url,
    room: null,
    livingRoom: null,
    bathroom: null,
    queryHouseType: null,
    buildingType: null,
  };
}

function createWorkspace(t: test.TestContext, dates = ['2026-08-01', '2026-08-02']): {
  rootDir: string;
  listingPaths: string[];
  cachePath: string;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-benchmark-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'data', 'taipei_mrt_exits.csv'), exitsCsv);

  const fixtures = [
    listing(9123456, '不可洩漏標題甲', '台北市中正區不可洩漏路1號', 'https://secret.invalid/one', {
      lat: 25.0321,
      lng: 121.5181,
    }),
    listing(9234567, '不可洩漏標題乙', '台北市中正區不可洩漏路2號', 'https://secret.invalid/two', {
      lat: 25.0339,
      lng: 121.5199,
    }),
  ];
  const listingPaths = dates.map((date, index) => {
    const listingPath = path.join(rootDir, 'state', 'runs', 'test-profile', date, 'listings.json');
    fs.mkdirSync(path.dirname(listingPath), { recursive: true });
    fs.writeFileSync(listingPath, `${JSON.stringify({
      from: date,
      to: date,
      fetchedAt: `${date}T20:00:00.000Z`,
      count: 1,
      listings: [fixtures[index]],
    }, null, 2)}\n`);
    return listingPath;
  });

  const cachePath = path.join(rootDir, 'state', 'route-cache.json');
  fs.writeFileSync(cachePath, `${JSON.stringify({
    '25.03210,121.51810|R10:1,R10:2,G05:1': [600, 700, 800],
    '25.03390,121.51990|G05:1,R10:2,R10:1': [610, 710, 810],
  }, null, 2)}\n`);
  return { rootDir, listingPaths, cachePath };
}

function options(rootDir: string): RouteBenchmarkOptions {
  return {
    rootDir,
    profileId: 'test-profile',
    range: { from: '2026-08-01', to: '2026-08-02', label: '2026-08-01_2026-08-02' },
    limit: 25,
    valhallaBaseUrl: 'https://valhalla.test',
    requestDelayMs: 1000,
  };
}

test('runRouteBenchmark loads every day, runs sequentially, continues after failure, and persists safely', async (t) => {
  // Would fail if inputs are skipped/mutated, requests overlap or leak listing data, failures abort, or persistence bypasses the sibling rename.
  const workspace = createWorkspace(t);
  const listingBytesBefore = workspace.listingPaths.map((file) => fs.readFileSync(file));
  const cacheBytesBefore = fs.readFileSync(workspace.cachePath);
  const captured: Array<{
    origin: { lat: number; lng: number };
    dests: Array<{ lat: number; lng: number }>;
    baseUrl: string | undefined;
  }> = [];
  const events: string[] = [];
  const sleeps: number[] = [];
  const progressMessages: string[] = [];
  let routeActive = false;
  const route: RouteBenchmarkDeps['route'] = async (origin, dests, routeOptions) => {
    assert.equal(routeActive, false);
    assert.ok(routeOptions);
    routeActive = true;
    captured.push({
      origin: { ...origin },
      dests: dests.map((dest) => ({ ...dest })),
      baseUrl: routeOptions.baseUrl,
    });
    events.push(`route-${captured.length}`);
    await Promise.resolve();
    routeActive = false;
    if (captured.length === 1) throw new Error('synthetic matrix failure');
    return [650, 750, 850];
  };

  const result = await runRouteBenchmark(options(workspace.rootDir), {
    route,
    sleep: async (ms) => {
      assert.equal(routeActive, false);
      sleeps.push(ms);
      events.push('sleep');
    },
    now: () => new Date('2026-08-10T12:34:56.789Z'),
    progress: (message) => progressMessages.push(message),
  });

  assert.deepEqual(result.artifact.inputDates, ['2026-08-01', '2026-08-02']);
  assert.equal(result.artifact.schemaVersion, 1);
  assert.equal(result.artifact.comparisons.length, 2);
  assert.equal(result.artifact.comparisons[0].error, 'synthetic matrix failure');
  assert.equal(result.artifact.comparisons[1].error, null);
  assert.deepEqual(events, ['route-1', 'sleep', 'route-2']);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(fs.existsSync(result.artifactPath), true);
  assert.equal(fs.existsSync(`${result.artifactPath}.tmp`), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.artifactPath, 'utf8')), result.artifact);
  assert.equal(fs.readFileSync(result.artifactPath, 'utf8').endsWith('\n'), true);
  assert.deepEqual(workspace.listingPaths.map((file) => fs.readFileSync(file)), listingBytesBefore);
  assert.deepEqual(fs.readFileSync(workspace.cachePath), cacheBytesBefore);
  assert.deepEqual(captured, [
    {
      origin: { lat: 25.0321, lng: 121.5181 },
      dests: [
        { lat: 25.032, lng: 121.518 },
        { lat: 25.033, lng: 121.519 },
        { lat: 25.034, lng: 121.52 },
      ],
      baseUrl: 'https://valhalla.test',
    },
    {
      origin: { lat: 25.0339, lng: 121.5199 },
      dests: [
        { lat: 25.034, lng: 121.52 },
        { lat: 25.033, lng: 121.519 },
        { lat: 25.032, lng: 121.518 },
      ],
      baseUrl: 'https://valhalla.test',
    },
  ]);
  assert.deepEqual(progressMessages, ['Valhalla benchmark 1/2', 'Valhalla benchmark 2/2']);
  const progress = progressMessages.join('\n');
  for (const secret of [
    '9123456', '9234567',
    '不可洩漏路1號', '不可洩漏路2號',
    '不可洩漏標題甲', '不可洩漏標題乙',
    'https://secret.invalid/one', 'https://secret.invalid/two',
    '25.0321', '121.5181', '25.0339', '121.5199',
  ]) {
    assert.equal(progress.includes(secret), false);
  }
});

test('runRouteBenchmark rejects a missing daily input before routing', async (t) => {
  // Would fail if range loading silently skipped an absent date or reached the network first.
  const workspace = createWorkspace(t, ['2026-08-01']);
  let calls = 0;
  await assert.rejects(
    runRouteBenchmark(options(workspace.rootDir), {
      route: async () => {
        calls += 1;
        return [];
      },
    }),
    /missing listing input.*2026-08-02/i,
  );
  assert.equal(calls, 0);
});

test('runRouteBenchmark rejects malformed route cache JSON before routing', async (t) => {
  // Would fail if invalid cached evidence were treated as an empty cache or routing began before validation.
  const workspace = createWorkspace(t);
  fs.writeFileSync(workspace.cachePath, '{not-json');
  let calls = 0;
  await assert.rejects(
    runRouteBenchmark(options(workspace.rootDir), {
      route: async () => {
        calls += 1;
        return [];
      },
    }),
    /route cache.*JSON/i,
  );
  assert.equal(calls, 0);
});

test('runRouteBenchmark rejects an invalid FetchResult shape before routing', async (t) => {
  // Would fail if syntactically valid non-FetchResult JSON reached selection or routing.
  const workspace = createWorkspace(t);
  fs.writeFileSync(workspace.listingPaths[0], '{}');
  let calls = 0;
  await assert.rejects(
    runRouteBenchmark(options(workspace.rootDir), {
      route: async () => {
        calls += 1;
        return [];
      },
    }),
    /invalid FetchResult shape/i,
  );
  assert.equal(calls, 0);
});

test('runRouteBenchmark rejects malformed fields consumed from nested listings before routing', async (t) => {
  // Would fail if the FetchResult boundary checked only that each listing was a plain object.
  const cases: Array<{
    name: string;
    mutate: (listing: Record<string, unknown>) => void;
    serialize?: (document: Record<string, unknown>) => string;
  }> = [
    { name: 'missing title', mutate: (item) => { delete item.title; } },
    { name: 'non-string title', mutate: (item) => { item.title = 42; } },
    { name: 'missing addressOrArea', mutate: (item) => { delete item.addressOrArea; } },
    { name: 'non-string totalPrice', mutate: (item) => { item.totalPrice = 1000; } },
    { name: 'non-string totalPing', mutate: (item) => { item.totalPing = false; } },
    { name: 'non-string unitPrice', mutate: (item) => { item.unitPrice = []; } },
    { name: 'non-string age', mutate: (item) => { item.age = {}; } },
    { name: 'non-numeric id', mutate: (item) => { item.id = '9123456'; } },
    { name: 'missing coordinate', mutate: (item) => { delete item.coordinate; } },
    { name: 'non-numeric coordinate longitude', mutate: (item) => {
      item.coordinate = { lat: 25.0321, lng: '121.5181' };
    } },
    {
      name: 'non-finite coordinate latitude',
      mutate: () => {},
      serialize: (document) => JSON.stringify(document).replace('"lat":25.0321', '"lat":1e400'),
    },
  ];

  for (const malformed of cases) {
    await t.test(malformed.name, async (subtest) => {
      const workspace = createWorkspace(subtest);
      const document = JSON.parse(fs.readFileSync(workspace.listingPaths[0], 'utf8')) as {
        listings: Array<Record<string, unknown>>;
      } & Record<string, unknown>;
      malformed.mutate(document.listings[0]);
      fs.writeFileSync(
        workspace.listingPaths[0],
        malformed.serialize?.(document) ?? JSON.stringify(document),
      );
      let calls = 0;

      await assert.rejects(
        runRouteBenchmark(options(workspace.rootDir), {
          route: async () => {
            calls += 1;
            return [];
          },
          sleep: async () => {},
        }),
        /listing input for 2026-08-01 has invalid FetchResult shape/i,
      );
      assert.equal(calls, 0);
    });
  }
});

test('runRouteBenchmark accepts an explicit null coordinate and classifies it as skipped', async (t) => {
  // Would fail if boundary validation confused the documented null coordinate with a missing/malformed field.
  const workspace = createWorkspace(t);
  const document = JSON.parse(fs.readFileSync(workspace.listingPaths[0], 'utf8')) as {
    listings: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  document.listings[0].coordinate = null;
  fs.writeFileSync(workspace.listingPaths[0], JSON.stringify(document));
  let calls = 0;

  const { artifact } = await runRouteBenchmark(options(workspace.rootDir), {
    route: async () => {
      calls += 1;
      return [650, 750, 850];
    },
    sleep: async () => {},
  });

  assert.equal(artifact.summary.skipped['no-coordinate'], 1);
  assert.equal(artifact.summary.selected, 1);
  assert.equal(calls, 1);
});

test('runRouteBenchmark rejects inconsistent daily FetchResult metadata before routing', async (t) => {
  // Would fail if typed-looking metadata were trusted without matching the daily artifact or listing count.
  const cases: Array<{
    name: string;
    mutate: (document: Record<string, unknown>) => void;
  }> = [
    { name: 'wrong from date', mutate: (document) => { document.from = '2026-07-31'; } },
    { name: 'wrong to date', mutate: (document) => { document.to = '2026-08-02'; } },
    { name: 'invalid fetchedAt', mutate: (document) => { document.fetchedAt = 'not-a-timestamp'; } },
    { name: 'listing count mismatch', mutate: (document) => { document.count = 2; } },
  ];

  for (const malformed of cases) {
    await t.test(malformed.name, async (subtest) => {
      const workspace = createWorkspace(subtest);
      const document = JSON.parse(fs.readFileSync(workspace.listingPaths[0], 'utf8')) as Record<string, unknown>;
      malformed.mutate(document);
      fs.writeFileSync(workspace.listingPaths[0], JSON.stringify(document));
      let calls = 0;

      await assert.rejects(
        runRouteBenchmark(options(workspace.rootDir), {
          route: async () => {
            calls += 1;
            return [];
          },
          sleep: async () => {},
        }),
        /listing input for 2026-08-01 has invalid FetchResult shape/i,
      );
      assert.equal(calls, 0);
    });
  }
});

test('runRouteBenchmark rejects a structurally invalid route cache before routing', async (t) => {
  // Would fail if valid JSON with the wrong cache shape were treated as cached route evidence.
  const workspace = createWorkspace(t);
  fs.writeFileSync(workspace.cachePath, '[]');
  let calls = 0;
  await assert.rejects(
    runRouteBenchmark(options(workspace.rootDir), {
      route: async () => {
        calls += 1;
        return [];
      },
    }),
    /route cache.*invalid shape/i,
  );
  assert.equal(calls, 0);
});

test('runRouteBenchmark removes only its temporary sibling when final rename fails', async (t) => {
  // Would fail if persistence wrote the final file directly, left temporary data, or removed the conflicting target.
  const workspace = createWorkspace(t);
  const fixedNow = new Date('2026-08-10T12:34:56.789Z');
  const artifactPath = benchmarkArtifactPath(
    workspace.rootDir,
    'test-profile',
    '2026-08-01_2026-08-02',
    fixedNow,
  );
  fs.mkdirSync(artifactPath, { recursive: true });
  const sentinel = path.join(artifactPath, 'sentinel');
  fs.writeFileSync(sentinel, 'keep');

  await assert.rejects(
    runRouteBenchmark(options(workspace.rootDir), {
      route: async () => [650, 750, 850],
      sleep: async () => {},
      now: () => fixedNow,
    }),
  );

  assert.equal(fs.existsSync(`${artifactPath}.tmp`), false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});

test('route-benchmark CLI rejects invalid inputs with exit 2 before benchmark routing', () => {
  // Would fail if validation happened after the runner or if user mistakes were reported as persistence failures.
  const cwd = path.resolve(import.meta.dirname, '..', '..');
  const cases = [
    ['--profile', 'does-not-exist', '--date', '2026-08-01'],
    ['--profile', 'example-investment', '--date', 'bad'],
    ['--profile', 'example-investment', '--date', '2026-08-01', '--limit', '201'],
  ];
  for (const argv of cases) {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/route-benchmark.ts', ...argv],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, VALHALLA_URL: 'http://127.0.0.1:1/must-not-be-used' },
      },
    );
    assert.equal(result.status, 2, `${argv.join(' ')}\n${result.stderr}`);
    assert.match(result.stderr, /^BAD INPUT: /);
    assert.equal(result.stderr.includes('Valhalla benchmark'), false);
    assert.equal(result.stdout, '');
  }
});
