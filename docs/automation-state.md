# Automation State

Future automation should keep durable local state for listing discovery and deduplication.

## Seen Listings

Track each discovered listing by stable listing ID. Use the source's stable numeric listing ID from the URL when available (e.g. 591, rakuya), since iBigFun aggregates listings that originate on other sites.

Recommended fields:

- `listing_id`: stable source listing ID.
- `source`: listing source, such as `591` or `ibigfun`.
- `first_seen_date`: first local discovery date in `YYYY-MM-DD`.
- `last_seen_date`: most recent local discovery date in `YYYY-MM-DD`.
- `published_date`: listing published date shown by the source.
- `url`: canonical listing URL.
- `title`: latest known listing title.
- `status`: latest source status, such as `active`, `sold`, `removed`, or `unknown`.
- `last_reported_date`: most recent date included in a notification.
- `content_hash`: optional hash of key listing fields for edit detection.

## Deduplication Rules

- Treat a listing as new only when its `listing_id` has not appeared before.
- If a known listing changes materially, keep the original `first_seen_date` and update `last_seen_date` plus `content_hash`.
- If a source republishes the same property under a new ID, include it only when the title, address, price, or floor data indicates it is materially different.
- Do not rely only on the displayed published date for daily new-listing detection.

## Storage

Keep local state out of git by default. A future implementation can store it under `state/`, which is ignored by `.gitignore`.

If a sanitized sample state file is useful for tests or documentation, place it under `docs/examples/` and remove real listing history before committing.

## Recovery and delivery

The per-run manifest is the durable recovery queue. All four steps must be
`ok` before a run is complete. `failureNotification.sentAt` records a failure
alert independently; it never substitutes for successful report delivery.
Legacy manifests that marked notify `ok` while retaining a run failure are
migrated on read so their report can be delivered after recovery.

`pipeline recover --profile <id> [date/range flags] --tool <codex|claude>`
snapshots unfinished runs through the target end date, excludes the target
itself, and resumes them oldest first. Each is attempted once; failure does
not block other runs. Successful deliveries are skipped. Interrupted `running`
and pending agent steps are also eligible. It does not invent runs for dates
with no manifest. The daily worker finishes each returned `report` item using
its original range, then processes the current run. No parallel fetches, inline
market-data refresh, or login-control bypass is permitted.

New pipeline runs save `profileSnapshot` before fetching, including ad-hoc
fetch overrides and structured evaluation. Resuming uses that snapshot; changes
to CLI overrides do not change an existing run. Textual evaluation rules and
templates remain current. Older manifests without a snapshot use the current
profile on their first resumed attempt, retaining legacy `effective-profile.json`
fetch filters when available. Delayed fetches may miss listings that
have since disappeared; never claim that historical completeness is guaranteed.

`recovery.startedAt` marks recovery and adds `（補送）` to the delivery title,
preserving the original report date and body. A failed delivery retains its
report and retries only notify. Missing notifiers do not count as delivery.
Forcing or rerunning upstream work invalidates downstream steps and requires a
new report/delivery. Failure is cleared only after every step is successful.

Delivery uses the notifier's exit code. A crash after the provider accepts a
message but before the manifest is saved can cause a duplicate on retry;
exactly-once delivery requires provider-side idempotency, which the notifier
contract does not currently expose. Do not run two workers for the same profile
concurrently.
