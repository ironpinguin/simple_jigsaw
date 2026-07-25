// Server-side token creation/consumption for email verification and invites.

import { randomBytes } from "crypto";
import { prisma } from "./db";
import { tokenExpiry, isExpired, type TokenKind } from "./token-ttl";

export async function createToken(userId: string, type: TokenKind): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await prisma.verificationToken.create({
    data: { token, type, userId, expiresAt: tokenExpiry(type, Date.now()) },
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
