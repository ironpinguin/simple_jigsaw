// The signed start of a timed attempt. Stateless: the server stamps when an
// attempt began and signs it, the browser hands the token back with the
// finished time, and the submission is judged against how long has really
// passed since (`judgeSubmission` in lib/competition.ts). Nothing is stored
// per attempt.
//
// One mechanism, one purpose per use: a competition entry (#119) and a
// personal best time (#127) each sign with their own purpose string, so a
// token issued for one is never accepted by the other — a best-time start
// is handed out for any puzzle at any time, and must not become a way into a
// leaderboard that only accepts starts made while it was open.
//
// Separate from lib/competition.ts because node:crypto must not end up in
// client bundles.

import { createHmac, timingSafeEqual } from "crypto";

export type AttemptPurpose = "competition-start:v1" | "best-time-start:v1";

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value) {
    // An empty key would make every token forgeable by anyone who reads this file.
    throw new Error("AUTH_SECRET must be set — attempt start tokens would be unsigned");
  }
  return value;
}

/**
 * Bound to purpose, puzzle and user, so a token cannot be carried to another
 * use, another puzzle or another account; the purpose also keeps these MACs
 * apart from any other HMAC keyed with the same secret.
 */
function mac(purpose: AttemptPurpose, puzzleId: string, userId: string, startedAt: number): Buffer {
  return createHmac("sha256", secret())
    .update(`${purpose}\n${puzzleId}\n${userId}\n${startedAt}`)
    .digest();
}

/** `<startedAt>.<mac as base64url>` */
export function signAttemptStart(
  purpose: AttemptPurpose,
  puzzleId: string,
  userId: string,
  startedAt: number,
): string {
  return `${startedAt}.${mac(purpose, puzzleId, userId, startedAt).toString("base64url")}`;
}

/**
 * When the attempt started, or `null` if `token` was not issued by this server
 * for this purpose, puzzle and user. Says nothing about whether it is still in
 * time — that is `judgeSubmission`'s part.
 */
export function verifyAttemptStart(
  purpose: AttemptPurpose,
  token: string,
  puzzleId: string,
  userId: string,
): number | null {
  const match = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const startedAt = Number(match[1]);
  const given = Buffer.from(match[2], "base64url");
  const expected = mac(purpose, puzzleId, userId, startedAt);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return startedAt;
}
