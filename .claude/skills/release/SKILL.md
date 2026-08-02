---
name: release
description: Use when cutting a release of this repo — bumping the version, closing the changelog, tagging, or checking that the published images and GitHub release came out right.
---

# Cutting a release

Releases are maintainer-only and triggered **solely by pushing a tag** matching
`v*.*.*`. Nothing else publishes anything. Confirm with the user which version
number to cut before doing any of this.

## Before tagging

1. `main` is up to date and the quality gates are green there
   (`npm run lint && npm test && npm run build`).
2. The board has no card still in *In progress* / *In review* for this release
   (`Release` iteration field, see the `next-task` skill).
3. `## [Unreleased]` in `CHANGELOG.md` actually describes what shipped.

## The three edits

```bash
VERSION=0.5.0
```

1. **`package.json`** — set `"version": "0.5.0"`. Not in CONTRIBUTING, but every
   tag so far matches the manifest (v0.1.0 … v0.4.0); keep that true.
2. **`CHANGELOG.md`** — rename the `## [Unreleased]` heading to
   `## [0.5.0] - $(date +%F)` and open a fresh, empty `## [Unreleased]` above it.
3. Commit them together: `chore(release): v0.5.0`.

## Tag and push

```bash
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main
git push origin "v$VERSION"
```

Push the branch first — the tag run checks out the tagged commit, and a tag
without its commit on `main` leaves the history confusing.

## What the tag run does

`.github/workflows/ci.yml` runs `lint`, `test`, `build` and `sast` against the
tagged commit, then:

- **`release-images`** — a Buildx matrix producing two images from the same
  Dockerfile via the `DATABASE_PROVIDER` build arg, pushed to GHCR:
  `ghcr.io/ironpinguin/simple_jigsaw:v0.5.0` + `:latest` (PostgreSQL) and
  `:v0.5.0-sqlite` + `:latest-sqlite` (SQLite).
- **`release-github`** — creates the GitHub release for the tag, with notes
  pointing at `CHANGELOG.md` and both image names.

Both authenticate with the automatic `GITHUB_TOKEN`; no extra secrets. The repo
must allow read/write workflow permissions (Settings → Actions → General).

## Verify — do not assume

```bash
gh run watch                        # or: gh run list --limit 3
gh release view "v$VERSION"
```

Check that **both** matrix legs pushed. A green `release-github` with a failed
SQLite image leg means `:latest-sqlite` is stale while the release page claims
otherwise.

## If it goes wrong

Never move a published tag. Fix forward with the next patch version — an image
tag that already exists in GHCR has been pulled by someone.

## Common mistakes

- Tagging without bumping `package.json` — the manifest then lies about the
  running version.
- Leaving `## [Unreleased]` in place, so the next change lands under the
  released heading.
- Tag pushed before the release commit is on `main`.
- Declaring the release done from the tag push alone, before the workflow
  finished.
