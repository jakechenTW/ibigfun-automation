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
