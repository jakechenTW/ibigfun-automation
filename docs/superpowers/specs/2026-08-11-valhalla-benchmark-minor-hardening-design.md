# Valhalla Benchmark Minor Hardening Design

## Goal

Close the four deferred Valhalla route-benchmark edge cases without changing
the production ORS provider, walking policy, Valhalla request/response
contract, benchmark selection policy, or report/notification behavior.

## Scope

The change is limited to the opt-in `route-benchmark` implementation and its
tests:

- parse `Retry-After` delay-seconds with strict decimal syntax;
- make equal-date, equal-null-ID ordering deterministic through `routeKey`;
- reject unsupported artifact filesystems before any routing request; and
- fail closed when a published artifact's sensitive temporary sibling cannot
  be removed.

No public Valhalla benchmark rerun is required because route requests,
responses, providers, and distance decisions do not change.

## Retry-After Grammar

The client supports only the delay-seconds form used by this benchmark. A
header is valid only when it matches `^(0|[1-9][0-9]*)$`. Hexadecimal,
scientific notation, signs, decimal points, whitespace, and HTTP-date values
use the fixed 1,000 ms fallback. The effective wait remains clamped to the
existing inclusive 1,000–10,000 ms range.

This is deliberately narrower than the complete HTTP `Retry-After` grammar:
HTTP-date support adds clock/date ambiguity without improving this benchmark's
fair-use guarantee.

## Deterministic Null-ID Ordering

Benchmark cases retain the current ordering keys:

1. date ascending;
2. numeric listing ID ascending, with null IDs after numeric IDs; and
3. route key ascending.

When both listing IDs are null, the ID comparison returns equality so the
comparator reaches the route-key tie-breaker. This restores comparator symmetry
and deterministic selection for malformed or source-limited historical rows.

## Artifact Filesystem Preflight

Atomic no-clobber publication continues to use a unique temporary sibling and
same-filesystem hard link with deterministic collision suffixes. The runner
performs a capability preflight in the final artifact directory before reading
sensitive inputs or starting any route request:

1. create a uniquely named probe file with exclusive creation;
2. create a hard link to a second unique probe name;
3. remove both probe paths; and
4. continue only if every required filesystem operation succeeds.

The probe contains no listing, coordinate, endpoint, or route data. Unsupported
filesystems fail early with a fixed safe error. This preserves the existing
atomic no-clobber guarantee; an exclusive-copy fallback is intentionally not
used because it can expose a partially written final artifact.

Probe cleanup follows the same fail-closed rule. A failed preflight cleanup is
an error rather than permission to continue with stale probe files.

## Sensitive Temporary Cleanup

After a successful hard-link publication, failure to remove the detailed
temporary artifact makes the command fail with a fixed safe error. The already
published final artifact remains authoritative and is never removed or
overwritten. Operators can inspect and remove the local `.tmp-*` sibling before
rerunning.

If publication itself fails, the original publication error remains primary;
cleanup is still attempted without replacing that error. Error messages must
not include artifact paths, listing IDs, coordinates, endpoints, or temporary
contents.

## Testing

Each behavior is implemented test-first:

- strict numeric `Retry-After` accepts `0` and ordinary decimal seconds, while
  `0x2`, `+2`, `1e1`, `2.0`, whitespace, and an HTTP date use 1,000 ms;
- two equal-date cases with null IDs sort lexically by route key regardless of
  input order;
- a simulated hard-link failure rejects before the route dependency is called
  and leaves no probe artifacts;
- a preflight succeeds on the normal test filesystem;
- a cleanup-only failure after successful publication rejects with the fixed
  safe error while preserving the final artifact; and
- a publication failure still preserves its original error and attempts
  temporary cleanup.

Focused benchmark tests, the full `npm test` suite, `npx tsc --noEmit`, and
`git diff --check` must pass before integration.

## Success Criteria

- All four deferred findings have direct regression coverage.
- Unsupported hard-link filesystems fail before routing.
- Cleanup-only failure cannot be reported as success.
- No new sensitive data appears in stdout, stderr, committed files, or errors.
- Production routing and automation behavior remain unchanged.
