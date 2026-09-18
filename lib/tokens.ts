// Server-side token creation/consumption for email verification and invites.

import { randomBytes } from "crypto";
import { prisma } from "./db";
import { tokenExpiry, isExpired, type TokenKind } from "./token-ttl";
import { maybePurgeExpiredTokens } from "./retention";

/** Why a redemption was refused. Only `unavailable` is worth retrying. */
export type ClaimRefusal = "invalid" | "unavailable";

/** The outcome of a redemption. The row is gone if and only if `ok` is true. */
export type TokenClaim = { ok: true; userId: string } | { ok: false; reason: ClaimRefusal };

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
};

// Shared per process rather than per module instance, for the reason
// lib/retention.ts sets out at length: Next emits this module once per webpack
// layer, so module scope would give the readiness probe a different counter
// from the one the redeem routes increment. Declared rather than cast so
// lib/tokens.test.ts resets the same shape this creates.
declare global {
  var __jigsawTokenClaims: ClaimState | undefined;
}

const claims: ClaimState = (globalThis.__jigsawTokenClaims ??= { failures: 0, lost: 0 });

/**
 * What an operator needs to tell a working redeem path from a broken one, in
 * the shape `retentionStatus` established next door. The readiness probe
 * reports both, because `SELECT 1` vouches for neither: a role that may read
 * but not delete leaves every link in the instance unredeemable while the
 * database looks perfectly healthy.
 *
 * Degraded on a single failure, where the sweep tolerates three. The sweep runs
 * hourly and gets another window, so one blip there is noise; a claim only runs
 * because somebody clicked their link, so there is no next attempt to stay
 * quiet about, and the one that failed already cost them their activation. Only
 * a delete that removes a row clears it — nothing else proves the DELETE works.
 */
export function tokenClaimStatus(): {
  failures: number;
  lastFailureAt: number | null;
  lost: number;
  degraded: boolean;
} {
  return {
    failures: claims.failures,
    lastFailureAt: claims.lastFailureAt ?? null,
    lost: claims.lost,
    degraded: claims.failures > 0,
  };
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
 */
export async function consumeToken(token: string, type: TokenKind): Promise<TokenClaim> {
  const row = await prisma.verificationToken.findUnique({ where: { token } });
  if (!row || row.type !== type) return { ok: false, reason: "invalid" };

  let claimed: number;
  try {
    // Single-use regardless of the expiry outcome: an expired link that does get
    // clicked leaves nothing behind either. `type` is redundant with the guard
    // above — kept so the delete cannot outlive that check if this function is
    // ever reordered.
    ({ count: claimed } = await prisma.verificationToken.deleteMany({ where: { token, type } }));
  } catch (error) {
    claims.failures += 1;
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

  // The DELETE works, whatever this particular row's expiry turns out to say.
  claims.failures = 0;

  if (isExpired(row.expiresAt, Date.now())) return { ok: false, reason: "invalid" };
  return { ok: true, userId: row.userId };
}
