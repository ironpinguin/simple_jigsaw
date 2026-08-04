# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Legal pages: an Impressum and a privacy policy under `/legal/imprint` and
  `/legal/privacy`, in all three languages, reachable from a new site footer on
  every page. The privacy policy describes what the app actually stores —
  account, verification links, blocked addresses, puzzles, uploaded images and
  the solve progress kept in the browser — and states that images of public
  puzzles are served without sign-in.
- The operator's name, address and contact details for those pages come from
  the environment (`LEGAL_NAME`, `LEGAL_ADDRESS`, `LEGAL_EMAIL`, `LEGAL_PHONE`),
  so no personal data lives in the repository. All three of name, address and
  email are required — until they are set the Impressum names the missing
  variables instead of rendering a page that looks complete, and the privacy
  policy says no controller is configured rather than pointing at one.
- Statements that are only true for some operators are configurable and off by
  default, so no instance publishes a claim it cannot keep:
  `LEGAL_MAIL_PROCESSOR` / `LEGAL_STORAGE_PROCESSOR` name an external mail or
  storage provider as a processor, `LEGAL_HOSTING_REGION` states where the
  instance runs (unset: the policy says the location is not stated, rather than
  claiming the EU), and `LEGAL_PRIVATE_SERVICE` adds the private,
  non-commercial note for operators for whom it holds.

### Changed
- The site layout is a column that keeps the footer at the bottom of short
  pages, which affects every page, not just the legal ones.

## [0.5.0] - 2026-08-03

### Added
- Solve view: a puzzle in progress now survives a reload, a closed tab and a
  reboot. Where the pieces lie and which of them are joined is kept in the
  browser (per puzzle, no account or server involved) and restored on the next
  visit, correctly rescaled if the window is a different size. A new
  *Start over* button in the toolbar re-scatters the puzzle after a
  confirmation, and changing the piece count discards the saved state as the
  existing warning already promised.
- Solve view: a board overview in the bottom-right corner showing every piece
  and group on the board plus the part of it currently on screen. Click or drag
  inside it — or focus it and use the arrow keys — to jump straight to a region
  instead of panning blindly. Assembled blocks are highlighted, and the overview
  can be switched off like the preview.

### Security
- Cleared all 11 open Dependabot alerts (1 critical, 6 high, 4 moderate).
  Upgraded `sharp` 0.33 → 0.35 (libvips CVE-2026-33327/33328/35590/35591),
  `nodemailer` 8 → 9 (`raw` option bypassing `disableFileAccess`/
  `disableUrlAccess`) and `vitest` 2 → 3 (arbitrary file read/execute via the
  UI server), which also lifts `vite` to 7 and `esbuild` to 0.28. Added
  `overrides` for `postcss`, `brace-expansion` and `nodemailer`, whose parents
  still pin vulnerable ranges.

### Fixed
- Solve view: opening a puzzle whose piece count you had changed before no
  longer throws a hydration error and re-renders the whole board. The
  remembered piece count is now applied after mount instead of during the first
  render. The piece-count selector also has an `id` and `name` again.
- Solve view: the progress counter no longer shows a made-up number of
  connections right after the piece count changes — an untouched board could
  claim "192 / 299 connected" until it had finished rebuilding. Progress now
  counts only what the board has reported for the grid on screen.
- Solve view: pieces no longer appear to go missing. Loose single pieces are now
  always drawn above assembled blocks, so they stay clickable — previously the
  block you dragged last stayed on top for good and swallowed every click over
  its whole bounding box. A piece or block dropped past the edge of the play
  area also slides back onto it, instead of being left where only blind panning
  would find it again. Dragging itself stays unrestricted, so pieces can still
  be joined right at the edges.

### Changed
- Solve view: the mouse wheel now zooms in small, steerable steps (about 5% per
  notch instead of 12%, and scaled by how far the wheel or trackpad was
  actually moved) rather than jumping several steps per gesture. The current
  zoom level is shown as a percentage above the zoom buttons, and the +/−
  buttons are disabled once the 35%–300% limits are reached, so the board no
  longer just stops responding without saying why.
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

[Unreleased]: https://github.com/ironpinguin/simple_jigsaw/compare/v0.5.0...main
[0.5.0]: https://github.com/ironpinguin/simple_jigsaw/releases/tag/v0.5.0
[0.4.0]: https://github.com/ironpinguin/simple_jigsaw/releases/tag/v0.4.0
[0.3.0]: https://github.com/ironpinguin/simple_jigsaw/releases/tag/v0.3.0
[0.2.0]: https://github.com/ironpinguin/simple_jigsaw/releases/tag/v0.2.0
[0.1.0]: https://github.com/ironpinguin/simple_jigsaw/releases/tag/v0.1.0
