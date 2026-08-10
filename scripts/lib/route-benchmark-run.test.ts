import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
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
    ['--limit', '+1'],
    ['--limit', '1e2'],
    ['--limit', '0x10'],
    ['--limit', ' 1'],
    ['--limit'],
    ['--limit', '--date', '2026-08-01'],
    ['--limit', '1', '--limit=2'],
  ]) {
    assert.throws(() => parseBenchmarkLimit(argv), /--limit/);
  }
});

test('parseBenchmarkLimit accepts only the documented benchmark CLI grammar', () => {
  assert.equal(parseBenchmarkLimit([
    '--profile=test-profile',
    '--from', '2026-08-01',
    '--to=2026-08-02',
    '--limit', '25',
  ]), 25);
  assert.equal(parseBenchmarkLimit([
    '--profile', 'test-profile',
    '--date=2026-08-01',
  ]), 25);

  const invalid: string[][] = [
    ['--profile', 'test-profile', '--date', '2026-08-01', '--unknown', 'x'],
    ['--profile', 'test-profile', '--date', '2026-08-01', 'positional'],
    ['--profile', 'a', '--profile=b', '--date', '2026-08-01'],
    ['--profile', 'a', '--date', '2026-08-01', '--date=2026-08-02'],
    ['--profile', 'a', '--from', '2026-08-01', '--from=2026-08-02', '--to', '2026-08-03'],
    ['--profile', 'a', '--date', '2026-08-01', '--limit', '1', '--limit=2'],
    ['--profile', '--date', '2026-08-01'],
    ['--profile=', '--date', '2026-08-01'],
  ];
  for (const argv of invalid) {
    assert.throws(() => parseBenchmarkLimit(argv));
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

function createCliProfile(rootDir: string): void {
  const profileDir = path.join(rootDir, 'profiles', 'test-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'profile.json'), `${JSON.stringify({
    displayName: 'Test profile',
    fetch: {},
    evaluation: { maxDaysOnMarket: 30 },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(profileDir, 'evaluation.md'), '# Test evaluation\n');
  fs.writeFileSync(path.join(profileDir, 'notify-template.md'), 'Test template\n');
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

function options(rootDir: string): RouteBenchmarkOptions {
  return {
    rootDir,
    profileId: 'test-profile',
    range: { from: '2026-08-01', to: '2026-08-02', label: '2026-08-01_2026-08-02' },
    limit: 25,
    valhallaBaseUrl: 'https://valhalla.test/synthetic-endpoint-secret-7f9c',
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
    if (captured.length === 1) throw new Error('synthetic-transport-secret-4c2e');
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
  assert.equal(result.artifact.comparisons[0].error, 'Valhalla matrix transport failure');
  assert.equal(result.artifact.comparisons[1].error, null);
  assert.equal(result.artifact.valhallaEndpoint, 'https://valhalla.test');
  assert.equal(Object.hasOwn(result.artifact, 'valhallaBaseUrl'), false);
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
      baseUrl: 'https://valhalla.test/synthetic-endpoint-secret-7f9c',
    },
    {
      origin: { lat: 25.0339, lng: 121.5199 },
      dests: [
        { lat: 25.034, lng: 121.52 },
        { lat: 25.033, lng: 121.519 },
        { lat: 25.032, lng: 121.518 },
      ],
      baseUrl: 'https://valhalla.test/synthetic-endpoint-secret-7f9c',
    },
  ]);
  assert.deepEqual(progressMessages, ['Valhalla benchmark 1/2', 'Valhalla benchmark 2/2']);
  const artifactBytes = fs.readFileSync(result.artifactPath, 'utf8');
  assert.equal(artifactBytes.includes('synthetic-endpoint-secret-7f9c'), false);
  assert.equal(artifactBytes.includes('synthetic-transport-secret-4c2e'), false);
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

test('runRouteBenchmark preserves colliding artifacts and uses a unique temporary sibling', async (t) => {
  // Would fail if a repeated timestamp replaced an earlier artifact or reused the fixed .tmp path.
  const workspace = createWorkspace(t);
  const fixedNow = new Date('2026-08-10T12:34:56.789Z');
  const basePath = benchmarkArtifactPath(
    workspace.rootDir,
    'test-profile',
    '2026-08-01_2026-08-02',
    fixedNow,
  );
  fs.mkdirSync(path.dirname(basePath), { recursive: true });
  const legacyTempPath = `${basePath}.tmp`;
  fs.writeFileSync(legacyTempPath, 'pre-existing-temp-sentinel');
  const deps = {
    route: async () => [650, 750, 850],
    sleep: async () => {},
    now: () => fixedNow,
  };

  const first = await runRouteBenchmark(options(workspace.rootDir), deps);
  const firstBytes = fs.readFileSync(first.artifactPath);
  const second = await runRouteBenchmark(options(workspace.rootDir), deps);

  assert.equal(first.artifactPath, basePath);
  assert.equal(second.artifactPath, basePath.replace(/\.json$/, '-1.json'));
  assert.notEqual(first.artifactPath, second.artifactPath);
  assert.deepEqual(fs.readFileSync(first.artifactPath), firstBytes);
  assert.equal(fs.existsSync(second.artifactPath), true);
  assert.equal(fs.readFileSync(legacyTempPath, 'utf8'), 'pre-existing-temp-sentinel');
  const outputNames = fs.readdirSync(path.dirname(basePath));
  assert.equal(outputNames.some((name) => name.includes('.tmp-')), false);
});

test('runRouteBenchmark removes its unique temporary sibling after publication failure', async (t) => {
  // Would fail if the failure path leaked detailed temporary evidence or removed another run's file.
  const workspace = createWorkspace(t);
  const fixedNow = new Date('2026-08-10T12:34:56.789Z');
  const seenTemps: string[] = [];
  const sentinel = path.join(workspace.rootDir, 'unrelated-sentinel');
  fs.writeFileSync(sentinel, 'keep');

  await assert.rejects(
    runRouteBenchmark(options(workspace.rootDir), {
      route: async () => [650, 750, 850],
      sleep: async () => {},
      now: () => fixedNow,
      publish: (tmpPath) => {
        seenTemps.push(tmpPath);
        assert.equal(fs.existsSync(tmpPath), true);
        throw new Error('synthetic publication failure');
      },
    }),
    /synthetic publication failure/,
  );

  assert.equal(seenTemps.length, 1);
  assert.match(path.basename(seenTemps[0]), /\.json\.tmp-/);
  assert.equal(fs.existsSync(seenTemps[0]), false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
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

test('route-benchmark CLI rejects invalid inputs with exit 2 before benchmark routing', (t) => {
  // Would fail if validation happened after the runner or if user mistakes were reported as persistence failures.
  const sourceRoot = path.resolve(import.meta.dirname, '..', '..');
  const workspace = createWorkspace(t, ['2026-08-01']);
  createCliProfile(workspace.rootDir);
  const script = path.join(sourceRoot, 'scripts', 'route-benchmark.ts');
  const cases: Array<{ argv: string[]; message: RegExp }> = [
    {
      argv: ['--profile', 'does-not-exist', '--date', '2026-08-01'],
      message: /unknown profile/i,
    },
    {
      argv: ['--profile', 'test-profile', '--date', 'bad'],
      message: /invalid --date/i,
    },
    {
      argv: ['--profile', 'test-profile', '--date', '2026-08-01', '--limit', '201'],
      message: /invalid --limit/i,
    },
    {
      argv: ['--profile', 'test-profile', '--date', '2026-08-01', '--unknown', 'x'],
      message: /unknown argument/i,
    },
    {
      argv: ['--profile', 'test-profile', '--profile=test-profile', '--date', '2026-08-01'],
      message: /--profile may be specified only once/i,
    },
    {
      argv: ['--profile', 'test-profile', '--date', '2026-08-01', '--date=2026-08-01'],
      message: /--date may be specified only once/i,
    },
    {
      argv: ['--profile', 'test-profile', '--date', '2026-08-01', '--limit', '1e2'],
      message: /invalid --limit/i,
    },
  ];
  for (const cliCase of cases) {
    const result = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), script, ...cliCase.argv],
      {
        cwd: workspace.rootDir,
        encoding: 'utf8',
        env: { ...process.env, VALHALLA_URL: 'https://user:must-not-leak@valhalla.test' },
      },
    );
    assert.equal(result.status, 2, `${cliCase.argv.join(' ')}\n${result.stderr}`);
    assert.match(result.stderr, /^BAD INPUT: /);
    assert.match(result.stderr, cliCase.message);
    assert.equal(result.stderr.includes('Valhalla benchmark'), false);
    assert.equal(result.stdout, '');
  }
});

test('route-benchmark CLI rejects an unsafe VALHALLA_URL without leaking it', (t) => {
  // Would fail if endpoint validation happened inside per-case routing and the raw URL reached output or an artifact.
  const sourceRoot = path.resolve(import.meta.dirname, '..', '..');
  const workspace = createWorkspace(t, ['2026-08-01']);
  createCliProfile(workspace.rootDir);
  const secret = 'synthetic-cli-url-secret-19ad';
  const result = spawnSync(
    process.execPath,
    [
      '--import', import.meta.resolve('tsx'),
      path.join(sourceRoot, 'scripts', 'route-benchmark.ts'),
      '--profile', 'test-profile',
      '--date', '2026-08-01',
      '--limit', '1',
    ],
    {
      cwd: workspace.rootDir,
      encoding: 'utf8',
      env: { ...process.env, VALHALLA_URL: `https://user:${secret}@valhalla.test` },
    },
  );

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^BAD INPUT: Invalid Valhalla base URL/);
  assert.equal(result.stdout, '');
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(secret), false);
  assert.equal(fs.existsSync(path.join(workspace.rootDir, 'state', 'route-benchmarks')), false);
});

test('route-benchmark CLI succeeds with VALHALLA_URL override and keeps endpoint secrets out of outputs', async (t) => {
  // Would fail if the override were ignored, successful stdout changed shape, or raw endpoint details were persisted/logged.
  const sourceRoot = path.resolve(import.meta.dirname, '..', '..');
  const workspace = createWorkspace(t, ['2026-08-01']);
  createCliProfile(workspace.rootDir);
  const secret = 'synthetic-endpoint-secret-a61b';
  const origin = 'http://127.0.0.1:54321';
  const capturePath = path.join(workspace.rootDir, 'fetch-capture.json');
  const preloadPath = path.join(workspace.rootDir, 'fetch-preload.mjs');
  fs.writeFileSync(preloadPath, [
    "import fs from 'node:fs';",
    'globalThis.fetch = async (input, init) => {',
    '  const body = JSON.parse(String(init?.body));',
    '  fs.writeFileSync(process.env.BENCHMARK_FETCH_CAPTURE, JSON.stringify({ url: String(input), body }));',
    '  const distances = body.targets.map((_target, index) => 0.65 + index * 0.1);',
    '  return new Response(JSON.stringify({',
    '    sources_to_targets: { durations: [distances.map(() => 300)], distances: [distances] },',
    "    units: 'kilometers',",
    "    algorithm: 'costmatrix',",
    "  }), { status: 200, headers: { 'Content-Type': 'application/json' } });",
    '};',
    '',
  ].join('\n'));

  const result = await runChild(
    process.execPath,
    [
      '--import', import.meta.resolve('tsx'),
      '--import', pathToFileURL(preloadPath).href,
      path.join(sourceRoot, 'scripts', 'route-benchmark.ts'),
      '--profile', 'test-profile',
      '--date', '2026-08-01',
      '--limit=1',
    ],
    workspace.rootDir,
    {
      ...process.env,
      BENCHMARK_FETCH_CAPTURE: capturePath,
      VALHALLA_URL: `${origin}/${secret}`,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as { url: string };
  assert.equal(capture.url, `${origin}/${secret}/sources_to_targets`);
  assert.match(result.stderr, /^Valhalla benchmark 1\/1\n$/);
  const stdout = JSON.parse(result.stdout) as {
    artifact: string;
    summary: { selected: number; completed: number; failed: number };
  };
  assert.equal(stdout.summary.selected, 1);
  assert.equal(stdout.summary.completed, 1);
  assert.equal(stdout.summary.failed, 0);
  const artifactPath = path.join(workspace.rootDir, stdout.artifact);
  const artifactBytes = fs.readFileSync(artifactPath, 'utf8');
  const artifact = JSON.parse(artifactBytes) as Record<string, unknown>;
  assert.equal(artifact.valhallaEndpoint, origin);
  assert.equal(Object.hasOwn(artifact, 'valhallaBaseUrl'), false);
  assert.equal(`${result.stdout}\n${result.stderr}\n${artifactBytes}`.includes(secret), false);
});
