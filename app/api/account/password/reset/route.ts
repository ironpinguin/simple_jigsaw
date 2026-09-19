import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { consumeToken, revokeTokens } from "@/lib/tokens";
import { passwordErrorKey, passwordField } from "@/lib/password";
import { getErrorT } from "@/lib/i18n-server";

const Schema = z.object({ token: z.string().min(1), password: passwordField });

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

  const claim = await consumeToken(parsed.data.token, "PASSWORD_RESET");
  if (!claim.ok) {
    // "unavailable" means the store could not be read, not that the link is
    // bad — telling the user their valid link is invalid would send them round
    // the request loop for nothing. Mirrors app/api/invite/route.ts.
    return claim.reason === "unavailable"
      ? NextResponse.json({ error: t("linkUnavailable") }, { status: 503 })
      : NextResponse.json({ error: t("resetInvalid") }, { status: 400 });
  }

  try {
    // Read for emailVerified alone, and only to leave an existing one alone.
    // Setting it matters for the account that never confirmed — lib/auth.ts
    // refuses a falsy emailVerified at sign-in, so without this a reset would
    // hand that user a working password and no way to use it — but it is a
    // record of when the address was confirmed, not a last-seen stamp:
    // lib/account-export.ts publishes it as a date, and the privacy copy
    // promises it says when you confirmed your address. Writing it
    // unconditionally would restate a 2024 confirmation as today for everybody
    // who ever resets, in their own Art. 15 export. A row that vanished between
    // the claim and here reads as null and the update below throws P2025, which
    // the catch already answers.
    const account = await prisma.user.findUnique({
      where: { id: claim.userId },
      select: { emailVerified: true },
    });

    // Hash first, stamp second. Read before the bcrypt round instead, the way
    // an inline `await bcrypt.hash(...)` next to a hoisted `now` reads it, and
    // passwordChangedAt would be dated a whole hash — 60-150 ms — before the
    // write is even issued. lib/session-freshness.ts gives
    // SESSION_CUTOFF_MARGIN_MS 1000 ms to cover the stamp plus a healthy write
    // and re-issue together, so that is a tenth of the budget spent before the
    // window it exists for has even started. Same shape as the deliberate
    // hash-then-stamp order in app/api/account/password/route.ts.
    const passwordHash = await bcrypt.hash(parsed.data.password, 10);
    const now = new Date();
    await prisma.user.update({
      where: { id: claim.userId },
      data: {
        passwordHash,
        // Ends every other session: the jwt callback refuses any token issued
        // at or before this second (lib/auth.ts).
        passwordChangedAt: now,
        // Clicking a link sent to the address proves what the confirmation
        // mail asks, so a reset doubles as verification — for an address that
        // has not been confirmed yet. An earlier confirmation stands.
        emailVerified: account?.emailVerified ?? now,
      },
    });
  } catch (error) {
    // consumeToken has already deleted the row, so the link is spent whether or
    // not this write lands — a store that went away between the two statements,
    // or P2025 for an account deleted in the gap, which
    // app/api/invite/route.ts guards ahead of its own write. Letting it throw
    // answers with the generic 500 the page renders as auth.resetFailed, "the
    // link may have expired": the one explanation that is certainly wrong, and
    // it sends the user back to a link that no longer exists. Say what actually
    // happened instead — and log it, because nothing else records why the write
    // failed. The hash sits inside the try for the same reason: bcrypt throwing
    // spends the link just as thoroughly as the update throwing does.
    console.error(
      `[account-password-reset] setting the new password for user ${claim.userId} failed after ` +
        `the link was already spent; the user has to request a new one:`,
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
    await revokeTokens(claim.userId, "PASSWORD_RESET");
  } catch (error) {
    console.error(
      `[account-password-reset] revoking other PASSWORD_RESET links for user ${claim.userId} failed ` +
        `after the password was already reset; another link may still work for up to its TTL:`,
      error,
    );
  }

  return NextResponse.json({ ok: true });
}
