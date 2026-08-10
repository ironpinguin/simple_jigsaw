# The GitHub Project board

Planning for this repository happens on a **user-scoped GitHub Project**, not in
the repo itself:

> https://github.com/users/ironpinguin/projects/4

The board is **public to read** — anyone can see what is planned and what is
being worked on. **Changing** it (status, priority, size, release) needs
collaborator access from @ironpinguin. Issues themselves live in
`ironpinguin/simple_jigsaw` as usual; the project only adds planning metadata
on top of them, so everything actionable is in the issue itself.

This document describes the board so that both humans and Claude Code sessions
work it the same way.

## Prerequisites

The `gh` CLI needs the `project` scope on top of the usual ones — without it
every `gh project` call fails with a permission error:

```bash
gh auth status                 # look for 'project' in "Token scopes"
gh auth refresh -s project     # add it if missing
```

All commands below address the board by its **number and owner**, never by URL:

```bash
gh project view 4 --owner ironpinguin
```

`gh` ships its own jq engine, so `--jq` works even when no `jq` binary is
installed. Prefer `--format json --jq '…'` over parsing the plain table output —
the table omits the custom fields.

## Fields

| Field | Type | Values |
| --- | --- | --- |
| **Status** | single select | `Backlog`, `Ready`, `In progress`, `In review`, `Done` |
| **Priority** | single select | `P0` (drop everything), `P1` (this release), `P2` (nice to have) |
| **Size** | single select | `XS`, `S`, `M`, `L`, `XL` |
| **Release** | iteration | e.g. `Release 0.5.0` — the version an item is scheduled for |
| **Estimate** | number | optional, only used when a size is not precise enough |
| **Start date** / **Target date** | date | optional |

Plus the built-in read-only fields GitHub maintains itself (Assignees, Labels,
Linked pull requests, Milestone, Repository, Reviewers, Parent issue, Sub-issues
progress, Created/Updated/Closed).

`Size` is about implementation effort, `Estimate` is deliberately mostly empty —
don't fill both.

## Status lifecycle

```
Backlog  →  Ready  →  In progress  →  In review  →  Done
```

- **Backlog** — captured, not scheduled. Fine to have an unclear description.
- **Ready** — understood well enough to start: symptom/cause/fix or a concrete
  acceptance criterion is written down, `Priority` and `Size` are set.
- **In progress** — someone (see *Assignees*) is working on it on a branch.
- **In review** — a pull request exists and is linked to the issue.
- **Done** — merged. Closing the issue moves the card here automatically via the
  project's built-in workflow; check it afterwards and correct the field if it
  did not fire.

## Reading the board

Everything that is ready to be picked up, most important first:

```bash
gh project item-list 4 --owner ironpinguin --format json \
  --jq '.items[] | select(.status == "Ready")
        | "\(.priority // "--")  \(.size // "--")  #\(.content.number)  \(.title)"'
```

The whole board as a flat overview:

```bash
gh project item-list 4 --owner ironpinguin --format json \
  --jq '.items[] | "\(.status)\t\(.priority // "-")\t#\(.content.number)\t\(.title)"'
```

What is scheduled for the current release:

```bash
gh project item-list 4 --owner ironpinguin --format json \
  --jq '.items[] | select(.release.title == "Release 0.5.0") | "\(.status)\t#\(.content.number)\t\(.title)"'
```

Full detail of a single item (issue body included) is easier to read straight
from the issue:

```bash
gh issue view 7 --repo ironpinguin/simple_jigsaw
```

## Changing the board

### Add an issue

```bash
gh issue create --title "…" --body "…" --label bug     # or use the issue forms in the UI
gh project item-add 4 --owner ironpinguin --url https://github.com/ironpinguin/simple_jigsaw/issues/8
```

New items land without a status; set `Backlog` or `Ready` explicitly.

### Set a single-select field (Status, Priority, Size)

`gh project item-edit` works on **IDs**, not names, and changes exactly one
field per call:

```bash
gh project item-edit \
  --project-id PVT_kwHOAAIYWs4BfJPF \
  --id       <item-id> \
  --field-id <field-id> \
  --single-select-option-id <option-id>
```

Note the two different IDs: `--id` is the **project item** ID (`PVTI_…`), not the
issue number. Resolve it from the issue number:

```bash
gh project item-list 4 --owner ironpinguin --format json \
  --jq '.items[] | select(.content.number == 7) | .id'
```

Setting the iteration uses `--iteration-id` instead, dates use `--date`, numbers
`--number`, and `--clear` empties a field.

### ID cheat sheet

Stable as long as the board is not rebuilt — re-resolve (see below) if a call
fails with an unknown-ID error.

| What | ID |
| --- | --- |
| Project | `PVT_kwHOAAIYWs4BfJPF` |
| Field: Status | `PVTSSF_lAHOAAIYWs4BfJPFzhZeOck` |
| Field: Priority | `PVTSSF_lAHOAAIYWs4BfJPFzhZeOm0` |
| Field: Size | `PVTSSF_lAHOAAIYWs4BfJPFzhZeOm4` |
| Field: Release | `PVTIF_lAHOAAIYWs4BfJPFzhZeOnA` |
| Status → Backlog | `f75ad846` |
| Status → Ready | `08afe404` |
| Status → In progress | `47fc9ee4` |
| Status → In review | `4cc61d42` |
| Status → Done | `98236657` |
| Priority → P0 / P1 / P2 | `79628723` / `0a877460` / `da944a9c` |
| Size → XS / S / M / L / XL | `eff732af` / `9592a5a3` / `9728cbdc` / `c53df028` / `7b141a16` |

Re-resolve field and option IDs with:

```bash
gh project field-list 4 --owner ironpinguin --format json
gh project view 4 --owner ironpinguin --format json --jq .id
```

### Worked example: take issue #7 into progress

```bash
ITEM=$(gh project item-list 4 --owner ironpinguin --format json \
        --jq '.items[] | select(.content.number == 7) | .id')

gh project item-edit --project-id PVT_kwHOAAIYWs4BfJPF --id "$ITEM" \
  --field-id PVTSSF_lAHOAAIYWs4BfJPFzhZeOck --single-select-option-id 47fc9ee4

gh issue edit 7 --add-assignee @me
git switch -c fix/hydration-piece-count
```

## Working an item end to end

1. Pick the top `Ready` item (highest priority, then smallest size), or ask the
   maintainer which one to take.
2. Move it to **In progress** and assign yourself.
3. Branch off `main`; keep the issue number in the branch name.
4. Implement, with the quality gates from [CONTRIBUTING.md](../CONTRIBUTING.md)
   green: `npm run lint`, `npm test`, `npm run build`.
5. Add a bullet under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md) for
   anything user-facing.
6. Open the PR with `Closes #<n>` in the body — that links it to the issue and
   populates the *Linked pull requests* field. Move the item to **In review**.
7. After merge, confirm the card sits in **Done** and that the `Release` field
   matches the version the change will ship in.

## Notes for Claude Code sessions

- **Reading the board is always fine** — start planning work by listing the
  `Ready` column instead of guessing what matters.
- **Ask before writing to the board** unless the change simply reflects work the
  session is actually doing (moving your own item to In progress / In review).
  Never re-prioritise or re-size somebody else's cards on your own.
- **Never invent issues to close.** If work does not map to an existing card,
  say so and offer to create one.
- The board is the source of truth for *what* to build; `CONTRIBUTING.md` is the
  source of truth for *how* to ship it.
- `Bash(gh project *)` and `Bash(gh issue *)` are already allow-listed in
  `.claude/settings.local.json`, so these calls run without prompts.
