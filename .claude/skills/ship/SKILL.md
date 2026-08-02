---
name: ship
description: Use when a change in this repo is finished and about to become a pull request, or when asked whether a change is ready to merge.
---

# Shipping a change

A change is ready when four things are true, in this order. Each step produces
evidence — report the actual command output, never a summary from memory.

## 1. The gates CI runs are green

```bash
npm run lint
npm test
npm run build
```

All three, on the final state of the code. `npm run build` is the typecheck —
lint and tests passing does not mean the branch compiles. Semgrep also runs in
CI; a finding there comes back as a failed check, so expect it if the change
touches auth, uploads or raw SQL.

If a gate fails, fix it. Do not open the PR with "unrelated failure" — verify
that claim on `main` first.

## 2. The changelog has an entry

Every user-facing change needs a bullet under `## [Unreleased]` in
`CHANGELOG.md`, in the right Keep-a-Changelog section (`Added`, `Fixed`,
`Changed`, `Security`). Check what is there:

```bash
awk '/^## \[Unreleased\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md
```

Internal-only refactors and test-only changes may skip this — say so explicitly
rather than staying silent.

## 3. The PR links the issue

```bash
git push -u origin HEAD
gh pr create --fill --body "Closes #<n>

<what changed and why, in a few sentences>"
```

`Closes #<n>` is what populates *Linked pull requests* on the board and closes
the issue on merge. Without an issue, say which board card this belongs to.

## 4. The board card moves to In review

```bash
ITEM=$(gh project item-list 4 --owner ironpinguin --format json \
        --jq ".items[] | select(.content.number == <n>) | .id")

gh project item-edit --project-id PVT_kwHOAAIYWs4BfJPF --id "$ITEM" \
  --field-id PVTSSF_lAHOAAIYWs4BfJPFzhZeOck --single-select-option-id 4cc61d42
```

After merge the built-in workflow moves the card to *Done* when the issue
closes — check that it fired, and that the `Release` field names the version the
change ships in.

## Red flags

| Thought | Reality |
| --- | --- |
| "Tests passed earlier, the last edit was tiny" | Re-run. The tiny edit is exactly what breaks the build. |
| "Lint and tests are green, build is just a formality" | `npm run build` is the typecheck. It catches what the others cannot. |
| "The failure looks unrelated" | Reproduce it on `main` before saying so. |
| "It's a small fix, no changelog needed" | Small user-facing fixes are the ones users notice missing from release notes. |
| "I'll set the board status later" | An untouched card means someone else picks up the same issue. |
