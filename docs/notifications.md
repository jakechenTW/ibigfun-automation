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

Failure notifications contain only the profile/range, human-readable stopped
step, redacted operator reason, and safe next action. They never include the
journal tail, timestamps, internal event names, raw stack traces, credentials,
or source payloads.
