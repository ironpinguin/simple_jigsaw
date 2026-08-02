# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Solve view: pieces no longer appear to go missing. Loose single pieces are now
  always drawn above assembled blocks, so they stay clickable — previously the
  block you dragged last stayed on top for good and swallowed every click over
  its whole bounding box. Dragging is also constrained to the play area, so a
  piece or block can no longer be pushed off the edge where only blind panning
  would find it again.

### Changed
- Moved the project to GitHub (`ironpinguin/simple_jigsaw`). The GitLab CI
  pipeline is replaced by a GitHub Actions workflow
  (`.github/workflows/ci.yml`) with the same gates (ESLint · Vitest · Next.js
  build · Semgrep SAST). Tag releases now build the Docker images with Buildx,
  push them to the **GitHub Container Registry**
  (`ghcr.io/ironpinguin/simple_jigsaw`) instead of the GitLab registry, and
  create a **GitHub Release**.

## [0.4.0] - 2026-07-26

### Added
- **Multi-language UI (i18n)**: German (default), English and Italian, selected
  via URL-prefix routing (`/de`, `/en`, `/it`) with a language switcher in the
  header. Powered by [next-intl](https://next-intl.dev/); all pages, forms,
  admin screens and the solve view are translated. Transactional emails
  (verification, invite) and API error messages are localized too — the email
  language follows the user's chosen locale (via the `NEXT_LOCALE` cookie) and
  its links are locale-prefixed.

## [0.3.0] - 2026-07-26

### Added
- Solve view: **zoom & pan** (mouse wheel, on-screen +/−/reset buttons, and
  pinch-to-zoom on touch; drag empty space to pan) and a **per-solver piece-count
  selector** (12/48/108/300, defaulting to the creator's value and remembered per
  puzzle) — making puzzles comfortable to solve on tablets. Removes the previous
  horizontal scrollbar (pan replaces scrolling).

## [0.2.0] - 2026-07-26

### Changed
- More natural puzzle pieces: classic interlocking knobs (pinched neck with an
  undercut), a lightly jittered grid for organic size/shape variation, and a
  beveled, drop-shadowed 3D edge so pieces look like raised cardboard.

## [0.1.0] - 2026-07-26

### Added

- Jigsaw puzzle web app: create classic interlocking puzzles from your own
  images and solve them in the browser (React + Konva), with adjustable piece
  counts (12 / 48 / 108 / 300), varied organic piece shapes, free-form
  connect-and-group solving, and a toggleable reference image.
- Accounts with email verification (nodemailer; Mailpit in dev), roles
  (`USER` / `ADMIN`), and an admin area: user management (invite by email or
  direct create, role toggle, delete) and email/domain bans. CLI helpers
  `make-admin` and `create-user`, plus a switch to disable public registration.
- Image storage abstraction: local filesystem or S3-compatible object storage
  (RustFS), served through an in-app proxy.
- Switchable database provider — PostgreSQL (default) or SQLite — with a minimal
  Postgres-free docker-compose stack.
- Dockerized development (hot-reload) and deployment via docker-compose.
- GitLab CI quality gates: ESLint, Vitest, Next.js build, and Semgrep SAST.
- Tag-based release pipeline that builds versioned Docker images (PostgreSQL and
  SQLite variants) and pushes them to the GitLab Container Registry, and creates
  a GitLab Release.
- Favicon (puzzle-piece mark).

[Unreleased]: https://github.com/ironpinguin/simple_jigsaw/compare/v0.4.0...main
[0.4.0]: https://github.com/ironpinguin/simple_jigsaw/releases/tag/v0.4.0
[0.3.0]: https://github.com/ironpinguin/simple_jigsaw/releases/tag/v0.3.0
[0.2.0]: https://github.com/ironpinguin/simple_jigsaw/releases/tag/v0.2.0
[0.1.0]: https://github.com/ironpinguin/simple_jigsaw/releases/tag/v0.1.0
