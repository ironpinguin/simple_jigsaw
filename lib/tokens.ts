// Server-side token creation/consumption for email verification, invites and
// password resets.

import { randomBytes } from "crypto";
import { prisma } from "./db";
import { tokenExpiry, isExpired, type TokenKind } from "./token-ttl";
import { maybePurgeExpiredTokens } from "./retention";
import { isTransientTransactionError } from "./prisma-errors";

/** Why a redemption was refused. Only `unavailable` is worth retrying. */
export type ClaimRefusal = "invalid" | "unavailable";

/**
 * The outcome of a redemption. The row is gone if and only if `ok` is true —
 * within the caller's transaction, which for a transactional caller is the
 * whole story only once it commits. See `consumeToken`.
 */
export type TokenClaim = { ok: true; userId: string } | { ok: false; reason: ClaimRefusal };

/**
 * The slice of the Prisma client a claim touches. Narrow on purpose, so a caller
 * inside `prisma.$transaction` can hand `consumeToken` the transaction's own
 * client: a delete that ran on a second connection would commit by itself and
 * outlive the rollback meant to hand a failed activation its link back (#50).
 */
export type TokenDb = Pick<typeof prisma, "verificationToken">;

type ClaimState = {
  /** Failed claims since the last delete that actually removed a row. */
  failures: number;
  /** When the most recent one failed. */
  lastFailureAt?: number;
  /**
   * Claims refused because the row had already gone. Not a failure — a second
   * click is the ordinary cause — but a run of these with no successes is the
   * signature of something deleting tokens out from under the redeem path: a
   * drifted scripts/purge-expired.mjs, a skewed clock, or a DELETE a policy or
   * trigger filters instead of refusing. None of those raise anything to log,
   * so this counter is the only place they show up.
   */
  lost: number;
  /**
   * Claims defeated by their transaction rather than by the DELETE, since the
   * last one that removed a row: a transaction that could not be started or
   * that ran out its deadline around the claim (`recordClaimFailure`), or one
   * that expired or collided under the delete itself (`consumeToken`). Kept
   * apart from `failures` because it is weaker evidence: the commonest cause is
   * two redemptions colliding, not a redeem path that is broken for everyone.
   */
  unattempted: number;
};

/**
 * Collisions tolerated before `unattempted` counts as a broken redeem path.
 * Three, like the sweep's STALE_AFTER_MISSED_SWEEPS and for the same reason:
 * one blip on a quiet instance would otherwise hold the probe red for days,
 * because only a successful claim clears it and activations are rare.
 */
const UNATTEMPTED_BEFORE_DEGRADED = 3;

// Shared per process rather than per module instance, for the reason
// lib/retention.ts sets out at length: Next emits this module once per webpack
// layer, so module scope would give the readiness probe a different counter
// from the one the redeem routes increment. Declared rather than cast so
// lib/tokens.test.ts resets the same shape this creates.
declare global {
  var __jigsawTokenClaims: ClaimState | undefined;
}

const claims: ClaimState = (globalThis.__jigsawTokenClaims ??= {
  failures: 0,
  lost: 0,
  unattempted: 0,
});

/**
 * What an operator needs to tell a working redeem path from a broken one, in
 * the shape `retentionStatus` established next door. The readiness probe
 * reports both, because `SELECT 1` vouches for neither: a role that may read
 * but not delete leaves every link in the instance unredeemable while the
 * database looks perfectly healthy.
 *
 * Degraded on a single `failures`, where the sweep tolerates three. The sweep
 * runs hourly and gets another window, so one blip there is noise; a delete
 * that was refused only runs because somebody clicked their link, so there is
 * no next attempt to stay quiet about, and the one that failed already cost
 * them their activation.
 *
 * `unattempted` is the weaker signal and gets the sweep's tolerance instead —
 * see UNATTEMPTED_BEFORE_DEGRADED. A run of either still shows up.
 *
 * Only a claim whose delete removed a row clears them. Inside a transaction
 * that is a delete which ran and then rolled back, which still answers the
 * question the flag asks — whether the DELETE works — even though the row came
 * back.
 */
export function tokenClaimStatus(): {
  failures: number;
  lastFailureAt: number | null;
  lost: number;
  unattempted: number;
  degraded: boolean;
} {
  return {
    failures: claims.failures,
    lastFailureAt: claims.lastFailureAt ?? null,
    lost: claims.lost,
    unattempted: claims.unattempted,
    degraded: claims.failures > 0 || claims.unattempted >= UNATTEMPTED_BEFORE_DEGRADED,
  };
}

/**
 * Book a claim that could not be attempted at all, for a caller that knows the
 * attempt failed before `consumeToken` could say so itself. `redeemToken`
 * (lib/token-redeem.ts) is that caller — a `$transaction`
 * that never started or ran out its deadline throws around the claim, not
 * inside it (#50). Without this the counters stay clean and the readiness probe
 * keeps reporting a healthy redeem path while every activation in the instance
 * is failing, which is the one thing `tokenClaimStatus` exists to prevent.
 *
 * Logged like the failure next door and cleared the same way: only a delete
 * that actually removes a row proves the redeem path works again.
 */
export function recordClaimFailure(type: TokenKind, error: unknown): void {
  claims.unattempted += 1;
  claims.lastFailureAt = Date.now();
  console.error(`[tokens] could not attempt a ${type} claim; refusing it:`, error);
}

export async function createToken(
  userId: string,
  type: TokenKind,
  requesterIpHash: string | null = null,
): Promise<string> {
  const now = Date.now();

  // Housekeeping on the way past, sharing the hourly budget with the timer in
  // instrumentation.ts and the readiness probe. Issuing a token therefore no
  // longer means a table-wide DELETE, and the one place that logs a failed
  // sweep is lib/retention.ts. Called bare, not `.catch()`-guarded: the
  // function is documented never to throw, and lib/retention.test.ts pins the
  // failure that actually happens — the DELETE rejecting. Code added *before*
  // that function's try would escape both the test and this call site.
  await maybePurgeExpiredTokens(now);

  const token = randomBytes(32).toString("hex");
  await prisma.verificationToken.create({
    data: { token, type, userId, expiresAt: tokenExpiry(type, now), requesterIpHash },
  });
  return token;
}

/**
 * Delete every outstanding token of one kind for a user, and report how many
 * went. For the case where a fresh link is meant to supersede the old one —
 * re-inviting an account that never activated — so that the newest link is the
 * only one that works. Two valid password-setting links sitting in two
 * different mailboxes is a worse outcome than making an admin send one more.
 *
 * Deliberately not folded into `createToken`: registration mints the first token
 * for a brand-new row and has nothing to revoke, and a caller that supersedes an
 * existing link should have to say so rather than inherit a delete it never
 * asked for.
 */
export async function revokeTokens(userId: string, type: TokenKind): Promise<number> {
  const { count } = await prisma.verificationToken.deleteMany({ where: { userId, type } });
  return count;
}

/**
 * Look up a token and claim it (single-use), reporting whether the caller may
 * act on it. `ok` is true only when this call's own delete removed the row, so
 * whatever the caller does next happens at most once per link.
 *
 * The delete *is* the claim. Reading the row and then deleting it is not one:
 * two redemptions of the same link both read it before either delete lands, so
 * both used to be granted. `token` is `@unique` (prisma/schema.prisma), so one
 * DELETE matches at most one row and only one caller can come back with a
 * non-zero count — dropping that constraint would quietly break single-use.
 *
 * The two refusals are different answers, and the callers must keep them apart:
 *
 * - `invalid` — unknown, wrong type, expired, or already claimed. Ordinary, and
 *   answered with a 400. Counted (`lost` in `tokenClaimStatus`) but not logged:
 *   the usual cause is a second click, and `[tokens]` in the log should mean
 *   something went wrong.
 * - `unavailable` — the delete itself failed: a role without delete rights, a
 *   lock timeout, SQLITE_BUSY. Refused rather than swallowed, which is the point
 *   of all this — granting on a token that was never spent left an invite's
 *   password-setting link live for as long as its TTL (`TOKEN_TTL_MS`). The row
 *   survives, so a retry can still succeed, which is why this is a 503 and not
 *   the user's link being called bad. Nothing else recovers it: EMAIL_VERIFY is
 *   only minted at registration and INVITE only by an admin, so a holder who
 *   keeps hitting this needs an operator — `tokenClaimStatus` and the log line
 *   below are how the operator finds out.
 *
 * Given a transaction's client in `db`, "spent" means spent once that
 * transaction commits: a caller that rolls back hands the link back intact.
 * Routes do not call this directly: `redeemToken` (lib/token-redeem.ts) runs
 * it inside the transaction with the work it authorises, and eslint.config.mjs
 * forbids importing it anywhere else — the module client satisfies `TokenDb`
 * too, so the type alone could not stop a claim that spends the link before a
 * write that may still fail (#50, #91).
 *
 * One consequence worth naming, because it reverses what this function does on
 * its own: an expired row is deleted here *before* the expiry is read, so that
 * a click removes the link whatever the verdict — but the verdict is `invalid`,
 * and a transactional caller that refuses on it rolls that delete back. The row
 * therefore survives an expired click and waits for the retention sweep instead
 * (`maybePurgeExpiredTokens`). It is still expired and still refused; only the
 * housekeeping moves.
 */
export async function consumeToken(
  token: string,
  type: TokenKind,
  db: TokenDb,
): Promise<TokenClaim> {
  const row = await db.verificationToken.findUnique({ where: { token } });
  if (!row || row.type !== type) return { ok: false, reason: "invalid" };

  let claimed: number;
  try {
    // Single-use regardless of the expiry outcome: an expired link that does get
    // clicked leaves nothing behind either. `type` is redundant with the guard
    // above — kept so the delete cannot outlive that check if this function is
    // ever reordered.
    ({ count: claimed } = await db.verificationToken.deleteMany({ where: { token, type } }));
  } catch (error) {
    // A transaction that expired or collided under the delete is the weaker
    // signal `recordClaimFailure` books, not a DELETE that was refused: the
    // commonest cause is two redemptions colliding, and booking it as a failure
    // would hold the probe red on a single slow transaction.
    if (isTransientTransactionError(error)) claims.unattempted += 1;
    else claims.failures += 1;
    claims.lastFailureAt = Date.now();
    // Names its subject: which link type is broken, and whose account is stuck,
    // are the two things an operator needs and neither is recoverable from the
    // error. Never the token itself — that is still a live credential whenever
    // the delete failed rather than the row going.
    console.error(
      `[tokens] could not claim the ${type} token of user ${row.userId}; refusing it:`,
      error,
    );
    return { ok: false, reason: "unavailable" };
  }

  // Nothing removed means somebody else got there first, or the row went in the
  // retention sweep. Ordinary, so no log — only a real failure gets one.
  if (claimed === 0) {
    claims.lost += 1;
    return { ok: false, reason: "invalid" };
  }

  // The DELETE works, whatever this particular row's expiry turns out to say,
  // and whatever the enclosing transaction goes on to decide.
  claims.failures = 0;
  claims.unattempted = 0;

  if (isExpired(row.expiresAt, Date.now())) return { ok: false, reason: "invalid" };
  return { ok: true, userId: row.userId };
}
