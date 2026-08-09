// Server-side token creation/consumption for email verification and invites.

import { randomBytes } from "crypto";
import { prisma } from "./db";
import { tokenExpiry, isExpired, expiredTokenFilter, type TokenKind } from "./token-ttl";

/**
 * Delete every token past its expiry (GDPR Art. 5(1)(e)) and report how many
 * went. An expired row has no purpose left — `consumeToken` refuses it — so
 * keeping it is storing personal data for nothing.
 *
 * Called opportunistically from `createToken` and by `npm run purge-expired`.
 */
export async function purgeExpiredTokens(now: number = Date.now()): Promise<number> {
  const { count } = await prisma.verificationToken.deleteMany({
    where: expiredTokenFilter(now),
  });
  return count;
}

export async function createToken(userId: string, type: TokenKind): Promise<string> {
  const now = Date.now();

  // Housekeeping on the way past: this is the only sweep a deployment without
  // cron ever gets, and it is self-limiting because the table only grows when
  // tokens are issued. Before the insert, so the new row is out of its scope —
  // and swallowed, because a failed purge must not turn a registration or an
  // invite into a 500 the user cannot act on.
  await purgeExpiredTokens(now).catch(() => {});

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
