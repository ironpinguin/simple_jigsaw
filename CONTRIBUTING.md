# Contributing

Thanks for your interest in improving Jigsaw! This document describes how to set
up the project, the quality bar, and how releases are made.

## Development setup

Everything runs in Docker. The default stack is PostgreSQL + RustFS + Mailpit:

```bash
docker compose up --build          # http://localhost:3000
```

Minimal, Postgres-free stack (SQLite + local filesystem storage):

```bash
docker compose -f docker-compose.sqlite.yml up -d --build
```

Dev mail is captured by Mailpit at http://localhost:8025.

To make yourself an admin, set `ADMIN_EMAILS` in `.env` (auto-promotes on
register/login) or run:

```bash
docker compose exec app npm run make-admin -- you@example.com
```

See the [README](README.md) for the full configuration reference.

## Quality bar

Every change must pass the same gates CI runs:

```bash
npm install
npm run lint      # ESLint (next lint)
npm test          # Vitest
npm run build     # Next.js typecheck + compile
```

Static analysis (Semgrep) also runs in CI. Please add or update tests for the
behaviour you change — the pure logic in `lib/` (puzzle geometry, bans, tokens,
grouping) is unit-tested and easy to extend.

## Making changes

- Work on a feature branch and open a pull request against `main`.
- The CI workflow (lint · sast · test · build) must be green before merging.
- Keep commits focused with a clear, descriptive message (imperative mood).
  Conventional Commit prefixes (`feat:`, `fix:`, `ci:`, `docs:` …) are welcome
  but not required.
- Add a bullet under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for any
  user-facing change.

## Releases

Releases are cut by maintainers by pushing an annotated Git tag following
[Semantic Versioning](https://semver.org), e.g.:

```bash
git tag -a v1.2.0 -m "v1.2.0"
git push origin v1.2.0
```

The tag run of `.github/workflows/ci.yml` then:

1. Runs the quality gates against the tagged commit.
2. Builds two Docker images with Buildx and pushes them to the GitHub Container
   Registry (`ghcr.io/ironpinguin/simple_jigsaw`):
   - `<image>:<tag>` and `:latest` — PostgreSQL build
   - `<image>:<tag>-sqlite` and `:latest-sqlite` — SQLite build
3. Creates a GitHub Release for the tag.

Before tagging, move the `## [Unreleased]` entries in `CHANGELOG.md` under a new
`## [<version>] - <date>` heading.

> Both release steps authenticate with the automatic `GITHUB_TOKEN`; no extra
> secrets are needed. The workflow grants it `packages: write` for the image
> push and `contents: write` for the release, so **Settings → Actions → General
> → Workflow permissions** must allow read/write (or at least not block the
> per-job grants).

## License

By contributing, you agree that your contributions are licensed under the
project's [Apache License 2.0](LICENSE).
