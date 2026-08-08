// Deleting a user account, shared by the self-service route
// (app/api/account) and the admin route (app/api/admin/users/[id]).
//
// The order is the whole point: every image goes first, and a storage failure
// aborts before a single row is touched. An Art. 17 erasure that reports
// success while the image is still retrievable through app/api/image is the
// failure this must not have — so the caller sees the storage error and
// retries, rather than losing the rows that say which objects to clean up.

import { prisma } from "./db";
import { deleteObject } from "./storage";
import { resolveOpenReports } from "./reports-server";

/**
 * Keys the account owns exclusively. An owner may reuse one key across their
 * own puzzles (the imageKey index is deliberately not unique), and a key that
 * another account still references must survive — deleting it would break a
 * puzzle that is not being erased.
 */
export async function exclusiveImageKeys(userId: string): Promise<string[]> {
  const own = await prisma.puzzle.findMany({
    where: { ownerId: userId },
    select: { imageKey: true },
  });
  const keys = [...new Set(own.map((p) => p.imageKey))];
  if (keys.length === 0) return [];

  const foreign = await prisma.puzzle.findMany({
    where: { imageKey: { in: keys }, ownerId: { not: userId } },
    select: { imageKey: true },
  });
  const shared = new Set(foreign.map((p) => p.imageKey));
  return keys.filter((key) => !shared.has(key));
}

/** Thrown when a storage object could not be removed; the caller answers 502. */
export class StorageCleanupError extends Error {
  constructor(readonly key: string, cause: unknown) {
    super(`storage delete of ${key} failed`);
    this.name = "StorageCleanupError";
    this.cause = cause;
  }
}

/**
 * Delete a user, their images and their puzzles' open reports.
 *
 * Images first (see the file comment). Sequentially, not with Promise.all: on
 * a failing storage backend the first error should stop the run rather than
 * fire one request per puzzle and report only the last outcome.
 *
 * Throws StorageCleanupError if any object survives. Returns false when the
 * row was already gone (a concurrent delete), so the caller can answer 404.
 */
export async function deleteAccount(userId: string): Promise<boolean> {
  const puzzles = await prisma.puzzle.findMany({
    where: { ownerId: userId },
    select: { id: true },
  });
  const keys = await exclusiveImageKeys(userId);

  for (const key of keys) {
    try {
      await deleteObject(key);
    } catch (err) {
      throw new StorageCleanupError(key, err);
    }
  }

  // One transaction: a failure between the two would leave the puzzles gone
  // but their reports OPEN, pointing at rows that no longer exist and still
  // holding the reporter's email and IP hash. Report has no foreign key to
  // Puzzle by design, so nothing else would ever resolve them.
  return prisma.$transaction(async (tx) => {
    if (puzzles.length > 0) {
      await resolveOpenReports(tx, { puzzleId: { in: puzzles.map((p) => p.id) } }, "TAKEDOWN");
    }
    // deleteMany, not delete: a concurrent delete of the same user answers
    // count 0 instead of throwing a Prisma "record not found".
    const deleted = await tx.user.deleteMany({ where: { id: userId } });
    return deleted.count > 0;
  });
}
