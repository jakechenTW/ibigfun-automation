import * as fs from 'node:fs';
import * as path from 'node:path';
import { isRunComplete, readManifest, type Manifest } from './manifest.ts';
import { runDir } from './runpaths.ts';
import { resolveRange, type RunRange } from './range.ts';

/** Snapshot the backlog before starting work; never infer missing historical days. */
export function recoveryBacklog(profileId: string, target: RunRange): {
  runs: Manifest[]; errors: string[];
} {
  const root = path.dirname(runDir(profileId, target.label));
  if (!fs.existsSync(root)) return { runs: [], errors: [] };
  const runs: Manifest[] = [];
  const errors: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === target.label) continue;
    try {
      const range = resolveRange(entry.name.includes('_')
        ? ['--from', entry.name.split('_')[0], '--to', entry.name.split('_')[1]]
        : ['--date', entry.name], new Date());
      if (range.label !== entry.name || range.to > target.to) continue;
      const m = readManifest(profileId, entry.name);
      if (!m) continue;
      if (m.profileId !== profileId || m.from !== range.from || m.to !== range.to) {
        throw new Error('manifest identity does not match run directory');
      }
      if (!isRunComplete(m)) runs.push(m);
    } catch (error) {
      errors.push(`${profileId}/${entry.name}: ${(error as Error).message}`);
    }
  }
  runs.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { runs, errors };
}
