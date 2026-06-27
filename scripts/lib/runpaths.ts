import * as path from 'node:path';

/** Per-run directory: state/runs/<label>/ (under the git-ignored state/). */
export function runDir(label: string): string {
  return path.join('state', 'runs', label);
}
export function manifestPath(label: string): string {
  return path.join(runDir(label), 'manifest.json');
}
export function journalPath(label: string): string {
  return path.join(runDir(label), 'journal.jsonl');
}
