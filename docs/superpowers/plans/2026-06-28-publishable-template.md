# Publishable Open-Source Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `ibigfun-automation` into a usable open-source template — ships example profiles, decouples the personal `ai-notify` dependency, and adds a license and template-grade docs — without breaking the author's daily local runs.

**Architecture:** Profiles are auto-discovered from `profiles/*/profile.json` on disk, so the author's real profiles can be gitignored while example profiles are committed. The notifier becomes an env-configured command (`NOTIFY_CMD`, default `ai-notify`) with a graceful no-op fallback when no notifier is available. Licensing, metadata, and docs are reframed for an external cloner.

**Tech Stack:** Node.js (ESM, `type: module`), TypeScript via `tsx`, `node:test` for tests, `node:child_process` `spawnSync` for the notifier.

## Global Constraints

- Node ESM with `.ts` import specifiers (e.g. `import { x } from './notify.ts'`).
- Tests use `node:test` + `node:assert/strict`; run via `npm test`.
- Never break the existing pure exports `composeNotifyArgs`, `composeNotifyCommand`, `renderFailDetails` — existing tests in `scripts/lib/notify.test.ts` must keep passing.
- `runNotify` and `composeNotifyCommand` are called from `scripts/pipeline.ts` with positional args `(params, task, detailsFile)` — any new parameters must be optional and trailing.
- Commit messages end with the trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Do NOT commit or alter `profiles/investment-taipei/` or `profiles/owner-occupied-taipei/` content — they only get untracked (Task 4).

---

### Task 1: `NOTIFY_CMD` env + graceful fallback in notify.ts

**Files:**
- Modify: `scripts/lib/notify.ts`
- Test: `scripts/lib/notify.test.ts`

**Interfaces:**
- Consumes: `composeNotifyArgs(p, task, detailsFile)` (existing), `NotifyParams` from `./manifest.ts`.
- Produces:
  - `resolveNotifyCommand(env?: NodeJS.ProcessEnv): { command: string; explicit: boolean }`
  - `runNotify(p, task, detailsFile, opts?: { env?: NodeJS.ProcessEnv; spawn?: SpawnFn }): { exitCode: number; stderr: string; skipped?: boolean; command: string }`
  - `type SpawnFn = (cmd: string, args: string[]) => { status: number | null; stderr?: string; error?: (Error & { code?: string }) }`
  - `composeNotifyCommand(p, task, detailsFile, env?: NodeJS.ProcessEnv): string` (now resolves the command name from env)

- [ ] **Step 1: Write the failing tests**

Append to `scripts/lib/notify.test.ts`:

```ts
import { resolveNotifyCommand, runNotify } from './notify.ts';

test('resolveNotifyCommand defaults to ai-notify when NOTIFY_CMD unset', () => {
  assert.deepEqual(resolveNotifyCommand({}), { command: 'ai-notify', explicit: false });
});

test('resolveNotifyCommand uses NOTIFY_CMD when set', () => {
  assert.deepEqual(resolveNotifyCommand({ NOTIFY_CMD: 'my-notify' }), { command: 'my-notify', explicit: true });
});

test('resolveNotifyCommand treats blank/whitespace NOTIFY_CMD as unset', () => {
  assert.deepEqual(resolveNotifyCommand({ NOTIFY_CMD: '   ' }), { command: 'ai-notify', explicit: false });
});

test('runNotify returns the spawn exit code on success', () => {
  const spawn = () => ({ status: 0, stderr: '' });
  const r = runNotify(params, investmentTask, 'r.md', { env: { NOTIFY_CMD: 'my-notify' }, spawn });
  assert.equal(r.exitCode, 0);
  assert.equal(r.skipped, undefined);
  assert.equal(r.command, 'my-notify');
});

test('runNotify soft-skips with exit 0 when the default notifier is missing', () => {
  const spawn = () => ({ status: null, error: Object.assign(new Error('not found'), { code: 'ENOENT' }) });
  const r = runNotify(params, investmentTask, 'r.md', { env: {}, spawn });
  assert.equal(r.exitCode, 0);
  assert.equal(r.skipped, true);
});

test('runNotify surfaces a real error when an explicitly configured notifier is missing', () => {
  const spawn = () => ({ status: null, error: Object.assign(new Error('not found'), { code: 'ENOENT' }) });
  const r = runNotify(params, investmentTask, 'r.md', { env: { NOTIFY_CMD: 'broken-notify' }, spawn });
  assert.equal(r.exitCode, 1);
  assert.equal(r.skipped, undefined);
});

test('runNotify surfaces non-zero exit from a configured notifier', () => {
  const spawn = () => ({ status: 3, stderr: 'boom' });
  const r = runNotify(params, investmentTask, 'r.md', { env: { NOTIFY_CMD: 'my-notify' }, spawn });
  assert.equal(r.exitCode, 3);
  assert.equal(r.stderr, 'boom');
});

test('composeNotifyCommand prefixes the resolved command name', () => {
  const cmd = composeNotifyCommand(params, investmentTask, 'r.md', { NOTIFY_CMD: 'my-notify' });
  assert.ok(cmd.startsWith('my-notify --tool claude'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `resolveNotifyCommand` / new `runNotify` signature not defined.

- [ ] **Step 3: Rewrite `scripts/lib/notify.ts`**

Replace the file with:

```ts
import { spawnSync } from 'node:child_process';
import type { NotifyParams } from './manifest.ts';
import type { JournalEvent } from './journal.ts';
import type { RunRange } from './range.ts';

/** Canonical notifier argv (see docs/notifications.md "Notifier contract"). */
export function composeNotifyArgs(p: NotifyParams, task: string, detailsFile: string): string[] {
  return [
    '--tool', p.tool,
    '--status', p.status,
    '--task', task,
    '--title', p.title,
    '--details-file', detailsFile,
  ];
}

/** Resolve the notifier command: NOTIFY_CMD if set (non-blank), else the `ai-notify` default. */
export function resolveNotifyCommand(env: NodeJS.ProcessEnv = process.env): { command: string; explicit: boolean } {
  const raw = env.NOTIFY_CMD?.trim();
  return { command: raw || 'ai-notify', explicit: !!raw };
}

function shellQuote(arg: string): string {
  return /[^A-Za-z0-9_./-]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}

/** Human-readable command string for --dry-run / journaling. Display only. */
export function composeNotifyCommand(
  p: NotifyParams,
  task: string,
  detailsFile: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const { command } = resolveNotifyCommand(env);
  return command + ' ' + composeNotifyArgs(p, task, detailsFile).map(shellQuote).join(' ');
}

export type SpawnFn = (
  cmd: string,
  args: string[],
) => { status: number | null; stderr?: string; error?: Error & { code?: string } };

export interface NotifyResult {
  exitCode: number;
  stderr: string;
  command: string;
  skipped?: boolean;
}

/**
 * Execute the notifier. Resolves the command from NOTIFY_CMD (default `ai-notify`).
 * If no notifier is configured AND the default is not installed, the run does not
 * fail: the report is already written to `detailsFile`, so we print a skip notice
 * and return exitCode 0 (skipped: true). An explicitly configured notifier that is
 * missing or exits non-zero is a real error.
 */
export function runNotify(
  p: NotifyParams,
  task: string,
  detailsFile: string,
  opts: { env?: NodeJS.ProcessEnv; spawn?: SpawnFn } = {},
): NotifyResult {
  const env = opts.env ?? process.env;
  const spawn: SpawnFn =
    opts.spawn ?? ((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }));
  const { command, explicit } = resolveNotifyCommand(env);
  const r = spawn(command, composeNotifyArgs(p, task, detailsFile));
  if (r.error) {
    const notFound = r.error.code === 'ENOENT';
    if (notFound && !explicit) {
      console.error(
        `notification skipped — no notifier found (set NOTIFY_CMD to enable); report at ${detailsFile}`,
      );
      return { exitCode: 0, stderr: '', command, skipped: true };
    }
    return { exitCode: 1, stderr: r.error.message, command };
  }
  return { exitCode: r.status ?? 1, stderr: r.stderr ?? '', command };
}

/**
 * Markdown body for a fail notification. Built ONLY from the operator reason
 * and the (already redact()-ed) journal tail — never raw secrets.
 */
export function renderFailDetails(profileId: string, range: RunRange, reason: string, tail: JournalEvent[]): string {
  const lines = [
    `# 監測中斷 ${range.label}`,
    ``,
    `- Profile: ${profileId}`,
    `- 區間: ${range.from} → ${range.to}`,
    `- 原因: ${reason}`,
    ``,
    `## journal (最後 ${tail.length} 筆)`,
    ...tail.map((e) => `- ${e.ts} [${e.level}] ${e.step}:${e.event} ${e.msg}`),
  ];
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS — all notify tests (existing + new) green.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/notify.ts scripts/lib/notify.test.ts
git commit -m "feat(notify): NOTIFY_CMD env + graceful fallback when no notifier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `.env.example` + notifier contract doc

**Files:**
- Modify: `.env.example`
- Create: `docs/notifications.md`
- Modify: `AGENTS.md` (link the new doc in the source-of-truth map / notification section)

**Interfaces:**
- Consumes: the argv contract from `composeNotifyArgs` (Task 1).
- Produces: documentation only — no code symbols.

- [ ] **Step 1: Add `NOTIFY_CMD` to `.env.example`**

Append to `.env.example`:

```
# Notifier command invoked with the argv contract in docs/notifications.md.
# Defaults to `ai-notify`. If unset and no notifier is installed, the run still
# completes and writes the report; the notification is skipped with a notice.
NOTIFY_CMD=
```

- [ ] **Step 2: Create `docs/notifications.md`**

```markdown
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
```

- [ ] **Step 3: Link the doc from `AGENTS.md`**

In `AGENTS.md`, under "## Canonical Notification Command", change the hard-coded
`ai-notify` reference to mention the configurable command and link the doc.
Replace the intro line and code fence's command name so it reads:

- Intro sentence gains: "The notifier command is `NOTIFY_CMD` (default `ai-notify`); see `docs/notifications.md`."
- Keep the flag documentation as-is.

Also add `docs/notifications.md` to the source-of-truth map / doc index in `AGENTS.md` if such a list exists (grep `docs/credentials.md` to find the index block and add a sibling bullet).

- [ ] **Step 4: Verify no broken references**

Run: `grep -rn "docs/notifications.md" AGENTS.md && test -f docs/notifications.md && echo OK`
Expected: prints the grep hit and `OK`.

- [ ] **Step 5: Commit**

```bash
git add .env.example docs/notifications.md AGENTS.md
git commit -m "docs(notify): document NOTIFY_CMD contract + no-notifier fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Example profiles

**Files:**
- Create: `profiles/example-investment/profile.json`
- Create: `profiles/example-investment/evaluation.md`
- Create: `profiles/example-investment/notify-template.md`
- Create: `profiles/example-owner-occupied/profile.json`
- Create: `profiles/example-owner-occupied/evaluation.md`
- Create: `profiles/example-owner-occupied/notify-template.md`

**Interfaces:**
- Consumes: `loadProfile` requires all three files per folder; `profile.json` needs non-empty `displayName` (string) and an object `fetch`.
- Produces: two discoverable example profile ids: `example-investment`, `example-owner-occupied`.

- [ ] **Step 1: Copy the existing profiles as a starting point**

```bash
cp -r profiles/investment-taipei profiles/example-investment
cp -r profiles/owner-occupied-taipei profiles/example-owner-occupied
```

- [ ] **Step 2: Genericize `profiles/example-investment/profile.json`**

Overwrite with:

```json
{
  "displayName": "iBigFun 台北投資房源監測（範例）",
  "fetch": {
    "city": "1",
    "price_segment": { "max": 3000 },
    "floor_segment": { "min": 2, "max": 4 },
    "total_floor": { "max": 5 }
  }
}
```

- [ ] **Step 3: Genericize `profiles/example-owner-occupied/profile.json`**

Overwrite with:

```json
{
  "displayName": "iBigFun 台北自住房源監測（範例）",
  "fetch": {
    "city": "1",
    "town": ["1", "4"],
    "house_type": ["17"],
    "price_segment": { "max": 8000 },
    "floor_segment": { "min": 7 },
    "main_ping_number": { "min": 30 },
    "house_age_segment": { "max": 25 },
    "parking": "平面"
  }
}
```

- [ ] **Step 4: Mark the example templates as examples**

In `profiles/example-investment/notify-template.md`, change the first heading line `## iBigFun 每日投資房源監測 - {{date}}` to `## iBigFun 每日投資房源監測（範例） - {{date}}`. In `profiles/example-owner-occupied/notify-template.md`, similarly append `（範例）` to its top heading. Leave the rest of each `evaluation.md` / `notify-template.md` intact — the methodology and structure are the showcase. Update any in-body path references that point to `profiles/investment-taipei/` → `profiles/example-investment/` and `profiles/owner-occupied-taipei/` → `profiles/example-owner-occupied/` (grep each file for the old folder name).

- [ ] **Step 5: Verify both example profiles load and are discovered**

Run:
```bash
npx tsx -e "import('./scripts/lib/profiles.ts').then(m => { console.log(m.listProfiles()); m.loadProfile('example-investment'); m.loadProfile('example-owner-occupied'); console.log('loaded OK'); })"
```
Expected: the printed list includes `example-investment` and `example-owner-occupied`; prints `loaded OK` with no throw.
(If `listProfiles`/`loadProfile` are not the exact exported names, grep `scripts/lib/profiles.ts` for the discovery + load function names and adjust the one-liner.)

- [ ] **Step 6: Commit**

```bash
git add profiles/example-investment profiles/example-owner-occupied
git commit -m "feat(profiles): add example-investment + example-owner-occupied profiles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Untrack the author's real profiles + gitignore convention

**Files:**
- Modify: `.gitignore`
- Untrack (keep on disk): `profiles/investment-taipei/`, `profiles/owner-occupied-taipei/`
- Modify: `profiles/README.md` (document the private-profile convention)

**Interfaces:**
- Consumes: nothing.
- Produces: a documented convention — private profiles stay on disk, gitignored; only `example-*` profiles are committed.

- [ ] **Step 1: Add the gitignore convention**

Append to `.gitignore` (after the existing blocks):

```
# Private profiles — the template ships only example-* profiles.
# Your own tuned profiles stay on disk but are not committed.
profiles/investment-taipei/
profiles/owner-occupied-taipei/
profiles/*.local/
```

- [ ] **Step 2: Untrack the real profile folders (keep files on disk)**

```bash
git rm -r --cached profiles/investment-taipei profiles/owner-occupied-taipei
```

- [ ] **Step 3: Verify they are untracked but still present on disk**

Run:
```bash
git status --porcelain profiles/ && echo "---" && ls profiles/investment-taipei profiles/owner-occupied-taipei
```
Expected: `git status` shows the two folders' files as deletions staged (`D`); `ls` still lists the files on disk; `git check-ignore profiles/investment-taipei/profile.json` returns the path.

- [ ] **Step 4: Document the convention in `profiles/README.md`**

In `profiles/README.md`, under "## Folder layout", replace the example tree's `investment-taipei` / `owner-occupied-taipei` folder names with `example-investment` / `example-owner-occupied`, and add this note after the tree:

```markdown
> **Committed vs. private.** This template commits only `example-*` profiles.
> Your own tuned profiles are private: keep them on disk under `profiles/` and
> they are auto-discovered, but git-ignore them (the default `.gitignore`
> ignores `profiles/*.local/` plus the author's own folders). To start your own,
> copy an example folder and rename it, e.g. `cp -r profiles/example-investment
> profiles/my-investment.local`.
```

Also update the "Recipe: add a new search" `cp -r profiles/investment-taipei profiles/investment-taichung` line to `cp -r profiles/example-investment profiles/investment-taichung`.

- [ ] **Step 5: Commit**

```bash
git add .gitignore profiles/README.md
git commit -m "chore(profiles): untrack private profiles, ship examples only

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: LICENSE + package.json metadata

**Files:**
- Create: `LICENSE`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: an MIT `LICENSE`; `package.json` with `license`, `repository`, `author`, refreshed `description`.

- [ ] **Step 1: Create `LICENSE` (MIT)**

```
MIT License

Copyright (c) 2026 Jake Chen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Update `package.json` metadata**

Set `"description"` to `"Template: monitor iBigFun property listings via configurable profiles and send profile-specific report notifications."`, keep `"private": true`, and add these keys (after `"description"`):

```json
  "license": "MIT",
  "author": "Jake Chen",
  "repository": { "type": "git", "url": "https://github.com/jakechentw/ibigfun-automation" },
```

(If the GitHub URL is unknown at implementation time, use `https://github.com/jakechentw/ibigfun-automation` as a placeholder owner/repo — the verifier will confirm or the author corrects it.)

- [ ] **Step 3: Verify package.json is valid JSON**

Run: `node -e "console.log(require('./package.json').license)"`
Expected: prints `MIT`.

- [ ] **Step 4: Commit**

```bash
git add LICENSE package.json
git commit -m "chore: add MIT LICENSE and publishable package metadata

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: README reframe + cross-doc example-id consistency

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `prompts/daily-run.md`, `prompts/schedule-triggers.md` (only if they hard-code the real profile ids)

**Interfaces:**
- Consumes: example profile ids from Task 3, `NOTIFY_CMD` fallback from Task 1, LICENSE from Task 5.
- Produces: documentation only.

- [ ] **Step 1: Reframe `README.md`**

Rewrite `README.md` to:
- One-paragraph "what this is": a template for monitoring iBigFun listings via configurable profiles, producing a Markdown report and a notification.
- A "What it does NOT do" note: no GUI; Taiwan / iBigFun specific; you supply your own iBigFun account, profile criteria, and (optionally) a notifier.
- "Prerequisites": Node toolchain (`npm install`), an `ORS_API_KEY` (free, openrouteservice.org/dev), an iBigFun automation account in `.env`, and optionally `NOTIFY_CMD` (no notifier → report still written, notification skipped — link `docs/notifications.md`).
- "Quickstart" ending in a credential-free dry run against an example profile:
  ```bash
  npm install
  cp .env.example .env   # fill IBIGFUN_ACCOUNT / IBIGFUN_PASSWORD / ORS_API_KEY for a real run
  npm run pipeline -- run --profile example-investment --dry-run
  ```
  Note that `--dry-run` composes the notify command without sending. (Verify the exact dry-run flag against `scripts/pipeline.ts` — grep `dry-run` — and correct the command if needed.)
- "Repository layout": keep the existing bullet list but change profile examples to `example-investment` / `example-owner-occupied` and add `LICENSE` + `docs/notifications.md`.
- A short "License & use" section: MIT (see `LICENSE`); for personal/educational use; respect iBigFun's Terms of Service and rate limits; use a dedicated automation account.

- [ ] **Step 2: Update `AGENTS.md` example profile ids**

In `AGENTS.md`, change the run-sequence mentions of `investment-taipei` / `owner-occupied-taipei` (the "Identify the target profile explicitly (...)" line and any example commands) to `example-investment` / `example-owner-occupied`. Leave behavior/rules text unchanged.

- [ ] **Step 3: Sweep prompts for hard-coded ids**

Run: `grep -rn "investment-taipei\|owner-occupied-taipei" prompts/ README.md AGENTS.md`
For each hit that is an illustrative command or profile reference (not historical prose), replace with the matching `example-*` id. Re-run the grep; remaining hits should only be inside `docs/superpowers/` (kept as history) — confirm none remain in `prompts/`, `README.md`, or `AGENTS.md`.

- [ ] **Step 4: Verify**

Run: `grep -rln "investment-taipei\|owner-occupied-taipei" . --include="*.md" | grep -v "docs/superpowers/" | grep -v "profiles/investment-taipei\|profiles/owner-occupied-taipei"`
Expected: no output (no committed user-facing doc references the real ids outside the kept history and the gitignored folders themselves).

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md prompts/
git commit -m "docs: reframe README as a template + use example profile ids

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: End-to-end verification (fresh-clone simulation)

**Files:**
- None modified — verification only.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: evidence the template is publishable and the author's local run still works.

- [ ] **Step 1: Full test suite**

Run: `npm test 2>&1 | tail -15`
Expected: all tests pass (no failures), including the new notify fallback tests.

- [ ] **Step 2: Committed tree contains only example profiles + README**

Run: `git ls-files profiles/`
Expected: only paths under `profiles/example-investment/`, `profiles/example-owner-occupied/`, and `profiles/README.md`. No `profiles/investment-taipei/...` or `profiles/owner-occupied-taipei/...`.

- [ ] **Step 3: LICENSE is tracked**

Run: `git ls-files LICENSE`
Expected: prints `LICENSE`.

- [ ] **Step 4: No-notifier dry run against an example profile**

Run:
```bash
env -u NOTIFY_CMD PATH="/usr/bin:/bin" npm run pipeline -- run --profile example-investment --dry-run 2>&1 | tail -20
```
Expected: the pipeline resolves the `example-investment` profile and reaches the notify step composing a command (dry-run prints the would-send command) without an "unknown profile" error and without throwing on a missing notifier. (If a live fetch step requires credentials and aborts before notify, that is acceptable for this check — the goal is to confirm the example profile resolves and no notifier dependency hard-crashes; note the actual stop point in the verification summary.)

- [ ] **Step 5: Author's private profile still resolves locally**

Run:
```bash
npx tsx -e "import('./scripts/lib/profiles.ts').then(m => { const ids = m.listProfiles(); console.log(ids); if (!ids.includes('investment-taipei')) throw new Error('real profile not discovered'); console.log('private profile OK'); })"
```
Expected: the on-disk (gitignored) `investment-taipei` is still discovered → prints `private profile OK`.

- [ ] **Step 6: Record verification results**

Summarize the outputs of Steps 1–5 (pass/fail with the relevant output line) before proceeding to merge. Do not claim success without the captured output.

---

## Self-Review

**Spec coverage:**
- Spec §1 Profiles → Task 3 (examples) + Task 4 (untrack/gitignore) + Task 6 (id consistency). ✓
- Spec §2 Notify → Task 1 (env+fallback) + Task 2 (docs). ✓
- Spec §3 Licensing → Task 5 (LICENSE + package.json) + Task 6 (README disclaimer). ✓
- Spec §4 Docs/hygiene → Task 6 (README, AGENTS, prompts); `docs/superpowers/` kept as-is (no task needed). ✓
- Spec §5 Git history (Option A, accept) → no task required by design. ✓
- Verification section → Task 7. ✓

**Placeholder scan:** No TBD/TODO. Each code/test step shows complete content. The one conditional ("if `listProfiles`/`loadProfile` names differ") is a verification fallback, not a placeholder. GitHub URL flagged as confirm-or-correct in Task 5.

**Type consistency:** `runNotify` signature `(p, task, detailsFile, opts?)` and return `NotifyResult` used consistently; `resolveNotifyCommand(env)` shape `{command, explicit}` matches tests and `runNotify`/`composeNotifyCommand` callers; `SpawnFn` return shape matches the injected stubs in Task 1 tests. Pipeline callers use only `{exitCode, stderr}` — still present. ✓
