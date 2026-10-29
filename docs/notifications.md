# Notifications

The pipeline sends each finished report by invoking a **notifier command**.
The command is resolved from the `NOTIFY_CMD` environment variable, defaulting
to `ai-notify`.

## Notifier contract

Approve the canonical report with `pipeline mark report`, then deliver it with `pipeline run`.
The pipeline uses `NOTIFY_CMD` (default `ai-notify`) with this command shape.
The details file is its program-managed approved copy, not the editable report.
Do not bypass the pipeline with a direct notifier call for report delivery.

```bash
ai-notify --tool <codex|claude> --status <ok|warn|fail> \
  --task "<profile displayName>" --title "<short title>" \
  --details-file state/runs/<profile>/<label>/approved-report-<sha256>.md
```

- `--tool`: the agent actually running (`codex` or `claude`).
- `--task`: use the selected profile's `displayName` from
  `profiles/<profile>/profile.json`.
- `--status warn`: candidates, risk listings, unresolved actionable manual review,
  stale or weak data affecting safe interpretation, login fallback, or unverified mappings.
- `--status ok`: a completed run with no unresolved actionable warning; fully supported recommendations/matches may use `ok`.
- `--status fail`: only when the monitor cannot complete.

The notifier receives separate argv values, including values that contain spaces.
Shell quoting is only for display.
`--title` is the sole notification title. Keep it out of the report body.
`--details-file` points to the approved Markdown copy that the notifier reads.
A fresh market review/unavailable result on a confirmed hard exclusion does not force `warn`.

A notifier should exit `0` on success and non-zero on failure.

## No notifier installed

If `NOTIFY_CMD` is unset and `ai-notify` is not on `PATH`, the report remains
at `state/runs/<profile>/<label>/report.md`
and a `notification skipped` notice is printed. The pipeline records delivery
as failed, keeping it in the recovery queue until a notifier is available.
Set `NOTIFY_CMD` to wire your own notifier (Slack, email, a shell script, etc.).

If `NOTIFY_CMD` **is** set but the command is missing or exits non-zero, that is
treated as a real error.

The daily worker runs `pipeline recover` before the current run to resume
unfinished historical runs and send their completed reports. Recovery titles
retain the original date/range and append `（補送）`. A successful failure alert
is tracked separately and never suppresses the later report notification.
Notifications are retried on later worker invocations, without an infinite
retry loop. An acknowledged successful report is not sent again during recovery.

## Report approval

Use `pipeline mark report` to approve the canonical `report.md` after fetch and enrich complete.
Use `pipeline run` to deliver the approved report.
Direct notifier calls bypass approval and are outside this workflow.
`report:check` remains a format and count preview, not an approval.

The report delivery module records `reportApproval` in the run manifest.
Its version-1 record binds the report, enriched evidence, optional valuation review, profile snapshot, date range, status, and original title.
SHA-256 fingerprints bind file bytes, including whitespace.
A missing valuation review is recorded explicitly, so adding or removing it requires renewed approval.
The current delivery agent and the standard recovery title suffix can change without renewed approval.

Approval publishes `approved-report-<sha256>.md` in the run directory before committing the manifest.
The copy contains the exact approved report bytes.
The pipeline retains copies after delivery and failure.
Authors edit only `report.md` and never edit delivery copies.

Before sending, the pipeline compares current inputs and notification conditions with the approval and makes sure that the copy matches.
Changed or missing inputs, damaged copies, and missing or unsupported approval records return the run to the report step.
The journal records the reason, and recovery returns `outcome: report`.
If a copy is damaged, restore its original bytes or remove that damaged copy before approving the canonical report again.
A notifier failure retains approval and retries delivery on the next invocation.

Delivery preserves the original assessment date, without refreshing market data or routing because time passed.
Historical reports do not describe current availability.
A custom notifier must read the provided file and acknowledge delivery through its exit code.
The existing duplicate-delivery limitation still applies.

## Message body

Profile `report.md` is already the concise user-facing notification body. It
starts directly with the conclusion, without a repeated Markdown title. Every
rendered walking line backed by a coordinate includes a clickable
`[地圖](https://www.google.com/maps?q=<lat>,<lng>)` link; only
`🚶 無位置資訊` omits it. Full enrichment, valuation-review, manifest, and
journal evidence stays local.

The title follows `<status icon> <target date or range> <profile purpose>｜<primary outcome>`.
Choose an outcome such as `推薦 2 筆`, `候選 1 筆待確認`, `風險 1 筆待查`, or `本期無房源`.
If a warning affects positive results, include it in the outcome, such as `推薦 2 筆・候選 1 筆待確認`.
Use `無符合物件` only when all fetched listings fail confirmed hard criteria.
If data prevents a decision, use an outcome such as `資料待確認`.

The body starts with the result and the most useful next action.
The next line keeps every bucket count, including zeros.
Empty sections are hidden, so a no-result report contains only the conclusion, counts, applicable warnings, and applicable exclusion summary.
Each property starts with its reason or next action, followed by its facts and required evidence.
For a candidate, name the fact that needs resolution and how to obtain it.
For a risk, state the evidence and whether the detail page was inspected.
Keep the profile rules for bucket assignment, sorting, and notification status.

Failure notifications contain only the profile/range, human-readable stopped
step, redacted operator reason, and safe next action. They never include the
journal tail, timestamps, internal event names, raw stack traces, credentials,
or source payloads.

## Counts and wording

Use `本次取得` for the number of listings in the current `enriched.json`.
The fetch step removes duplicates within the query, but does not establish first discovery across runs.
Use `首次發現` only with saved cross-run evidence.
Use `新上架` only with supported publication evidence.

Use this exact summary structure, with `符合` for owner-occupied profiles:

```text
本次取得 8｜推薦 2｜候選 1｜風險 0｜排除 5
```

Count each listing in exactly one bucket.
Assign each excluded listing one primary reason under the shared reporting rules.
The reason counts must sum to the excluded count.
The bucket counts must sum to the fetched count.
The pipeline compares the fetched count with the current enriched listing count before marking the report complete.

`推薦` means that a listing passes the profile screening rules and warrants further review.
It does not establish a good purchase price, rental return, or inspected property condition.
Describe the supported property features and the specific unresolved fact.
Keep generic inspection advice out of each property entry.

Read the selected profile's own template, including private `.local` profiles.
Example template edits do not automatically update private copies.

## Preview validation

Read the selected profile template again for each report.
The agent writes the report from that template. The pipeline does not render it automatically.
Do not copy the previous report as the current template.

Before marking a report complete, run this read-only command:

```bash
npm run report:check -- <report.md> <enriched.json>
```

The command sends no notification and changes no run state.
It rejects empty result sections, known technical diagnostics, and missing or misplaced property reasons.
It also rejects known generic-only advice and inconsistent counts.
Revise the report after a format error, then run the command again.
Keep the existing buckets, required warnings, and property coverage during revisions.
The agent must still make sure that each reason is specific and supported by evidence.
The format test cannot establish factual accuracy or catch every vague sentence.

Walking lines name the station, exit, and walking time instead of the routing services.
Use the display rules in `docs/reporting-rules.md` and `formatDualRouteWalkLine` from `scripts/lib/route-trial.ts`.
Keep full provider comparisons in local evidence.
