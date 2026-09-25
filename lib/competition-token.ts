// The signed start of a competition attempt (#119). Stateless: the server
// stamps when an attempt began and signs it, the browser hands the token back
// with the finished time, and the submission is judged against how long has
// really passed since (lib/competition.ts). Nothing is stored per attempt.
//
// Separate from lib/competition.ts because node:crypto must not end up in
// client bundles.

import { createHmac, timingSafeEqual } from "crypto";

const TOKEN_PURPOSE = "competition-start:v1";

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value) {
    // An empty key would make every token forgeable by anyone who reads this file.
    throw new Error("AUTH_SECRET must be set — competition start tokens would be unsigned");
  }
  return value;
}

/**
 * Bound to puzzle and user, so a token cannot be carried to another
 * competition or handed to another account; the purpose prefix keeps these
 * MACs apart from any other HMAC keyed with the same secret.
 */
function mac(puzzleId: string, userId: string, startedAt: number): Buffer {
  return createHmac("sha256", secret())
    .update(`${TOKEN_PURPOSE}\n${puzzleId}\n${userId}\n${startedAt}`)
    .digest();
}

/** `<startedAt>.<mac as base64url>` */
export function signCompetitionStart(puzzleId: string, userId: string, startedAt: number): string {
  return `${startedAt}.${mac(puzzleId, userId, startedAt).toString("base64url")}`;
}

/**
 * When the attempt started, or `null` if `token` was not issued by this server
 * for this puzzle and user. Says nothing about whether it is still in time —
 * that is `judgeSubmission`'s part.
 */
export function verifyCompetitionStart(
  token: string,
  puzzleId: string,
  userId: string,
): number | null {
  const match = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const startedAt = Number(match[1]);
  const given = Buffer.from(match[2], "base64url");
  const expected = mac(puzzleId, userId, startedAt);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return startedAt;
}
