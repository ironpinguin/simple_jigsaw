// Deleting a user account, shared by the self-service route
// (app/api/account) and the admin route (app/api/admin/users/[id]).
//
// The order is the whole point: every image goes first, and a storage failure
// aborts before a single row is touched. Dropping the rows first would leave
// the object behind as personal data nobody can erase any more — image
// delivery 404s a key no puzzle references (app/api/image), so it is not that
// the file stays reachable, it is that the only rows recording which key to
// clean up are gone. The caller sees the storage error and retries instead.

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

/**
 * Thrown when a storage object could not be removed; the caller answers 502.
 *
 * `deleted` are the keys already gone when the run stopped. The abort is
 * atomic for the database, not for storage — an account with several images
 * can lose the first few and keep every row, leaving puzzles whose object is
 * missing until the retry finishes the job. A caller that logs only `key`
 * makes that partial state invisible, so it is carried here.
 */
export class StorageCleanupError extends Error {
  constructor(
    readonly key: string,
    readonly deleted: readonly string[],
    cause: unknown,
  ) {
    super(`storage delete of ${key} failed`, { cause });
    this.name = "StorageCleanupError";
  }
}

/**
 * Delete a user, their images and their puzzles' open reports. Puzzles and
 * verification tokens go with the user row via onDelete: Cascade — which is
 * why the transaction below only has to name the reports.
 *
 * Images first (see the file comment). Sequentially, not with Promise.all: on
 * a failing storage backend the first error should stop the run rather than
 * fire one request per puzzle and report only the last outcome.
 *
 * Throws StorageCleanupError if a delete fails — objects shared with another
 * account are left alone without throwing. Returns false when the row was
 * already gone (a concurrent delete), so the caller can answer 404.
 */
export async function deleteAccount(userId: string): Promise<boolean> {
  const puzzles = await prisma.puzzle.findMany({
    where: { ownerId: userId },
    select: { id: true },
  });
  const keys = await exclusiveImageKeys(userId);

  const deleted: string[] = [];
  for (const key of keys) {
    try {
      await deleteObject(key);
      deleted.push(key);
    } catch (err) {
      throw new StorageCleanupError(key, deleted, err);
    }
  }

  // One transaction: a failure between the two would leave the puzzles gone
  // but their reports OPEN, pointing at rows that no longer exist and still
  // holding the reporter's email and IP hash. Report has no foreign key to
  // Puzzle by design, so nothing resolves them automatically — they would sit
  // in the open queue as manual work until an admin dismisses them.
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
