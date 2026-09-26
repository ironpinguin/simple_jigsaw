// Redeeming a single-use link: the claim and the work it authorises in one
// transaction, and the answer to every way that can fail. Shared by the invite,
// verify and password-reset routes, which each used to carry their own copy.

import type { Prisma } from "./generated/prisma";
import { prisma } from "./db";
import { consumeToken, recordClaimFailure, type ClaimRefusal, type TokenClaim } from "./tokens";
import { isTransientTransactionError } from "./prisma-errors";
import type { TokenKind } from "./token-ttl";

/**
 * A refusal decided inside `work`. Thrown rather than returned so the claim
 * rolls back with it — the link survives a refusal an admin or the user can
 * still reverse (#50) — and handed back by `redeemToken` as a refused
 * `Redemption` rather than as an error.
 */
export class Refused<R extends string = string> extends Error {
  constructor(
    readonly reason: R,
    /** Whose redemption this was, once the claim has told us. For the log. */
    readonly userId?: string,
  ) {
    super(reason);
    this.name = "Refused";
  }
}

/**
 * The outcome of a redemption. `ok` means the transaction committed: the link
 * is spent and `work` ran exactly once. A refusal means nothing was committed —
 * the link is intact — though `work` may already have run, in part or in full,
 * before the rollback; anything it did outside the transaction's client stays
 * done.
 *
 * `unavailable` covers every failure a retry may fix — a claim that could not
 * run and a transaction that collided or timed out — so a caller answers it with
 * a 503, never by calling the link bad.
 */
export type Redemption<T, R extends string = never> =
  | { ok: true; userId: string; value: T }
  | { ok: false; reason: ClaimRefusal | R; userId?: string };

/**
 * Claim `token` and run `work` in the same transaction, so that the claim
 * commits only with the work it authorises. `work` gets the transaction's own
 * client and must do every write through it: a write on the module client
 * would commit by itself and survive the rollback.
 *
 * The only way a redeem route may claim a token — eslint.config.mjs forbids
 * importing `consumeToken` anywhere else — because calling it on the module
 * client spends the link before the work that could still fail (#50, #91).
 *
 * Errors that are neither a refusal nor transient are rethrown untouched, and
 * the link survives them. What they mean to the user is the caller's to say.
 *
 * The claim counters `tokenClaimStatus` reads are booked here, once each:
 * - a transaction that failed before the claim could run → `recordClaimFailure`;
 * - a claim that ran and refused → already booked by `consumeToken` itself;
 * - a collision after a successful claim → logged, not counted. The DELETE
 *   worked, so it says nothing about the redeem path; counting it would turn the
 *   probe amber on write conflicts in the caller's own `work`.
 */
export async function redeemToken<T, R extends string = never>(
  token: string,
  type: TokenKind,
  work: (tx: Prisma.TransactionClient, userId: string) => Promise<T>,
): Promise<Redemption<T, R>> {
  let claim: TokenClaim | undefined;
  try {
    return await prisma.$transaction(async (tx) => {
      claim = await consumeToken(token, type, tx);
      if (!claim.ok) throw new Refused(claim.reason);
      const value = await work(tx, claim.userId);
      return { ok: true as const, userId: claim.userId, value };
    });
  } catch (error) {
    if (error instanceof Refused) {
      return { ok: false, reason: error.reason as ClaimRefusal | R, userId: error.userId };
    }
    if (!isTransientTransactionError(error)) throw error;

    // Transient: nothing was spent and a retry may work. Which counter it
    // belongs to depends on how far the claim got. A claim that came back
    // refused never lands here: Prisma swallows the rollback's own error and
    // rethrows the callback's, which is the Refused handled above.
    if (!claim?.ok) {
      recordClaimFailure(type, error);
      return { ok: false, reason: "unavailable" };
    }
    console.error(
      `[tokens] the ${type} redemption for user ${claim.userId} collided after its claim ` +
        `and was rolled back; refusing it:`,
      error,
    );
    return { ok: false, reason: "unavailable", userId: claim.userId };
  }
}
