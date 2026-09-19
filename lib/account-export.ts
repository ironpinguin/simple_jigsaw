// Self-service data export (GDPR Art. 15, and Art. 20 portability while we are
// at it): everything the instance stores about the logged-in user, as one JSON
// file they can download.
//
// Images are referenced by URL rather than embedded. The bytes are already
// served from those URLs, so an archive would only duplicate them — at the cost
// of streaming, a size bound and a timeout on an endpoint that is otherwise a
// single query. `docs/` and the issue record that decision.
//
// Deliberately *not* in the payload:
//   - `passwordHash` — see the test; the file is something users mail around.
//   - `VerificationToken` rows. They are live credentials: an export containing
//     an unexpired invite link would be a second key to the account. They are
//     transient and self-deleting (lib/retention.ts), not a record of the user.
//   - `Report` rows. Reports are pseudonymous and not keyed to an account, and
//     a reporter's identity is exactly what must not leak back to an uploader.

/** Rows the export reads. Structural, so Prisma's selects satisfy it. */
type ExportableUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  locale: string;
  emailVerified: Date | null;
  termsAcceptedAt: Date | null;
  termsVersion: string | null;
  createdAt: Date;
};

type ExportablePuzzle = {
  id: string;
  title: string;
  imageKey: string;
  imageWidth: number;
  imageHeight: number;
  pieceCount: number;
  cols: number;
  rows: number;
  seed: number;
  isPublic: boolean;
  createdAt: Date;
};

export type AccountExport = {
  exportedAt: string;
  account: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    locale: string;
    emailVerified: string | null;
    termsAcceptedAt: string | null;
    termsVersion: string | null;
    createdAt: string;
  };
  puzzles: Array<{
    id: string;
    title: string;
    imageUrl: string;
    imageWidth: number;
    imageHeight: number;
    pieceCount: number;
    cols: number;
    rows: number;
    seed: number;
    isPublic: boolean;
    createdAt: string;
  }>;
};

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

/**
 * Assemble the payload. Pure: the route does the querying, so every field that
 * ends up in the file is decided in one place a test can read.
 *
 * Fields are copied out one by one rather than spread, so a column added to
 * `User` or `Puzzle` later — a password reset stamp, a moderation verdict —
 * cannot appear in an export by accident.
 */
export function buildAccountExport({
  user,
  puzzles,
  baseUrl,
  exportedAt = new Date(),
}: {
  user: ExportableUser;
  puzzles: ExportablePuzzle[];
  baseUrl: string;
  exportedAt?: Date;
}): AccountExport {
  return {
    exportedAt: exportedAt.toISOString(),
    account: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      locale: user.locale,
      emailVerified: iso(user.emailVerified),
      termsAcceptedAt: iso(user.termsAcceptedAt),
      termsVersion: user.termsVersion,
      createdAt: user.createdAt.toISOString(),
    },
    puzzles: puzzles.map((puzzle) => ({
      id: puzzle.id,
      title: puzzle.title,
      // Absolute, so the file still means something once it has left the
      // browser that downloaded it.
      imageUrl: `${baseUrl}/api/image/${encodeURIComponent(puzzle.imageKey)}`,
      imageWidth: puzzle.imageWidth,
      imageHeight: puzzle.imageHeight,
      pieceCount: puzzle.pieceCount,
      cols: puzzle.cols,
      rows: puzzle.rows,
      seed: puzzle.seed,
      isPublic: puzzle.isPublic,
      createdAt: puzzle.createdAt.toISOString(),
    })),
  };
}

export const EXPORT_RATE_LIMIT = 5;
export const EXPORT_RATE_WINDOW_MS = 60 * 60 * 1000;

// Per process, like the retention throttle and for the same reason: Next emits
// this module once per webpack layer, so globalThis is what makes one budget
// out of several copies. With `replicas: N` a user gets up to N times the
// limit — acceptable, because this only bounds a logged-in user reading their
// own rows, and the alternative is a table and a schema change on two
// providers for something no operator needs to audit.
declare global {
  var __jigsawExportHits: Map<string, number[]> | undefined;
}

const hits: Map<string, number[]> = (globalThis.__jigsawExportHits ??= new Map());

/**
 * Claim one export for `userId`, or refuse when the last
 * `EXPORT_RATE_WINDOW_MS` already holds `EXPORT_RATE_LIMIT` of them. The
 * endpoint reads the account and every puzzle row, so it is the most expensive
 * thing a session can trigger by holding a key down.
 */
export function takeExportSlot(userId: string, now: number = Date.now()): boolean {
  const recent = (hits.get(userId) ?? []).filter((at) => at > now - EXPORT_RATE_WINDOW_MS);

  if (recent.length >= EXPORT_RATE_LIMIT) {
    hits.set(userId, recent);
    return false;
  }

  recent.push(now);
  hits.set(userId, recent);
  return true;
}

/**
 * Hand back a slot claimed by `takeExportSlot` when the export did not happen
 * after all. Slots are interchangeable — only how many of them fall inside the
 * window matters — so this drops the most recent one rather than hunting for a
 * particular timestamp.
 */
export function releaseExportSlot(userId: string): void {
  const recent = hits.get(userId);
  if (!recent?.length) return;

  recent.pop();
  if (recent.length === 0) hits.delete(userId);
}
