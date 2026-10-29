# Issue tracker

Issues and specs live in GitHub Issues for `jakechenTW/ibigfun-automation`.
Use the `gh` CLI from this repository.

Before creating an issue, make sure that `gh repo view --json nameWithOwner` identifies this repository.
If it identifies another repository, ask the user before writing.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,labels`.
- Comment: `gh issue comment <number> --body-file <file>`.
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: post the explanation as a comment, then run `gh issue close <number>`.

Write multiline bodies to a file and pass that file through `--body-file`.
Read `docs/agents/triage-labels.md` before applying triage labels.

When a skill says "publish to the issue tracker", create a GitHub issue.
When a skill says "fetch the relevant ticket", read the specified GitHub issue.

## Relationships

Use native GitHub sub-issues and issue dependencies when available.
Otherwise, add `Part of #<parent>` or `Blocked by: #<number>` to the child body.
An issue is unblocked when every blocking issue is closed.

## Pull requests

PRs as a request surface: no.

## Wayfinding

Use one issue labeled `wayfinder:map` as the map.
Store notes, decisions, and unresolved questions in its body.
Link child tickets through sub-issues or a task list in the map.
Label children `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.

Choose the first open child in map order with no open blockers or assignee.
Claim it with `gh issue edit <number> --add-assignee @me`.
To resolve it, post the result, close the child, and add a result link to the map.
