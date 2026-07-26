import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureTaipeiMarketData } from './update.ts';

test('updater returns null and journals unavailable when no valid local build can be refreshed', async (t) => {
  const rootPath = join(await mkdtemp(join(tmpdir(), 'market-update-')), 'taipei');
  t.after(() => rm(join(rootPath, '..'), { recursive: true, force: true }));
  const events: string[] = [];
  const bundle = await ensureTaipeiMarketData({
    asOf: '2026-07-25', rootPath,
    fetch: async () => { throw new Error('offline'); },
    logger: { event: (_level, event) => events.push(event) },
  });
  assert.equal(bundle, null);
  assert.deepEqual(events, ['market-data.check', 'market-data.unavailable']);
});
