/**
 * Navigate-with-relogin loop, kept pure (effects injected) so the session-kick
 * recovery is unit-tested without a browser.
 *
 * iBigFun allows only one active login, so the user logging in elsewhere evicts
 * the scraper's session mid-run. This retries the navigation, logging in again
 * each time we land on signin, up to `maxRelogin` times before giving up.
 */
import { BlockedError } from './errors.ts';

export interface ReloginOptions {
  /** Perform the navigation; return the URL we landed on. */
  navigate: () => Promise<string>;
  /** Log in (assumes we are on the signin page). */
  login: () => Promise<void>;
  /** Is this URL the signin page? */
  isSignin: (url: string) => boolean;
  /** Max re-login attempts before giving up. */
  maxRelogin: number;
  /** Optional: called when a re-login happens (e.g. to count/warn). */
  onRelogin?: () => void;
}

/**
 * Navigate; if bounced to signin, log in and retry, up to `maxRelogin` times.
 * Resolves once a navigation lands somewhere other than signin. Throws
 * BlockedError if every attempt still lands on signin.
 */
export async function openWithRelogin(opts: ReloginOptions): Promise<void> {
  for (let attempt = 0; attempt <= opts.maxRelogin; attempt++) {
    const url = await opts.navigate();
    if (!opts.isSignin(url)) return;
    if (attempt < opts.maxRelogin) {
      opts.onRelogin?.();
      await opts.login();
    }
  }
  throw new BlockedError(
    'Repeated signin redirects — login is not sticking. The account may be ' +
      'logged in elsewhere in a tug-of-war, or the credentials/login are failing.',
  );
}
