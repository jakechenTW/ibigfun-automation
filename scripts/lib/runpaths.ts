import * as path from 'node:path';

/** Per-run directory: state/runs/<date>/ (under the git-ignored state/). */
export function runDir(date: string): string {
  return path.join('state', 'runs', date);
}
export function manifestPath(date: string): string {
  return path.join(runDir(date), 'manifest.json');
}
export function journalPath(date: string): string {
  return path.join(runDir(date), 'journal.jsonl');
}
