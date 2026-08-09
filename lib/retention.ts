// Retention sweep for expired tokens (GDPR Art. 5(1)(e), storage limitation)
// and the throttle every trigger shares.
//
// The privacy policy promises expired links are removed automatically, so the
// sweep must not depend on an operator scheduling anything. It is driven from
// three places — the startup timer in instrumentation.ts, the readiness probe,
// and createToken — which is why the budget lives here rather than at any one
// of them.

import { prisma } from "./db";
import { expiredTokenFilter } from "./token-ttl";

export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let lastSweepAt: number | null = null;

/**
 * Delete every token past its expiry and report how many went. An expired row
 * has no purpose left — `consumeToken` refuses it — so keeping it is storing
 * personal data for nothing.
 *
 * Unthrottled: this is the sweep itself. Callers that run on a trigger they do
 * not control want `maybePurgeExpiredTokens`.
 *
 * `scripts/purge-expired.mjs` performs the same deletion independently — it
 * runs under plain `node` with no TS loader, so it cannot import this module;
 * keep the two in step.
 */
export async function purgeExpiredTokens(now: number = Date.now()): Promise<number> {
  const { count } = await prisma.verificationToken.deleteMany({
    where: expiredTokenFilter(now),
  });
  return count;
}

/**
 * Sweep at most once per `SWEEP_INTERVAL_MS` across every caller. Returns the
 * number of rows deleted, or null when the call was throttled or the sweep
 * failed — nothing branches on the difference.
 *
 * Never throws. Its callers are a readiness probe that must not fail for
 * housekeeping, a timer with nobody to catch it, and token issuance that must
 * not turn into a 500 the user cannot act on.
 */
export async function maybePurgeExpiredTokens(
  now: number = Date.now(),
): Promise<number | null> {
  if (lastSweepAt !== null && now - lastSweepAt < SWEEP_INTERVAL_MS) return null;

  // Stamped before the await, not after: two probes arriving in the same tick
  // would otherwise both find the sweep due and both run it. It also means a
  // failed sweep waits out the interval rather than retrying on every probe.
  lastSweepAt = now;

  try {
    return await purgeExpiredTokens(now);
  } catch (error) {
    console.error("[retention] purge of expired tokens failed; they stay stored:", error);
    return null;
  }
}
