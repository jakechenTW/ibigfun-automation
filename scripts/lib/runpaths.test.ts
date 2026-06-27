import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDir, manifestPath, journalPath, listingsPath, enrichedPath, reportPath } from './runpaths.ts';

test('all run paths resolve under state/runs/<profile>/<label>/ for a single-day label', () => {
  const P = 'owner-occupied';
  const L = '2026-06-26';
  assert.equal(runDir(P, L), 'state/runs/owner-occupied/2026-06-26');
  assert.equal(manifestPath(P, L), 'state/runs/owner-occupied/2026-06-26/manifest.json');
  assert.equal(journalPath(P, L), 'state/runs/owner-occupied/2026-06-26/journal.jsonl');
  assert.equal(listingsPath(P, L), 'state/runs/owner-occupied/2026-06-26/listings.json');
  assert.equal(enrichedPath(P, L), 'state/runs/owner-occupied/2026-06-26/enriched.json');
  assert.equal(reportPath(P, L), 'state/runs/owner-occupied/2026-06-26/report.md');
});

test('all run paths resolve under state/runs/<profile>/<label>/ for a range label', () => {
  const P = 'investment';
  const L = '2026-06-20_2026-06-25';
  assert.equal(listingsPath(P, L), 'state/runs/investment/2026-06-20_2026-06-25/listings.json');
  assert.equal(enrichedPath(P, L), 'state/runs/investment/2026-06-20_2026-06-25/enriched.json');
  assert.equal(reportPath(P, L), 'state/runs/investment/2026-06-20_2026-06-25/report.md');
});
