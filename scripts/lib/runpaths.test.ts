import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDir, manifestPath, journalPath, listingsPath, enrichedPath, reportPath } from './runpaths.ts';

test('all run paths resolve under state/runs/<label>/ for a single-day label', () => {
  const L = '2026-06-26';
  assert.equal(runDir(L), 'state/runs/2026-06-26');
  assert.equal(manifestPath(L), 'state/runs/2026-06-26/manifest.json');
  assert.equal(journalPath(L), 'state/runs/2026-06-26/journal.jsonl');
  assert.equal(listingsPath(L), 'state/runs/2026-06-26/listings.json');
  assert.equal(enrichedPath(L), 'state/runs/2026-06-26/enriched.json');
  assert.equal(reportPath(L), 'state/runs/2026-06-26/report.md');
});

test('all run paths resolve under state/runs/<label>/ for a range label', () => {
  const L = '2026-06-20_2026-06-25';
  assert.equal(listingsPath(L), 'state/runs/2026-06-20_2026-06-25/listings.json');
  assert.equal(enrichedPath(L), 'state/runs/2026-06-20_2026-06-25/enriched.json');
  assert.equal(reportPath(L), 'state/runs/2026-06-20_2026-06-25/report.md');
});
