# Notifications

The pipeline sends each finished report by invoking a **notifier command**.
The command is resolved from the `NOTIFY_CMD` environment variable, defaulting
to `ai-notify`.

## Notifier contract

The notifier is invoked with this argv (positional flags, values may contain
spaces and are shell-quoted only for display):

```
<NOTIFY_CMD> --tool <codex|claude> --status <ok|warn|fail> \
  --task "<profile displayName>" --title "<short title>" \
  --details-file <path to report.md>
```

- `--tool`: which agent produced the report (`codex` or `claude`).
- `--status`: `ok` means the run completed without unresolved actionable warnings; fully supported recommendations or matches may use `ok`. `warn` means candidates, risks, unresolved actionable manual review, stale sources, unverified mappings, or other weak evidence affects safe interpretation. A fresh market review/unavailable result on a confirmed hard exclusion does not force `warn`. `fail` means the run could not complete.
- `--task`: the selected profile's `displayName`.
- `--title`: the sole user-facing notification title; include the concise status/date/outcome wording here and do not repeat it in the details body.
- `--details-file`: path to the Markdown report; the notifier reads the body from here.

A notifier should exit `0` on success and non-zero on failure.

## No notifier installed

If `NOTIFY_CMD` is unset and `ai-notify` is not on `PATH`, the run does **not**
fail. The report is still written to `state/runs/<profile>/<label>/report.md`
and a `notification skipped` notice is printed. Set `NOTIFY_CMD` to wire your
own notifier (Slack, email, a shell script, etc.).

If `NOTIFY_CMD` **is** set but the command is missing or exits non-zero, that is
treated as a real error.

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
