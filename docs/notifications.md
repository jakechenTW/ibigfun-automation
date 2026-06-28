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
- `--status`: `ok` (clean run), `warn` (matches / needs review), `fail` (run could not complete).
- `--task`: the selected profile's `displayName`.
- `--title`: a short human title.
- `--details-file`: path to the Markdown report; the notifier reads the body from here.

A notifier should exit `0` on success and non-zero on failure.

## No notifier installed

If `NOTIFY_CMD` is unset and `ai-notify` is not on `PATH`, the run does **not**
fail. The report is still written to `state/runs/<profile>/<label>/report.md`
and a `notification skipped` notice is printed. Set `NOTIFY_CMD` to wire your
own notifier (Slack, email, a shell script, etc.).

If `NOTIFY_CMD` **is** set but the command is missing or exits non-zero, that is
treated as a real error.
