# Report and takedown — design

Issue: #22 (sub-issue of #2). Branch: `feat/report-takedown`.

Anyone can report a public puzzle without an account; admins review reports in
a queue and either delete the puzzle (including its image) or dismiss the
report. Also rides along: the `imageKey` rotation on public→private flips that
PR #29 left as a known residual.

## Decisions made during brainstorming

- **Abuse protection:** DB-backed rate limit + dedup, keyed on an HMAC-hashed
  IP. No captcha, no in-memory counters, no separate rate-limit table — the
  `Report` table itself is queried.
- **Owner notification:** yes, the owner gets a translated email when their
  puzzle is taken down.
- **Categories:** four — `NSFW`, `ILLEGAL`, `COPYRIGHT`, `OTHER` — plus free
  text.
- **Retention:** reports are anonymized immediately when resolved (reporter
  contact and IP hash nulled); the record itself (category, text, title
  snapshot, decision, timestamps) stays as takedown evidence. Purge deadlines
  are #20's job.
- **Scope:** `imageKey` rotation on public→private is included here.

## Data model

New Prisma model (string columns, not enums — SQLite; validated in a new
`lib/reports.ts`, same pattern as `lib/roles.ts`):

```prisma
model Report {
  id             String    @id @default(cuid())
  // Deliberately NOT a foreign key: the report must survive the takedown
  // deleting the puzzle. Whether the puzzle still exists is checked at
  // read time in the admin queue.
  puzzleId       String
  puzzleTitle    String    // snapshot for the queue and post-takedown evidence
  // "NSFW" | "ILLEGAL" | "COPYRIGHT" | "OTHER" (lib/reports.ts)
  category       String
  message        String    // free text, 10–2000 chars
  // Both null after anonymization on resolution.
  reporterEmail  String?
  reporterIpHash String?
  // "OPEN" | "TAKEDOWN" | "DISMISSED" (lib/reports.ts)
  status         String    @default("OPEN")
  createdAt      DateTime  @default(now())
  resolvedAt     DateTime?

  @@index([status])
  @@index([reporterIpHash])
}
```

Schema change follows the `db-change` skill: single schema file, must work on
Postgres and SQLite, `npm run db:push`.

## Routes

### `POST /api/report` (no auth)

1. Zod validation: `puzzleId` (string), `category` (one of the four),
   `message` (10–2000 chars), `email` (optional, valid address when present).
2. The puzzle must exist **and be public**. Unknown and private both answer
   **404** — same no-existence-oracle line as PR #29; a stranger cannot see a
   private puzzle, so they cannot report it either.
3. Client IP from the first `x-forwarded-for` entry, hashed as
   `HMAC-SHA256(AUTH_SECRET, ip)`. The plain IP is never stored or logged.
4. **Rate limit:** more than 5 reports from the same IP hash in the last hour
   → 429 (translated error).
5. **Dedup:** an existing `OPEN` report with the same IP hash for the same
   puzzle → respond 200 as if created, but create nothing. The reporter
   cannot tell they were deduplicated, so the endpoint is not an oracle.
6. Create the report; send the admin notification email to every user with
   role `ADMIN`. Mail failure is logged but never fails the request — the
   queue is the source of truth, the mail is only a ping.

### `DELETE /api/admin/puzzles/[id]`

`requireAdmin`, otherwise 403 (admin area — no oracle concern). Order matters:

1. Load the puzzle; 404 if gone.
2. Delete the storage object, **but only if no other puzzle still references
   the `imageKey`** (reference-counted delete, same as the owner-facing
   `DELETE /api/puzzles/[id]` from PR #29).
3. **Non-silent:** if the storage delete fails, answer **502** with a
   translated error and do **not** delete the DB row. No state where the
   image lives on orphaned while the row is gone. The admin sees the failure
   and retries. This is the pattern #18 will adopt.
4. Delete the DB row. Mark every `OPEN` report for this `puzzleId` as
   `TAKEDOWN`, set `resolvedAt`, null `reporterEmail`/`reporterIpHash` —
   one takedown resolves all reports of the same puzzle.
5. Send the owner notice email (title + category). Mail failure is logged;
   the takedown stands.

### `PATCH /api/admin/reports/[id]`

`requireAdmin`. Body `{ action: "dismiss" }`: status → `DISMISSED`,
`resolvedAt` set, reporter fields nulled. Takedown is not an action here — it
goes through the DELETE route above, which resolves the reports itself. One
action, one endpoint.

### `PATCH /api/puzzles/[id]` — imageKey rotation (existing route, extended)

On an owner's public→private flip:

1. Generate a new key (same file extension).
2. `copyObject(oldKey, newKey)` — if the **copy** fails, the whole flip fails
   (502, puzzle stays public). Never a DB row whose key has no object.
3. Update the row (`imageKey = newKey`, `isPublic = false`).
4. Delete the old object, reference-counted (another of the owner's puzzles
   may still use the old key). If only this **cleanup** fails, the flip
   stands and the failure is logged loudly: image delivery resolves keys via
   the puzzle table, so an unreferenced key already answers 404 — the
   orphaned object is unreachable through the API.

private→public does not rotate.

## Storage

New `copyObject(srcKey, destKey)` in `lib/storage.ts`, both drivers:
fs → `fs.copyFile` (with `mkdir -p` on the destination dir),
s3 → server-side `CopyObjectCommand`. Same public-API shape as put/get/delete.

## UI

- **Report entry point:** a discreet "Report" link in the existing title /
  controls bar of `PuzzleSolver` on the solve page. Works without login.
- **`ReportDialog`** (client component): four category radios, free-text
  area, optional email field ("in case we may ask follow-up questions"),
  submit → confirmation text inside the dialog. Client-side length
  validation mirrors the server.
- **Admin queue:** `app/[locale]/admin/reports/page.tsx` (server page,
  open reports first, then resolved descending by `resolvedAt`) renders
  `components/admin/ReportsAdmin.tsx` — category badge, puzzle title (linked
  to the solve page while the puzzle still exists), free text, reporter
  contact if given, age. Open reports offer **Takedown** (confirm dialog —
  destructive) and **Dismiss**. Resolved reports render grayed out with
  decision + timestamp as the audit view.
- **Navigation:** a "Reports" tab in the admin layout next to Users/Bans,
  with a count badge of open reports.

## Mail

Two new senders in `lib/mail.ts`, same shape as verify/invite, subjects and
bodies in the `email` namespace (DE/EN/IT):

- `sendReportNotification(to, puzzleTitle, category, locale)` — to every
  admin on report intake, linking to the queue.
- `sendTakedownNotice(to, puzzleTitle, category, locale)` — to the owner
  after a takedown.

We store no per-user locale, so both default to the default locale (DE).

## Error handling summary

- Storage errors are never silent: takedown aborts (502, row stays),
  rotation copy aborts (502, stays public); only post-flip cleanup of the
  old object degrades to a loud log.
- Mail errors are logged, never flip the outcome of the action.
- 404 (not 403) wherever strangers could sniff existence (`POST /api/report`);
  the admin routes keep plain 403 for non-admins.

## Testing

Vitest, reusing the `api` project from PR #29:

- `lib/reports.ts`: category/status validation. `lib/storage.ts`:
  `copyObject` on the fs driver.
- `POST /api/report`: creates a report · unknown puzzle 404 · private puzzle
  404 · 6th report from one IP hash within an hour 429 · duplicate report of
  the same puzzle → silent 200, no second row · length/category validation ·
  the DB holds only the hash, never the plain IP.
- `DELETE /api/admin/puzzles/[id]`: non-admin 403 · storage failure → 502
  and the row stays · shared key → object kept · open reports become
  `TAKEDOWN` and are anonymized · owner mail triggered.
- `PATCH /api/admin/reports/[id]`: dismiss anonymizes.
- Rotation in `PATCH /api/puzzles/[id]`: key changes on public→private ·
  copy failure → 502 and stays public · shared key keeps the old object ·
  private→public does not rotate.
- `ReportDialog` component test (happy path + validation error);
  `lib/messages.test.ts` parity catches missing locale strings.

## Changelog

`Added`: anyone can report a puzzle; admins get a review queue and can remove
a single puzzle. `Security`: private puzzles rotate their image key so
previously cached public URLs stop resolving.
