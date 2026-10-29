# Review standards

Run `npm run check` for the same test and typecheck sequence that CI uses.

## Regression tests

Make sure that each regression test fails before the fix for the intended reason.
Keep unrelated fixture values equal or valid so another rejection cannot hide the defect.
Use the public operation that exposes the defect.
Record the failing assertion or error and the passing result in the review evidence.
If reproducing the original failure is impractical, state that limitation explicitly.

## Behavior-preserving refactors

Run the same public-contract tests against the baseline and the refactored implementation.
Record both results and identify any contract that the tests do not cover.
Separate this compatibility evidence from defect-regression evidence in the review.
A missing module or method proves that an interface is absent, not that a test detects incorrect behavior.
If the refactor also fixes a defect, apply the regression-test requirements to that fix separately.

## Persisted state

For changes that read persisted state, trace reading, validation, migration, use, and recovery across callers.
Consider missing data, malformed data, and unsupported versions separately.
Make sure that invalid state reaches the required recovery outcome without unintended side effects.
Include diagnostics and work-list generation in the trace, because either can fail after the unsafe action stops.
Require regression tests for concrete failure paths found during review.
