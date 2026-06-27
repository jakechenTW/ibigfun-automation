# Profile-Aware iBigFun Monitor Design

## Context

The repository currently operates as an investment-listing monitor. The
underlying fetch and enrichment pipeline is more general than that: it fetches
iBigFun sale listings, normalizes listing facts, computes walking-distance
signals, mortgage numbers, listing tenure, and advisory suspicious-listing
signals. The investment-specific behavior mainly lives in the report rules,
notification template, notification task name, worker prompt, and runbook text.

We want the repository to support multiple monitoring profiles, starting with:

- `investment`: the current investment/rental-yield workflow.
- `owner-occupied`: a self-use workflow based on a saved iBigFun search URL.

Each run must execute exactly one profile. Multi-profile runs are out of scope.

## Goals

- Make `profile` a first-class, explicit run dimension.
- Require `--profile <id>` for pipeline, fetch, enrich, status, and mark
  commands.
- Store artifacts under `state/runs/<profile>/<label>/...` so different
  profiles can run for the same date without overwriting each other.
- Preserve the current investment workflow as `--profile investment`.
- Add a first owner-occupied profile with readable criteria and documented
  iBigFun filter values.
- Keep the current agent-written report model. Do not build a full report
  generator in this implementation.
- Keep the existing fetch request behavior for now. Profile-driven fetch filters
  are documented but not enabled until coded filter mappings are verified.

## Non-Goals

- Do not run multiple profiles in one command.
- Do not automate market/rent estimation or owner-occupied quality scoring.
- Do not enable owner-occupied fetch filters until town and house-type id
  mappings are verified from iBigFun.
- Do not bypass the existing login, CAPTCHA, 2FA, or account-risk safety rules.

## Selected Approach

Use a profile-aware pipeline shell.

The pipeline remains:

```text
fetch -> enrich -> agent report -> notify
```

A profile resolver validates `--profile <id>` and loads a profile definition
before any network call or artifact write. The run identity becomes:

```text
(profileId, from, to)
```

Date-range resolution stays separate from profile resolution. The existing run
label rules remain unchanged:

- Single date: `<date>`
- Range: `<from>_<to>`

Paths change from:

```text
state/runs/<label>/...
```

to:

```text
state/runs/<profile>/<label>/...
```

## Profile Files

Add committed profile definitions:

```text
profiles/investment.json
profiles/owner-occupied.json
docs/profiles/investment.md
docs/profiles/owner-occupied.md
```

Profile JSON contains stable machine-readable metadata:

- `id`
- `displayName`
- `notifyTask`
- `ruleDocPath`
- `templatePath`
- `fetchFilters`
- `hardCriteria`
- `requiresFilterVerification`

Profile docs contain agent-facing judgment rules and reporting guidance.

For coded iBigFun filters, do not store opaque ids alone. Store the API value
and the human-readable label together:

```json
{
  "id": "owner-occupied",
  "displayName": "iBigFun 自住房源監測",
  "notifyTask": "每日 iBigFun 自住房源監測",
  "ruleDocPath": "docs/profiles/owner-occupied.md",
  "templatePath": "templates/owner-occupied-notify-template.md",
  "requiresFilterVerification": true,
  "fetchFilters": {
    "enabled": false,
    "sourceUrl": "https://www.ibigfun.com/lists/latest?page=1&expand=0&method=all_case&on_market=1&city=1&town=1%2C4%2C6%2C8%2C9&price_segment=%2C7000&house_type=17&floor_segment=7%2C&main_ping_number=30%2C&house_age_segment=%2C25&parking=%E5%B9%B3%E9%9D%A2",
    "city": { "id": "1", "nameZh": "台北市" },
    "towns": [
      { "id": "1", "nameZh": "待驗證" },
      { "id": "4", "nameZh": "待驗證" },
      { "id": "6", "nameZh": "待驗證" },
      { "id": "8", "nameZh": "待驗證" },
      { "id": "9", "nameZh": "待驗證" }
    ],
    "houseType": { "id": "17", "nameZh": "待驗證" },
    "priceMaxWan": 7000,
    "floorMin": 7,
    "mainPingMin": 30,
    "ageMax": 25,
    "parking": "平面"
  }
}
```

The implementation must verify `towns` and `houseType` from the authenticated
iBigFun UI or API before replacing `待驗證`. Until verified, the owner-occupied
profile may run but must be reported with `warn`.

## CLI Behavior

All run commands require `--profile`:

```bash
npm run pipeline -- run --profile owner-occupied --date 2026-06-26
npm run pipeline -- status --profile owner-occupied --date 2026-06-26
npm run pipeline -- mark report --profile owner-occupied --date 2026-06-26 \
  --status ok --artifact state/runs/owner-occupied/2026-06-26/report.md \
  --status-notify warn --title "<short>" --tool codex

npm run fetch -- --profile owner-occupied --date 2026-06-26
npm run enrich -- --profile owner-occupied --date 2026-06-26
```

Missing profile exits with code 2:

```text
BAD INPUT: --profile is required; available profiles: investment, owner-occupied
```

Unknown profile exits with code 2 and lists available ids.

The report agent-step instructions printed by `pipeline run` must include:

- The selected profile id and display name.
- The profile rule doc.
- The profile template path.
- The profile-scoped report path.
- A `pipeline mark report` command that includes the same `--profile`.

## Fetch Behavior

First implementation keeps the current fetch request shape. Existing hardcoded
iBigFun API parameters remain in effect unless a profile explicitly enables
profile-driven fetch filters.

The owner-occupied profile stores the saved URL filters as documentation and
future input, but `fetchFilters.enabled` remains `false` initially. This avoids
silently changing crawler behavior before town and house-type id mappings are
verified and request-shape tests are updated.

Profile-driven fetch filters can be enabled in a later focused change.

## Enrich Behavior

Enrichment remains profile-independent. It still computes reusable listing
facts:

- parsed price, ping, unit price, age
- mortgage
- district
- walking-distance decision and reliability
- hard walk exclusion data
- suspicious auction keyword signal
- listing tenure

The output path becomes profile-scoped:

```text
state/runs/<profile>/<label>/enriched.json
```

For owner-occupied reporting, walking distance is a preference and sorting
signal, not a hard exclusion, unless a future profile sets a hard walk
threshold. Unreliable walking data must remain visible in the report.

## Report Rules

### Common Rules

Keep shared rules in `docs/reporting-rules.md`:

- source model and canonical URL expectations
- report date semantics
- walking-distance reliability and triage
- suspicious-listing judgment
- notification safety and common formatting principles
- null-field rendering

### Investment Profile

`docs/profiles/investment.md` owns investment-specific rules:

- mortgage assumption
- below-market discount calculation
- rent-coverage calculation
- recommended and near-threshold thresholds
- market price and rent estimation guidance
- investment sorting and manual checks

The investment profile preserves the current behavior and notification task:

```text
每日 iBigFun 投資房源監測
```

### Owner-Occupied Profile

`docs/profiles/owner-occupied.md` owns self-use rules.

Initial criteria come from the provided iBigFun URL:

- City: Taipei City (`city=1`)
- Districts: `town=1,4,6,8,9`, names must be verified before replacing
  `待驗證`
- Total price: <= 7000 萬
- House type: `house_type=17`, name must be verified
- Floor: >= 7
- Main ping: >= 30
- Age: <= 25
- Parking: `平面`

Room, living-room, and bathroom counts are not hard criteria in the first
owner-occupied profile because they were not present in the source URL. The
report should display them when available and let the agent note layout risk.

Owner-occupied notification format:

- `符合條件`: matching listings worth attention.
- `候選/需確認`: close matches or listings with missing or uncertain fields.
- `排除摘要`: counts and main reasons only.
- Suspicious, likely-auction, and low-information findings are folded into
  candidate risk notes or exclusion summary rather than emitted as a long
  separate section.

Status rules:

- `warn`: any match, candidate, manual-review item, stale data, or unverified
  profile mapping.
- `ok`: no match/candidate and profile mappings are verified.
- `fail`: monitor cannot complete.

## Notify Behavior

Remove the single hardcoded notification task constant. Notification composition
uses the selected profile's `notifyTask`.

`composeNotifyArgs` should receive either the loaded profile or the task string,
plus existing notify params and details file.

Fail notifications also use the selected profile's task string.

## Run Manifest

Manifest files are written under profile-scoped run directories and include:

```json
{
  "profileId": "owner-occupied",
  "from": "2026-06-26",
  "to": "2026-06-26"
}
```

Existing step state, notify params, and failure fields remain.

## Error Handling

- Missing `--profile`: code 2, list available profiles.
- Unknown profile: code 2, list available profiles.
- Invalid profile JSON: code 2 before any network call or artifact write.
- Missing referenced rule doc or template: code 2 before any network call.
- Unverified owner-occupied coded filters: allowed, but report status must be
  `warn` and the summary must mention the unverified mapping.
- Login, CAPTCHA, 2FA, and account-risk handling remains unchanged.

## Documentation Updates

Update the project wording from investment-only to profile-aware where
appropriate:

- `AGENTS.md`
- `README.md`
- `docs/reporting-rules.md`
- `docs/fetching.md`
- `prompts/daily-run.md`
- templates

`prompts/daily-run.md` must require the trigger to provide a profile. Headless
workers must not invent a profile.

## Tests And Verification

Add or update tests for:

- profile loader:
  - valid profiles load
  - missing `--profile` fails
  - unknown profile fails
  - invalid profile JSON fails
  - missing referenced doc/template fails
  - available ids are listed
- run paths:
  - `state/runs/<profile>/<label>/...`
- manifest:
  - persisted `profileId`
- pipeline command behavior:
  - required `--profile`
  - profile-aware printed report instructions
- fetch/enrich CLI behavior:
  - required `--profile`
  - profile-scoped input/output paths
- notify:
  - profile-specific task string is used
  - fail details use profile-scoped paths

Implementation verification:

```bash
npm test
npx tsc --noEmit
```

If `npx tsc --noEmit` is already red for unrelated reasons, record that
explicitly and keep `npm test` green.

## Rollout Notes

This is a breaking CLI change because `--profile` becomes required. Existing
automation triggers must be updated at the same time as the code change. A
trigger that wants the old behavior must run with:

```bash
--profile investment
```

The owner-occupied profile can be used for report-rule development immediately,
but its stored iBigFun fetch filter ids must be verified before enabling
profile-driven fetch.
