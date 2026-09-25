import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { consumeToken, recordClaimFailure, revokeTokens, type ClaimRefusal } from "@/lib/tokens";
import { isTransientTransactionError } from "@/lib/prisma-errors";
import { passwordErrorKey, passwordField } from "@/lib/password";
import { getErrorT } from "@/lib/i18n-server";

const Schema = z.object({ token: z.string().min(1), password: passwordField });

/**
 * A refusal decided inside the transaction. Thrown rather than returned so the
 * claim rolls back with it — the route's answer is chosen from it afterwards.
 */
class Refused extends Error {
  constructor(readonly reason: ClaimRefusal) {
    super(reason);
  }
}

export async function POST(request: Request) {
  const t = await getErrorT();

  // Validated before the token is spent: a rejected password must not burn a
  // single-use link and leave the user to request another.
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // passwordErrorKey decides which length message applies, so this endpoint
    // reports the rule the same way the other three writers do: a passphrase
    // over bcrypt's 72-byte limit hears passwordMax, not "at least 8
    // characters". It returns null for a missing or non-string password —
    // a malformed client, not a length the user can fix.
    const passwordKey = passwordErrorKey(parsed.error.issues, "password");
    return NextResponse.json(
      { error: t(passwordKey ?? "invalidRequest") },
      { status: 400 },
    );
  }

  // A cheap indexed read before the expensive part, the way app/api/invite
  // orders the same steps. The hash has to happen before the transaction (see
  // below), so without this filter every garbage token on this unauthenticated
  // endpoint would buy ~100ms of bcrypt. Not the decision: the single-use claim
  // inside the transaction is, so nothing here can be raced into a reset.
  const known = await prisma.verificationToken.findFirst({
    where: { token: parsed.data.token, type: "PASSWORD_RESET" },
    select: { id: true },
  });
  if (!known) {
    return NextResponse.json({ error: t("resetInvalid") }, { status: 400 });
  }

  // Before the transaction, and deliberately so: bcrypt at cost 10 is ~100ms of
  // CPU that needs no database, and inside it would hold a write lock that
  // long — on SQLite, against every other writer.
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);

  // Claim and write in one transaction (#91), as the invite and verify routes
  // have since #50. The claim is irreversible on its own and lands before the
  // work it authorises, so a write that threw here used to leave the password
  // unchanged and the link spent. Rolling back hands the link back instead.
  let userId: string;
  try {
    userId = await prisma.$transaction(async (tx) => {
      const claim = await consumeToken(parsed.data.token, "PASSWORD_RESET", tx);
      if (!claim.ok) throw new Refused(claim.reason);

      // Read for emailVerified alone, and only to leave an existing one alone.
      // Setting it matters for the account that never confirmed — lib/auth.ts
      // refuses a falsy emailVerified at sign-in, so without this a reset would
      // hand that user a working password and no way to use it — but it is a
      // record of when the address was confirmed, not a last-seen stamp:
      // lib/account-export.ts publishes it as a date, and the privacy copy
      // promises it says when you confirmed your address. Writing it
      // unconditionally would restate a 2024 confirmation as today for
      // everybody who ever resets, in their own Art. 15 export. A row that
      // vanished between the claim and here reads as null and the update below
      // throws P2025, which rolls the claim back like any other failed write.
      const account = await tx.user.findUnique({
        where: { id: claim.userId },
        select: { emailVerified: true },
      });

      // Stamped after the hash, never before it: read ahead of the bcrypt
      // round, passwordChangedAt would be dated a whole hash — 60-150 ms —
      // before the write is even issued. lib/session-freshness.ts gives
      // SESSION_CUTOFF_MARGIN_MS 1000 ms to cover the stamp plus a healthy
      // write and re-issue together. Same order as the deliberate
      // hash-then-stamp in app/api/account/password/route.ts.
      const now = new Date();
      await tx.user.update({
        where: { id: claim.userId },
        data: {
          passwordHash,
          // Ends every other session: the jwt callback refuses any token
          // issued at or before this second (lib/auth.ts).
          passwordChangedAt: now,
          // Clicking a link sent to the address proves what the confirmation
          // mail asks, so a reset doubles as verification — for an address
          // that has not been confirmed yet. An earlier confirmation stands.
          emailVerified: account?.emailVerified ?? now,
        },
      });
      return claim.userId;
    });
  } catch (error) {
    // A transaction that never started, or that ran out its deadline, throws
    // here rather than inside the claim, and means what a failed claim means:
    // nothing was spent and a retry may work.
    if (isTransientTransactionError(error)) {
      recordClaimFailure("PASSWORD_RESET", error);
      return NextResponse.json({ error: t("linkUnavailable") }, { status: 503 });
    }
    if (error instanceof Refused) {
      // "unavailable" means the store could not be read, not that the link is
      // bad — telling the user their valid link is invalid would send them
      // round the request loop for nothing. See lib/tokens.ts.
      return error.reason === "unavailable"
        ? NextResponse.json({ error: t("linkUnavailable") }, { status: 503 })
        : NextResponse.json({ error: t("resetInvalid") }, { status: 400 });
    }
    // The write failed and the claim rolled back with it, so the link still
    // works. Letting this throw would answer with the generic 500 the page
    // renders as auth.resetFailed, "the link may have expired" — the one
    // explanation that is certainly wrong. Say what happened instead, and log
    // it, because nothing else records why the write failed.
    console.error(
      "[account-password-reset] setting a new password failed; the link was not spent:",
      error,
    );
    return NextResponse.json({ error: t("resetNotApplied") }, { status: 503 });
  }

  // Other PASSWORD_RESET links can still be live for this account — the
  // per-address rule in the request route allows a handful an hour, and a reset
  // mail still sitting in an inbox is a second key. Completing this one answers
  // the same question the others were sent for just as deliberately as changing
  // the password from inside the account does
  // (app/api/account/password/route.ts), so it revokes for the same reason.
  // After the update, not before: a failed write must not disarm links the user
  // may still need.
  //
  // Swallowed rather than reported: the password has already been reset
  // above, so a 500 here would tell the user the opposite of what happened.
  // The cost of swallowing it is the other links surviving for up to their
  // two-hour TTL — the reason this is logged rather than ignored. Unlike the
  // request route's rate limiter, this cannot be ground down by an attacker:
  // reaching this point already required clicking a mailed link, which
  // implies the mailbox access the limiter exists to approximate.
  try {
    await revokeTokens(userId, "PASSWORD_RESET");
  } catch (error) {
    console.error(
      `[account-password-reset] revoking other PASSWORD_RESET links for user ${userId} failed ` +
        `after the password was already reset; another link may still work for up to its TTL:`,
      error,
    );
  }

  return NextResponse.json({ ok: true });
}
