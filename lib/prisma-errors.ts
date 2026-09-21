// Reading Prisma's error codes, for the handful of them a route answers
// differently rather than letting through as a 500.

/**
 * True for an interactive transaction that failed in a way that spent nothing
 * and may well work on the next attempt: P2028 is one that could not be started
 * or that ran past its `maxWait`/`timeout`, P2034 a write conflict or deadlock.
 *
 * Both throw around the callback rather than inside it, which is what makes
 * them easy to miss: a redeem route's own refusals never see them, so without
 * this they read as an unknown error and become a bare 500 for a link the
 * rollback has just handed back intact (#50).
 *
 * Matched on the code rather than with `instanceof`, the way the rest of the
 * repo reads error codes — and because the class would have to come from the
 * generated client, which a route has no other reason to import.
 */
export function isTransientTransactionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "P2028" || code === "P2034";
}
