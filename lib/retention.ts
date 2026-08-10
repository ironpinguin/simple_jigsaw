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
  /**
   * The same two facts for the verdict sweep, tracked apart from the token
   * sweep rather than sharing its counter. A success in one says nothing about
   * the other, and on a shared counter the token purge's hourly success would
   * reset it — so a verdict sweep failing every single time would oscillate
   * 0 → 1 → 0 and never reach the stale threshold, making it permanently
   * invisible instead of merely quiet.
   */
  verdictLastSuccessAt?: number;
  verdictFailures: number;
  /**
   * Paging cursor into the age-ordered verdict candidates. Without it, a wall
   * of verdicts that are old enough but still claimed would occupy every
   * batch forever — its rows never stop matching the age filter, so a sweep
   * that always started at the top would re-examine the same wall on every
   * run and never reach genuine orphans behind it. In-memory only, like the
   * rest of this state: a restart loses the cursor, and the next sweep just
   * starts over from the oldest candidates, which is fine for housekeeping.
   */
  verdictSweepOffset: number;
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
const state: RetentionState = (globalThis.__jigsawRetention ??= {
  failures: 0,
  verdictFailures: 0,
  verdictSweepOffset: 0,
});

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
 * How long an unclaimed verdict is kept, in case the puzzle is still coming.
 *
 * A week, far more than the minutes a create form takes, because deleting one
 * early is not free: /api/puzzles holds a key whose verdict has vanished for
 * review rather than publishing it (that is what stops a flagged upload being
 * laundered by outwaiting this sweep), so an API client that uploads well
 * before it creates the puzzle — or retries a create after an earlier attempt
 * failed — would land in the moderation queue even though its image passed
 * cleanly. Each row is a handful of bytes and only genuine orphans are ever
 * swept, so a generous window costs nothing and spares that caller.
 */
export const VERDICT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// Bounds both queries below regardless of how many puzzles or stale verdicts
// the instance has accumulated. SQLite's default bound-parameter limit is 999
// (SQLITE_MAX_VARIABLE_NUMBER); 500 leaves headroom for the query's other
// parameters and for this to be raised later without brushing that ceiling.
// Exported so a test can pin the exact value — otherwise nothing stops a
// future edit from raising it above 999 and reintroducing that crash.
export const VERDICT_SWEEP_BATCH = 500;

/**
 * Delete verdicts for images no puzzle references. An upload the user
 * abandoned leaves a row behind that nothing will ever read; the grace period
 * covers the gap between the upload request and the puzzle that claims it.
 *
 * Selects candidates first and asks only about their keys, rather than
 * loading every puzzle's imageKey and excluding it with `notIn`: that would
 * grow with the size of the instance, and a large enough `IN (...)` list can
 * exceed SQLite's bound-variable limit and turn routine housekeeping into an
 * exception. This shape is bounded by VERDICT_SWEEP_BATCH instead.
 *
 * Pages through candidates via `verdictSweepOffset` rather than taking the
 * same batch every time: `createdAt` only grows staler, never fresher, so a
 * verdict that is old enough but still claimed would otherwise occupy the
 * same slot in every future sweep and permanently block any real orphan
 * behind it from ever being examined. Ordering is explicit (`createdAt` then
 * `imageKey`, both total and stable) so paging cannot skip or repeat a row
 * regardless of what either database's default row order would do.
 */
export async function purgeOrphanedVerdicts(now: number = Date.now()): Promise<number> {
  const candidates = await prisma.imageVerdict.findMany({
    where: { createdAt: { lt: new Date(now - VERDICT_GRACE_MS) } },
    select: { imageKey: true },
    orderBy: [{ createdAt: "asc" }, { imageKey: "asc" }],
    skip: state.verdictSweepOffset,
    take: VERDICT_SWEEP_BATCH,
  });

  // A page shorter than a full batch means the scan reached the end of the
  // candidates that currently exist; start the next sweep over from the
  // oldest rather than paging into empty space forever.
  const reachedEnd = candidates.length < VERDICT_SWEEP_BATCH;

  if (candidates.length === 0) {
    state.verdictSweepOffset = 0;
    return 0;
  }

  const candidateKeys = candidates.map((verdict) => verdict.imageKey);
  const claimed = await prisma.puzzle.findMany({
    where: { imageKey: { in: candidateKeys } },
    select: { imageKey: true },
  });
  const claimedKeys = new Set(claimed.map((puzzle) => puzzle.imageKey));
  const orphanKeys = candidateKeys.filter((key) => !claimedKeys.has(key));

  const { count } = await prisma.imageVerdict.deleteMany({
    where: { imageKey: { in: orphanKeys } },
  });

  // Deleted rows vanish from the table entirely, so only the rows that
  // survive this page — the claimed ones — need to be skipped next time.
  // Advancing by the full page size regardless would, whenever this page
  // deleted anything, skip over the rows that shift down to fill the gap:
  // the exact "real orphans never examined" failure this paging exists to
  // prevent. Left unchanged on a thrown deleteMany, so a failed page is
  // retried from the same offset rather than assumed processed.
  state.verdictSweepOffset = reachedEnd
    ? 0
    : state.verdictSweepOffset + candidates.length - count;

  return count;
}

/**
 * Sweep at most once per `SWEEP_INTERVAL_MS`, per process, across every caller.
 * Returns the number of *tokens* deleted, or null when the call was throttled
 * or the token purge failed — callers that need to tell those apart, or that
 * care about the verdict sweep at all, want `retentionStatus`, which is what
 * the readiness endpoint reports from.
 *
 * Runs both sweeps, independently: neither is skipped because the other threw.
 *
 * Never throws, and every statement outside the two try blocks below must stay
 * that way: its callers are a readiness probe that must not fail for
 * housekeeping, a timer in instrumentation.ts with nobody to catch it, and
 * token issuance that must not turn into a 500 the user cannot act on.
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

  let count: number | null = null;
  try {
    count = await purgeExpiredTokens(now);
    state.lastSuccessAt = now;
    state.failures = 0;
    // Only when something went: an idle instance must not log hourly, but the
    // privacy policy promises this deletion and an operator deserves evidence
    // of it beyond the absence of an error.
    if (count > 0) console.info(`[retention] deleted ${count} expired token(s)`);
  } catch (error) {
    state.failures += 1;
    console.error("[retention] purge of expired tokens failed; they stay stored:", error);
  }

  // Sequenced after the token purge but not conditional on it. These are
  // unrelated tables, and this block used to sit inside the try above, after
  // its await — so a locked verificationToken table skipped verdict deletion
  // entirely: two failures for the price of one, the second with nothing in the
  // log to attribute it to.
  //
  // Still caught rather than propagated, because this function's callers are a
  // readiness probe, an unattended timer and token issuance, none of which may
  // see a throw. Counted separately so that swallowing it is not the same as
  // hiding it — the privacy policy promises this deletion too
  // (legal.retentionText) and this is the only code path that performs it.
  try {
    const orphans = await purgeOrphanedVerdicts(now);
    state.verdictLastSuccessAt = now;
    state.verdictFailures = 0;
    if (orphans > 0) console.info(`[retention] deleted ${orphans} unclaimed image verdict(s)`);
  } catch (error) {
    state.verdictFailures += 1;
    console.error("[retention] purge of unclaimed image verdicts failed:", error);
  }

  // Null when the token purge failed, as before: it is the caller-visible half
  // of this sweep, and a verdict failure must not turn a real token count into
  // one. `retentionStatus` is where both halves are answerable.
  return count;
}

/**
 * What an operator needs to tell a working sweep from a broken one. `SELECT 1`
 * succeeding says nothing about the DELETE: a role without delete rights, a
 * full disk, a lock, or a read-only SQLite mount all leave reads healthy while
 * expired personal data accumulates. The readiness endpoint reports this so
 * that failure is visible somewhere other than one line of stdout an hour.
 *
 * Covers both sweeps. The top-level `stale` is true when *either* is failing,
 * because the endpoint reports one boolean and an operator who sees it reads
 * the log line naming which; `verdicts` carries that detail for anything that
 * wants to answer the question directly. Deliberately not two fields in the
 * public probe body: the endpoint is unauthenticated, and one health bit says
 * all a probe needs to know.
 */
export function retentionStatus(now: number = Date.now()): {
  lastSuccessAt: number | null;
  failures: number;
  stale: boolean;
  verdicts: { lastSuccessAt: number | null; failures: number; stale: boolean };
} {
  const tokens = sweepHealth(state.lastSuccessAt, state.failures, now);
  const verdicts = sweepHealth(state.verdictLastSuccessAt, state.verdictFailures, now);

  return { ...tokens, stale: tokens.stale || verdicts.stale, verdicts };
}

function sweepHealth(
  lastSuccessAt: number | undefined,
  failures: number,
  now: number,
): { lastSuccessAt: number | null; failures: number; stale: boolean } {
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
