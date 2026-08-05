import assert from 'node:assert/strict';
import test from 'node:test';
import { routeWalkDistances } from './routing.ts';

test('aborts an ORS request that exceeds the configured timeout', async () => {
  const originalFetch = globalThis.fetch;
  let sawAbort = false;
  globalThis.fetch = (async (_input, init) => {
    await new Promise<void>((resolve) => {
      init?.signal?.addEventListener('abort', () => {
        sawAbort = true;
        resolve();
      }, { once: true });
    });
    throw new DOMException('The operation was aborted.', 'AbortError');
  }) as typeof fetch;

  try {
    await assert.rejects(
      routeWalkDistances(
        { lat: 25.033, lng: 121.565 },
        [{ lat: 25.034, lng: 121.566 }],
        'test-key',
        { timeoutMs: 5 },
      ),
      /timeout/i,
    );
    assert.equal(sawAbort, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
