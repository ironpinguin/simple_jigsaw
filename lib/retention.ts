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

/** Missed windows before `retentionStatus` calls the sweep stale. */
const STALE_AFTER_MISSED_SWEEPS = 3;

type RetentionState = {
  /** When a sweep was last *attempted*. The throttle's clock. */
  lastSweepAt?: number;
  /** When a sweep last *succeeded*. The one an auditor asks about. */
  lastSuccessAt?: number;
  /** Consecutive failures since the last success. */
  failures: number;
};

// Next compiles instrumentation.ts and the route handlers into different
// webpack layers, so this module is emitted once per layer with a distinct
// module id — module-level state would give each layer its own throttle, not
// one shared per process. globalThis is the one thing every layer shares, the
// same reason lib/db.ts caches the Prisma client there. Declared rather than
// cast so the module and lib/retention.test.ts share one definition: with two
// independent casts, renaming the key would silently stop the test clearing it.
declare global {
  var __jigsawRetention: RetentionState | undefined;
}

// Same object in every layer, so the mutations below are shared. Callers that
// need to reset it (tests) delete the global and re-import.
const state: RetentionState = (globalThis.__jigsawRetention ??= { failures: 0 });

/**
 * Delete every token past its expiry and report how many went. An expired row
 * has no purpose left — `consumeToken` refuses it — so keeping it is storing
 * personal data for nothing.
 *
 * Unthrottled: this is the sweep itself. Callers that run on a trigger they do
 * not control want `maybePurgeExpiredTokens`.
 */
export async function purgeExpiredTokens(now: number = Date.now()): Promise<number> {
  const { count } = await prisma.verificationToken.deleteMany({
    where: expiredTokenFilter(now),
  });
  return count;
}

/**
 * Sweep at most once per `SWEEP_INTERVAL_MS`, per process, across every caller.
 * Returns the number of rows deleted, or null when the call was throttled or
 * the sweep failed — callers that need to tell those apart want
 * `retentionStatus`, which is what the readiness endpoint reports from.
 *
 * Never throws, and every statement outside the try below must stay that way:
 * its callers are a readiness probe that must not fail for housekeeping, a
 * timer in instrumentation.ts with nobody to catch it, and token issuance that
 * must not turn into a 500 the user cannot act on.
 */
export async function maybePurgeExpiredTokens(
  now: number = Date.now(),
): Promise<number | null> {
  const last = state.lastSweepAt;
  if (last !== undefined && now - last < SWEEP_INTERVAL_MS) return null;

  // Stamped before the await, not after: two probes arriving in the same tick
  // would otherwise both find the sweep due and both run it. It also means a
  // failed sweep waits out the interval rather than retrying on every probe.
  state.lastSweepAt = now;

  try {
    const count = await purgeExpiredTokens(now);
    state.lastSuccessAt = now;
    state.failures = 0;
    // Only when something went: an idle instance must not log hourly, but the
    // privacy policy promises this deletion and an operator deserves evidence
    // of it beyond the absence of an error.
    if (count > 0) console.info(`[retention] deleted ${count} expired token(s)`);
    return count;
  } catch (error) {
    state.failures += 1;
    console.error("[retention] purge of expired tokens failed; they stay stored:", error);
    return null;
  }
}

/**
 * What an operator needs to tell a working sweep from a broken one. `SELECT 1`
 * succeeding says nothing about the DELETE: a role without delete rights, a
 * full disk, a lock, or a read-only SQLite mount all leave reads healthy while
 * expired personal data accumulates. The readiness endpoint reports this so
 * that failure is visible somewhere other than one line of stdout an hour.
 */
export function retentionStatus(now: number = Date.now()): {
  lastSuccessAt: number | null;
  failures: number;
  stale: boolean;
} {
  const { lastSuccessAt, failures } = state;
  // A fresh process has no success yet and is not stale; one blip is not
  // either. Only a run of missed windows counts.
  const stale =
    lastSuccessAt === undefined
      ? failures >= STALE_AFTER_MISSED_SWEEPS
      : now - lastSuccessAt > STALE_AFTER_MISSED_SWEEPS * SWEEP_INTERVAL_MS;

  return { lastSuccessAt: lastSuccessAt ?? null, failures, stale };
}

/**
 * Sweep now, then every `SWEEP_INTERVAL_MS`. Called once from
 * instrumentation.ts; it lives here so it is covered by the `lib/` tests
 * (vitest.config.ts collects lib/**, components/** and app/api/** only).
 */
export function startRetentionSweeps(): void {
  // Not awaited: startup must not wait on the database, and the function
  // handles its own failures. The .catch is belt and braces — nothing above it
  // in maybePurgeExpiredTokens can throw today, but this is the one call site
  // where a rejection would take the process down rather than a request.
  void maybePurgeExpiredTokens().catch(onSweepContractViolation);

  // unref, so housekeeping is never the reason the process stays alive.
  setInterval(() => {
    void maybePurgeExpiredTokens().catch(onSweepContractViolation);
  }, SWEEP_INTERVAL_MS).unref();
}

function onSweepContractViolation(error: unknown): void {
  console.error("[retention] sweep threw; maybePurgeExpiredTokens must not:", error);
}
