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
 * Look up a token, delete it (single-use), and return its userId if it is valid
 * and unexpired for the given type. Returns null otherwise.
 */
export async function consumeToken(
  token: string,
  type: TokenKind,
): Promise<{ userId: string } | null> {
  const row = await prisma.verificationToken.findUnique({ where: { token } });
  if (!row || row.type !== type) return null;

  // Single-use: remove it regardless of expiry outcome.
  await prisma.verificationToken.delete({ where: { token } }).catch(() => {});

  if (isExpired(row.expiresAt, Date.now())) return null;
  return { userId: row.userId };
}
