import assert from 'node:assert/strict';
import test from 'node:test';
import {
  routeValhallaWalkDistances,
} from './valhalla-routing.ts';

function compactMatrixResponse(distances: unknown): Response {
  return new Response(JSON.stringify({
    sources_to_targets: {
      durations: [[315]],
      distances,
    },
    units: 'kilometers',
    algorithm: 'costmatrix',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('sends the Valhalla pedestrian matrix request and converts kilometers to meters', async () => {
  let url = '';
  let headers = new Headers();
  let body: unknown;
  const result = await routeValhallaWalkDistances(
    { lat: 25.033, lng: 121.565 },
    [
      { lat: 25.034, lng: 121.566 },
      { lat: 25.035, lng: 121.567 },
      { lat: 25.036, lng: 121.568 },
    ],
    {
      baseUrl: 'https://example.test/',
      fetchFn: async (input, init) => {
        url = String(input);
        headers = new Headers(init?.headers);
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          sources_to_targets: {
            durations: [[315, null, 754]],
            distances: [[0.42, null, 1.005]],
          },
          units: 'kilometers',
          algorithm: 'costmatrix',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  );

  assert.equal(url, 'https://example.test/sources_to_targets');
  assert.equal(headers.get('X-Client-Id'), 'ibigfun-automation-route-benchmark/0.4');
  assert.deepEqual(body, {
    sources: [{ lat: 25.033, lon: 121.565 }],
    targets: [
      { lat: 25.034, lon: 121.566 },
      { lat: 25.035, lon: 121.567 },
      { lat: 25.036, lon: 121.568 },
    ],
    costing: 'pedestrian',
    costing_options: { pedestrian: { walking_speed: 4.8 } },
    units: 'kilometers',
    verbose: false,
  });
  assert.deepEqual(result, [420, null, 1005]);
});

test('returns no distances without fetching when no destinations are supplied', async () => {
  let calls = 0;
  const result = await routeValhallaWalkDistances(
    { lat: 25.033, lng: 121.565 },
    [],
    { fetchFn: async () => {
      calls += 1;
      return new Response();
    } },
  );

  assert.deepEqual(result, []);
  assert.equal(calls, 0);
});

test('reports a timeout when the request is aborted', async () => {
  let sawAbort = false;
  await assert.rejects(
    routeValhallaWalkDistances(
      { lat: 25.033, lng: 121.565 },
      [{ lat: 25.034, lng: 121.566 }],
      {
        timeoutMs: 5,
        fetchFn: async (_input, init) => {
          await new Promise<void>((resolve) => {
            init?.signal?.addEventListener('abort', () => {
              sawAbort = true;
              resolve();
            }, { once: true });
          });
          throw new DOMException('The operation was aborted.', 'AbortError');
        },
      },
    ),
    /Valhalla matrix timeout after 5ms/,
  );
  assert.equal(sawAbort, true);
});

test('rejects malformed matrix responses without leaking response data', async () => {
  const malformed: Array<() => Response> = [
    () => new Response(JSON.stringify(null)),
    () => new Response(JSON.stringify({ distances: [[0.1]] })),
    () => new Response(JSON.stringify({ sources_to_targets: null })),
    () => compactMatrixResponse([[0.1], [0.2]]),
    () => compactMatrixResponse([[]]),
    () => compactMatrixResponse([[-0.1]]),
    () => compactMatrixResponse([[Number.MAX_VALUE]]),
    () => ({
      ok: true,
      headers: new Headers(),
      json: async () => ({
        sources_to_targets: {
          durations: [[315]],
          distances: [[Number.NaN]],
        },
        units: 'kilometers',
        algorithm: 'costmatrix',
      }),
    } as unknown as Response),
    () => compactMatrixResponse([['0.1']]),
  ];

  for (const makeResponse of malformed) {
    await assert.rejects(
      routeValhallaWalkDistances(
        { lat: 25.033, lng: 121.565 },
        [{ lat: 25.034, lng: 121.566 }],
        { fetchFn: async () => makeResponse() },
      ),
      /invalid matrix shape/,
    );
  }
});

test('reports an HTTP status without leaking the response body', async () => {
  const secretBody = 'do not expose this response body';
  await assert.rejects(
    routeValhallaWalkDistances(
      { lat: 25.033, lng: 121.565 },
      [{ lat: 25.034, lng: 121.566 }],
      { fetchFn: async () => new Response(secretBody, { status: 400 }) },
    ),
    (error: Error) => {
      assert.match(error.message, /HTTP 400/);
      assert.doesNotMatch(error.message, /do not expose/);
      return true;
    },
  );
});

test('retries one 429 using Retry-After seconds', async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const result = await routeValhallaWalkDistances(
    { lat: 25.033, lng: 121.565 },
    [{ lat: 25.034, lng: 121.566 }],
    {
      sleep: async (ms) => { sleeps.push(ms); },
      fetchFn: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response('', { status: 429, headers: { 'Retry-After': '2' } })
          : compactMatrixResponse([[0.42]]);
      },
    },
  );
  assert.deepEqual(result, [420]);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('retries one 503 with the fallback delay', async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const result = await routeValhallaWalkDistances(
    { lat: 25.033, lng: 121.565 },
    [{ lat: 25.034, lng: 121.566 }],
    {
      sleep: async (ms) => { sleeps.push(ms); },
      fetchFn: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response('', { status: 503 })
          : compactMatrixResponse([[0.42]]);
      },
    },
  );
  assert.deepEqual(result, [420]);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [1000]);
});

test('never retries sooner than one second when Retry-After is zero', async () => {
  // Would fail if a server-provided zero delay could start the retry immediately.
  const events: string[] = [];
  let attempts = 0;
  await routeValhallaWalkDistances(
    { lat: 25.033, lng: 121.565 },
    [{ lat: 25.034, lng: 121.566 }],
    {
      sleep: async (ms) => { events.push(`sleep-${ms}`); },
      fetchFn: async () => {
        attempts += 1;
        events.push(`fetch-${attempts}`);
        return attempts === 1
          ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
          : compactMatrixResponse([[0.42]]);
      },
    },
  );

  assert.deepEqual(events, ['fetch-1', 'sleep-1000', 'fetch-2']);
});

test('normalizes a caller-provided sub-second retry cap to one second', async () => {
  // Would fail if the configurable cap could undercut the public-service rate floor.
  const sleeps: number[] = [];
  let attempts = 0;
  await routeValhallaWalkDistances(
    { lat: 25.033, lng: 121.565 },
    [{ lat: 25.034, lng: 121.566 }],
    {
      maxRetryDelayMs: 250,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchFn: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response('', { status: 429, headers: { 'Retry-After': '999' } })
          : compactMatrixResponse([[0.42]]);
      },
    },
  );

  assert.deepEqual(sleeps, [1000]);
});

test('uses the one-second fallback for an invalid Retry-After value', async () => {
  // Would fail if non-decimal or malformed server metadata produced a non-fallback delay.
  for (const retryAfter of ['0x2', '+2', '1e1', '2.0', ' 2 ', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
    const sleeps: number[] = [];
    let attempts = 0;
    await routeValhallaWalkDistances(
      { lat: 25.033, lng: 121.565 },
      [{ lat: 25.034, lng: 121.566 }],
      {
        sleep: async (ms) => { sleeps.push(ms); },
        fetchFn: async () => ++attempts === 1
          ? {
            ok: false,
            status: 503,
            headers: { get: (name: string) => name === 'Retry-After' ? retryAfter : null },
          } as Response
          : compactMatrixResponse([[0.42]]),
      },
    );
    assert.deepEqual(sleeps, [1000], retryAfter);
  }
});

test('stops after two attempts when Valhalla remains unavailable', async () => {
  let attempts = 0;
  await assert.rejects(
    routeValhallaWalkDistances(
      { lat: 25.033, lng: 121.565 },
      [{ lat: 25.034, lng: 121.566 }],
      {
        sleep: async () => {},
        fetchFn: async () => {
          attempts += 1;
          return new Response('', { status: 503 });
        },
      },
    ),
    /HTTP 503/,
  );
  assert.equal(attempts, 2);
});

test('caps Retry-After at the configured maximum delay', async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  await routeValhallaWalkDistances(
    { lat: 25.033, lng: 121.565 },
    [{ lat: 25.034, lng: 121.566 }],
    {
      sleep: async (ms) => { sleeps.push(ms); },
      fetchFn: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response('', { status: 429, headers: { 'Retry-After': '999' } })
          : compactMatrixResponse([[0.42]]);
      },
    },
  );
  assert.deepEqual(sleeps, [10_000]);
});

test('never lets a caller-provided retry cap exceed the global maximum', async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  await routeValhallaWalkDistances(
    { lat: 25.033, lng: 121.565 },
    [{ lat: 25.034, lng: 121.566 }],
    {
      maxRetryDelayMs: 20_000,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchFn: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response('', { status: 429, headers: { 'Retry-After': '999' } })
          : compactMatrixResponse([[0.42]]);
      },
    },
  );
  assert.deepEqual(sleeps, [10_000]);
});

test('rejects malformed or unsafe Valhalla base URLs before transport', async () => {
  // Would fail if relative, non-HTTP, credential-bearing, or secret-bearing URLs reached fetch.
  const secret = 'synthetic-url-secret-7f9c';
  const unsafeUrls = [
    'not-a-url',
    '/relative',
    'ftp://example.test',
    `https://user:${secret}@example.test`,
    `https://example.test?token=${secret}`,
    `https://example.test/#${secret}`,
    'https://[',
  ];
  let fetchCalls = 0;

  for (const baseUrl of unsafeUrls) {
    await assert.rejects(
      routeValhallaWalkDistances(
        { lat: 25.033, lng: 121.565 },
        [{ lat: 25.034, lng: 121.566 }],
        {
          baseUrl,
          fetchFn: async () => {
            fetchCalls += 1;
            return compactMatrixResponse([[0.42]]);
          },
        },
      ),
      (error: Error) => {
        assert.equal(
          error.message,
          'Invalid Valhalla base URL; expected an absolute HTTP(S) URL without credentials, query, or hash.',
        );
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  }

  assert.equal(fetchCalls, 0);
});

test('normalizes unknown transport failures to a fixed safe message', async () => {
  // Would fail if a fetch implementation could leak endpoint or credential text through its exception.
  const secret = 'synthetic-transport-secret-4c2e';
  await assert.rejects(
    routeValhallaWalkDistances(
      { lat: 25.033, lng: 121.565 },
      [{ lat: 25.034, lng: 121.566 }],
      { fetchFn: async () => { throw new Error(`socket failed for ${secret}`); } },
    ),
    (error: Error) => {
      assert.equal(error.message, 'Valhalla matrix transport failure');
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});
