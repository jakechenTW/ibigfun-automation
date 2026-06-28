# iBigFun Automation — Template

A template for monitoring iBigFun property listings via configurable profiles,
producing a Markdown report, and sending a concise notification. Clone it, drop
in your own profile, wire up credentials, and run the pipeline. Two example
profiles ship with the repo (`example-investment`, `example-owner-occupied`) so
you can explore the shape of the system before writing your own.

## What It Does NOT Do

- No GUI — the workflow is a CLI pipeline.
- Taiwan / iBigFun-specific — designed around iBigFun's API and Taipei MRT data;
  adapting to other sites requires re-implementing `scripts/fetch.ts`.
- Bring your own: iBigFun automation account, profile criteria, ORS API key, and
  (optionally) a notifier command.

## Prerequisites

- **Node toolchain** — `npm install` (no Chromium required; the fetch is
  browserless).
- **iBigFun automation account** — a dedicated iBigFun account for headless use.
  Credentials go in `.env` (see `docs/credentials.md`).
- **ORS API key** — free at [openrouteservice.org/dev](https://openrouteservice.org/dev/);
  used by the enrich step to compute walking distances to MRT exits.
- **Notifier (optional)** — set `NOTIFY_CMD` in `.env` to any CLI notifier
  (default: `ai-notify`). Without a notifier the report is still written to
  `state/runs/<profile>/<label>/report.md`; only the notification is skipped.
  See `docs/notifications.md`.

## Quickstart

```bash
npm install
cp .env.example .env   # fill IBIGFUN_ACCOUNT / IBIGFUN_PASSWORD / ORS_API_KEY for a real run
npm run pipeline -- run --profile example-investment --dry-run
```

`--dry-run` composes the notify command and prints it without sending it.
Remove `--dry-run` (and fill `.env`) for a real run.

## Repository Layout

- `AGENTS.md` — agent runbook and entrypoint; the source-of-truth map indexes
  every doc.
- `profiles/example-investment/` — example investment screening profile:
  台北市, price ≤ 3000 萬, floors 2–4, ≤ 5-storey building.
- `profiles/example-owner-occupied/` — example self-use screening profile:
  台北市 中正/中山, 電梯大樓, price ≤ 8000 萬, floor ≥ 7, main ping ≥ 30,
  age ≤ 25 years, 平面 parking.
- `profiles/README.md` — how to author a profile (folder layout, `profile.json`
  schema, the `fetch` encoding, the add-a-search recipe, `--set fetch.*`
  overrides).
- `docs/` — cross-profile reference: fetching, credentials, shared reporting
  rules, automation state, notifications.
- `docs/notifications.md` — `NOTIFY_CMD` contract and no-notifier fallback.
- `data/` — static reference data (MRT exits, filter mappings, 議價率, region
  allowlist); indexed by `data/README.md`.
- `prompts/` — committed prompts for headless / scheduled runs.
- `state/` — local generated output and per-run artifacts under
  `state/runs/<profile>/<label>/`; git-ignored.
- `LICENSE` — MIT.

## License & Use

MIT — see `LICENSE`. Intended for personal and educational use. Please:

- Respect iBigFun's Terms of Service and rate limits.
- Use a dedicated automation account, not your personal login.
- Review `docs/credentials.md` before storing any credentials.
