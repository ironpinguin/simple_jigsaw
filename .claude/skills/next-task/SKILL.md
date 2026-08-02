---
name: next-task
description: Use when picking up work in this repo — choosing what to work on next, starting on an existing issue, or moving a card to In progress on the GitHub Project board.
---

# Starting a task from the board

Planning lives on a private GitHub Project (user `ironpinguin`, project `4`),
not in the repo. Full reference: [docs/github-project.md](../../../docs/github-project.md).

## Prerequisite

`gh auth status` must list the `project` scope. If not: `gh auth refresh -s project`.

## 1. See what is ready

```bash
gh project item-list 4 --owner ironpinguin --format json \
  --jq '.items[] | select(.status == "Ready")
        | "\(.priority // "--")  \(.size // "--")  #\(.content.number)  \(.title)"'
```

Pick the highest priority (`P0` > `P1` > `P2`), smallest size first. Propose the
pick to the user before starting — don't silently choose.

Read the full issue before touching code; the bodies carry symptom / cause / fix:

```bash
gh issue view <n>
```

## 2. Take it

`gh project item-edit` needs the **project item ID** (`PVTI_…`), not the issue
number:

```bash
ITEM=$(gh project item-list 4 --owner ironpinguin --format json \
        --jq ".items[] | select(.content.number == <n>) | .id")

gh project item-edit --project-id PVT_kwHOAAIYWs4BfJPF --id "$ITEM" \
  --field-id PVTSSF_lAHOAAIYWs4BfJPFzhZeOck --single-select-option-id 47fc9ee4

gh issue edit <n> --add-assignee @me
git switch -c fix/<short-slug>      # or feat/<short-slug>
```

## Quick reference

| Thing | Value |
| --- | --- |
| Project ID | `PVT_kwHOAAIYWs4BfJPF` |
| Status field ID | `PVTSSF_lAHOAAIYWs4BfJPFzhZeOck` |
| Status → In progress | `47fc9ee4` |
| Status → In review | `4cc61d42` |

Other field and option IDs: see the board doc, or re-resolve with
`gh project field-list 4 --owner ironpinguin --format json`.

## Common mistakes

- **Passing the issue number to `--id`** — it wants `PVTI_…`; resolve it first.
- **Editing two fields in one call** — `item-edit` changes exactly one field per
  invocation.
- **Moving somebody else's card.** Only touch the item you are actually working
  on. Re-prioritising or re-sizing is the maintainer's call.
- **Working without a card.** If the task maps to no issue, say so and offer to
  create one — never invent an issue number to close.

Finishing the task: use the `ship` skill.
