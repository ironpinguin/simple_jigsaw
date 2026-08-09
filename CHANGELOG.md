# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Liveness and readiness endpoints (`/api/health`, `/api/health/ready`), a
  healthcheck for the `app` service in `docker-compose.yml`, and a Kubernetes
  example under `deploy/kubernetes/` that wires both probes. (#44)
- Expired confirmation and invitation links are now deleted instead of being
  kept until the account goes (GDPR Art. 5(1)(e), storage limitation). An
  instance keeps itself tidy without any scheduling — see #44 below for how
  the cleanup is triggered; `npm run purge-expired` remains for a one-off
  sweep on an instance that has been running a while. Ban entries are
  deliberately left as they are — the policy already states their period and
  Art. 6(1)(f) as its basis. (#20)
- The privacy policy's recipients section now names all four transactional
  mails — confirmation, invitation, notice of a report, notice of a removed
  puzzle — instead of only the first two, and states that the two notice mails
  additionally carry the puzzle's title. With an external mail provider that
  paragraph is what discloses what the processor receives, so it was
  under-describing it. (#24)
- `docs/data-processors.md` for operators: which personal data can leave an
  instance (the four transactional mails and what each carries, uploaded images
  when S3 storage is on, hosting metadata), what is deliberately kept in — no
  analytics or external assets, Next.js telemetry off, reporter IPs hashed
  locally, solve progress only in the browser — and what to settle per external
  service under GDPR Art. 28, with a table to fill in for the instance. (#24)
- Users can delete their own account from the my-puzzles page (GDPR Art. 17).
  The step asks for the password before it runs, removes the account, its
  puzzles and every image behind them, and signs the browser out afterwards.
  The last remaining admin is refused, so an instance cannot be left without
  one. (#18)
- Anyone can report a puzzle (category + description, no account needed); admins
  are notified by email and review reports in a new admin queue, where they can
  delete a single puzzle including its image or dismiss the report. The owner
  is notified when their puzzle is removed; when that notification cannot be
  sent, the queue tells the admin to contact them another way. (#22)
- Puzzle visibility can be chosen at creation (public remains the default) and
  toggled at any time on the my-puzzles page; the toggle reports a failure
  instead of flipping the badge silently, and an expired session redirects to
  the login page. Admins can now view non-public puzzles, with the role
  checked against the database rather than the login token (#21).
- Terms of use under `/legal/terms` in all three languages, linked from the
  footer. They prohibit pornographic, illegal and rights-infringing uploads and
  reserve the right to remove content and accounts. Registration and invite
  activation now require accepting them — an unchecked checkbox linking the
  terms and the privacy policy, enforced server-side with a translated error —
  and the acceptance time and version are stored on the account. How a later
  change to the terms is handled is documented in `docs/terms-versioning.md`.
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
- Expired confirmation and invitation links are now deleted whenever the
  container runs — at startup and hourly after that, with a readiness check
  able to bring the next sweep forward inside the same hourly budget — instead
  of only when a token happens to be issued. An instance with registration
  disabled therefore keeps its promise from the privacy policy too, and issuing
  a token no longer means a table-wide delete. `/api/health/ready` reports
  `"retention": "stale"` if several sweeps in a row fail, so a sweep that has
  quietly stopped working is visible without reading the log. (#44)
- The privacy policy no longer says that an expired, never-redeemed link is
  kept until the account is deleted — it is now removed automatically, and the
  two paragraphs that described the old behaviour say so. (#20)
- The site layout is a column that keeps the footer at the bottom of short
  pages, which affects every page, not just the legal ones.

### Fixed
- API error messages and transactional mails now follow the visitor's browser
  language instead of falling back to German. They were German for exactly the
  visitors browsing in their own language — an English browser on `/en`, an
  Italian one on `/it` — because next-intl only stores the locale cookie the
  helper read when the chosen locale deviates from the browser's. An explicit
  choice still wins; `Accept-Language` is used when there is nothing stored
  (#35).
- Deleting an account no longer swallows a failed image deletion. Both the
  self-service and the admin path remove every image first and abort with a
  translated error if the storage refuses, instead of dropping the account row
  and leaving the image behind in storage — where it is no longer reachable
  through the app, but also no longer recorded anywhere, so nothing says it
  still needs erasing. Reports are cleaned up at both ends in the same step:
  open reports about the deleted puzzles leave the queue with a status of
  their own — *Account deleted*, not *Removed*, because nobody reviewed them
  and a user can delete their own account — and reports the account itself
  filed against other people's puzzles lose the reporter's address and IP hash
  while staying open for review. How many pending reports a deletion closed is
  logged. (#18)
- An admin invite that cannot be delivered now answers with a translated
  message saying the account was created but the invitation did not go out, and
  pointing at the recovery: delete the stranded account and invite again. The
  user list refreshes on failure too, so that account is actually on screen, and
  the affected user id is logged server-side instead of an opaque 500 with no
  trace (#28).
- Puzzle visibility is now enforced: a non-public puzzle's image and metadata
  answer 404 to anyone but the owner or an admin, and private images are never
  cached. Public images are cached for a day instead of a year, so making a
  puzzle private also stops its image being served from caches — browser and
  shared caches alike — within a day (#21).
- The delete button on the my-puzzles page recovers from a network failure
  with an error message instead of staying disabled, and an expired session
  redirects to the login page.
- The registration and invite-activation forms recover from a network failure
  with an error message instead of hanging on the loading state, and a
  registration whose verification mail could not be sent now says so instead
  of reporting a generic failure.
- The report dialog is usable with a keyboard: it takes focus when it opens,
  closes on Escape, hands focus back to the button that opened it, and
  announces itself by its heading to screen readers. (#22)
- The report button no longer appears on a private puzzle, where submitting
  could only ever answer "puzzle not found" — reporting is for public
  puzzles. (#22)
- The admin queue tells the admin to contact the owner whenever it cannot
  confirm the takedown notice went out, instead of only when the server said
  so explicitly — an unreadable response no longer passes as a delivered
  notification. (#22)

### Security
- Three high-severity advisories in transitive dependencies are cleared by
  patch bumps of `brace-expansion`, `js-yaml` and `nanoid`. Only `nanoid` is in
  runtime scope and so actually ships in the image; the other two stay in the
  lint and build toolchain. None was reachable from untrusted input — the
  `nanoid` loop needs a size of zero, which the app never asks for — so this is
  hygiene rather than an exposure that was open. (#39)
- Switching a puzzle to private now rotates its image key, so previously shared
  image URLs stop resolving for anyone who has not already cached them —
  rotation cannot evict a copy a browser already holds under the old year-long
  cache header. (#21, #22)
- Report rate limiting derives its per-reporter bucket from `x-forwarded-for`
  only when `TRUSTED_PROXY_HOPS` declares the deployment's own reverse proxy —
  the header is client-forgeable, so without one all reports share a single
  hourly bucket instead of trusting it. That shared bucket is used for the rate
  limit only: the "one open report per puzzle per reporter" check is skipped
  entirely when no proxy is declared, because deduplicating on a bucket every
  visitor shares would let one report — including an uploader's self-report —
  silently swallow every later report of the same puzzle. A malformed
  `TRUSTED_PROXY_HOPS` is now rejected at startup of the request instead of
  quietly degrading a proxied deployment to the shared bucket. Reporter-IP
  hashing also refuses to run without `AUTH_SECRET` rather than silently
  producing unkeyed, reversible hashes. (#22)

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
