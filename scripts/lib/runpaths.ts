import * as path from 'node:path';

/** Per-run directory: state/runs/<profile>/<label>/ (under git-ignored state/). */
export function runDir(profileId: string, label: string): string {
  return path.join('state', 'runs', profileId, label);
}
export function manifestPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'manifest.json');
}
export function journalPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'journal.jsonl');
}
export function listingsPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'listings.json');
}
export function enrichedPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'enriched.json');
}
export function reportPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'report.md');
}
export function routeTrialRequestPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'route-trial-request.json');
}
export function routeTrialResultPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'route-trial.json');
}
/** Optional, agent-authored evidence for bounded external valuation review. */
export function valuationReviewPath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'valuation-review.json');
}
export function effectiveProfilePath(profileId: string, label: string): string {
  return path.join(runDir(profileId, label), 'effective-profile.json');
}
