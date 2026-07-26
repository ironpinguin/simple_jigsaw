# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://git.catalano.de/ironpinguin/puzzle/-/compare/v0.2.0...main
[0.2.0]: https://git.catalano.de/ironpinguin/puzzle/-/tags/v0.2.0
[0.1.0]: https://git.catalano.de/ironpinguin/puzzle/-/tags/v0.1.0
