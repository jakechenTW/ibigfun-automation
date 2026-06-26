/**
 * Shared error type. Lives in its own module (no Playwright import) so pure,
 * unit-tested code can throw it without pulling the browser stack into tests.
 */

/**
 * A condition that needs a human and must not be worked around: missing creds,
 * CAPTCHA/2FA/account-risk, or login that will not stick. The CLIs catch this
 * and exit non-zero with a clear message.
 */
export class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedError';
  }
}
