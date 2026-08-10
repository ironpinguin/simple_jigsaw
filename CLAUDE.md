# Jigsaw — notes for Claude Code

Next.js (App Router) + TypeScript, React/Konva for the board, Prisma for data,
next-intl for DE/EN/IT. Everything runs in Docker; see [README.md](README.md)
for the stack and [CONTRIBUTING.md](CONTRIBUTING.md) for setup and releases.

## Planning

Work is tracked on a public GitHub Project board, not in the repo —
**[docs/github-project.md](docs/github-project.md)** explains the fields, the
status lifecycle and the `gh project` commands. Read the `Ready` column before
starting anything; ask before changing cards you are not working on.

## Skills

`.claude/skills/` holds the repo's own workflows — Claude Code loads them by
description, or invoke one explicitly with `/<name>`:

| Skill | For |
| --- | --- |
| `next-task` | picking up an issue from the board |
| `ship` | quality gates → changelog → PR → board |
| `dev-stack` | running the app, test accounts, mail |
| `i18n-string` | any user-facing text (DE/EN/IT) |
| `db-change` | `prisma/schema.prisma`, both providers |
| `puzzle-geometry` | `lib/puzzle/` invariants |
| `release` | version bump, tag, published images |

## Quality gates

The same three commands CI runs — all must pass before a PR:

```bash
npm run lint
npm test
npm run build
```

Semgrep also runs in CI. Add or update tests for behaviour you change; the pure
logic in `lib/` (grid, edges, outlines, groups, bans, tokens) is unit-tested
with Vitest and easy to extend.

## Conventions that are easy to get wrong

- **CHANGELOG** — every user-facing change gets a bullet under
  `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- **Three locales** — any new UI string needs an entry in `messages/de.json`,
  `messages/en.json` *and* `messages/it.json`. DE is the default; the locale
  lives in the URL prefix (`/de`, `/en`, `/it`), routing in `i18n/routing.ts`.
  API error messages and transactional mails are translated too.
- **Two database providers** — `prisma/schema.prisma` is the single source, and
  `scripts/prisma.mjs` rewrites only the `datasource` line for SQLite. SQLite
  has no Prisma enums, so role/type columns are strings validated in code (see
  `lib/roles.ts`). Schema changes must work on both; use `npm run db:push`.
- **Puzzle core** — `lib/puzzle/` is pure and seed-deterministic (`prng.ts`).
  Keep it free of React and I/O so it stays testable; edges are shared between
  neighbours, so a tab always matches its blank.
- **Branch + PR** — feature branch against `main`, `Closes #<n>` in the PR body.
  Conventional Commit prefixes are welcome, not required.
