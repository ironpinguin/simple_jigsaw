// The signed start of a competition attempt (#119) — see lib/attempt-token.ts
// for the mechanism, which the personal best times (#127) share under a
// purpose of their own.

import { signAttemptStart, verifyAttemptStart } from "./attempt-token";

const PURPOSE = "competition-start:v1";

/** `<startedAt>.<mac as base64url>` */
export function signCompetitionStart(puzzleId: string, userId: string, startedAt: number): string {
  return signAttemptStart(PURPOSE, puzzleId, userId, startedAt);
}

/**
 * When the attempt started, or `null` if `token` was not issued by this server
 * for this puzzle and user — or was issued for something other than a
 * competition. Says nothing about whether it is still in time.
 */
export function verifyCompetitionStart(
  token: string,
  puzzleId: string,
  userId: string,
): number | null {
  return verifyAttemptStart(PURPOSE, token, puzzleId, userId);
}
