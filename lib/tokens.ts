// Server-side token creation/consumption for email verification and invites.

import { randomBytes } from "crypto";
import { prisma } from "./db";
import { tokenExpiry, isExpired, type TokenKind } from "./token-ttl";
import { maybePurgeExpiredTokens } from "./retention";

export async function createToken(userId: string, type: TokenKind): Promise<string> {
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
    data: { token, type, userId, expiresAt: tokenExpiry(type, now) },
  });
  return token;
}

/**
 * Look up a token, claim it (single-use), and return its userId if it is valid
 * and unexpired for the given type. Returns null otherwise.
 *
 * The delete *is* the claim, and its result decides the answer. Reading the row
 * and then deleting it is not a claim: two redemptions of the same link both
 * read it before either delete lands, so both used to be told they had spent
 * it. Deleting by `{ token, type }` is atomic, so exactly one caller can see a
 * count of 1 — everyone else loses the race and is refused.
 *
 * A failed delete is refused rather than swallowed. It used to return the
 * userId anyway, which left a single-use link live until it expired: 24 h for
 * EMAIL_VERIFY, 7 days for INVITE. That one matters most, because an invite is
 * a password-setting link — anyone still holding the mail could set the
 * password again after the legitimate recipient had activated the account.
 * The causes are ordinary (a role without delete rights, a lock timeout,
 * SQLITE_BUSY), which is exactly why they must not pass silently.
 *
 * Refusing costs a legitimate holder a new link and gains an operator a log
 * line; granting on an unconsumed token is the security bug. `null` is what
 * both callers already render as a translated "link is invalid" (verifyInvalid
 * / inviteInvalid), so no route has to learn anything new — and neither may
 * proceed on a token that was never actually spent.
 */
export async function consumeToken(
  token: string,
  type: TokenKind,
): Promise<{ userId: string } | null> {
  const row = await prisma.verificationToken.findUnique({ where: { token } });
  if (!row || row.type !== type) return null;

  let claimed: number;
  try {
    // Single-use, regardless of expiry outcome: an expired link that does get
    // clicked leaves nothing behind either.
    ({ count: claimed } = await prisma.verificationToken.deleteMany({ where: { token, type } }));
  } catch (error) {
    console.error("[tokens] could not consume the token; refusing it:", error);
    return null;
  }

  // Nothing removed means somebody else got there first, or the row went in
  // the retention sweep. Ordinary, so no log — only a real failure gets one.
  if (claimed === 0) return null;

  if (isExpired(row.expiresAt, Date.now())) return null;
  return { userId: row.userId };
}
