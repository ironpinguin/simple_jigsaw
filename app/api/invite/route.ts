import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import type { ClaimRefusal } from "@/lib/tokens";
import { Refused, redeemToken } from "@/lib/token-redeem";
import { checkEmailBanned } from "@/lib/moderation";
import { TERMS_VERSION } from "@/lib/legal";
import { InviteSchema, signupErrorKey } from "@/lib/signup";
import { getErrorT, resolveBrowserLocale } from "@/lib/i18n-server";

/** Why an activation was refused, beyond the two a claim itself can report. */
type InviteRefusal = ClaimRefusal | "accountNotFound" | "emailBanned";

/**
 * The answer to a moderation refusal, and the log line that goes with it.
 * Shared by the cheap pre-check and the authoritative one inside the
 * transaction so the two cannot drift into answering differently.
 *
 * These two are the refusals nothing else records. A silent early return here
 * is how "my invite does not work" becomes unanswerable: an operator sees a 404
 * or a 403 in an access log and nothing that names the account. The id, never
 * the address — this lands in a log for someone who may since have asked to be
 * erased.
 */
function refuse(
  t: (key: string) => string,
  reason: "accountNotFound" | "emailBanned",
  userId?: string,
): NextResponse {
  if (reason === "accountNotFound") {
    console.warn(`[invite] user ${userId ?? "?"} activated an invite but no longer exists`);
    return NextResponse.json({ error: t("accountNotFound") }, { status: 404 });
  }
  console.warn(`[invite] user ${userId ?? "?"} activated an invite from a banned address`);
  return NextResponse.json({ error: t("emailBanned") }, { status: 403 });
}

export async function POST(request: Request) {
  const t = await getErrorT();
  const parsed = InviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t(signupErrorKey(parsed.error.issues)) }, { status: 400 });
  }

  // Cheap indexed reads before the expensive part, the way api/register orders
  // the same two steps. This route is unauthenticated, outside the proxy's
  // matcher and unthrottled, and the refusals below no longer spend the token —
  // so the holder of an invitation that cannot currently be used can replay it
  // for the rest of its TTL. Deciding after the hash would hand them ~100ms of
  // CPU and an interactive write transaction every time; on the SQLite stack
  // that transaction serialises against every other writer.
  //
  // A filter, not the decision: the authoritative single-use delete and the
  // checks that go with it are still the ones inside the transaction, so
  // nothing here can be raced into an activation — only into wasted work.
  const known = await prisma.verificationToken.findFirst({
    where: {
      token: parsed.data.token,
      type: "INVITE",
      // An expired row survives its click — the claim's delete rolls back with
      // the refusal (lib/tokens.ts) — so without this one expired invite could
      // be replayed for a bcrypt round and a write transaction each time until
      // the retention sweep takes it. `gte` because isExpired refuses only `<`:
      // the same boundary the claim and the sweep draw.
      expiresAt: { gte: new Date() },
    },
    select: { user: { select: { id: true, email: true } } },
  });
  if (!known) {
    return NextResponse.json({ error: t("inviteInvalid") }, { status: 400 });
  }
  if (!known.user) return refuse(t, "accountNotFound");
  if (await checkEmailBanned(known.user.email)) return refuse(t, "emailBanned", known.user.id);

  // Both before the transaction, and deliberately so. bcrypt at cost 10 is
  // ~100ms of CPU: inside, it would hold a write lock for that long — on SQLite,
  // against every other writer — for work that needs no database at all.
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  // The invite went out in the admin's language, so the row still carries the
  // default. This request is the first one the invitee themselves makes — the
  // only signal of their language before something mails them without being
  // asked.
  //
  // Accept-Language only (resolveBrowserLocale), never NEXT_LOCALE: the invitee
  // arrived through a link whose `/de` prefix the *admin* chose, and next-intl's
  // handler writes that prefix into the cookie on their first page view. Reading
  // it back would pin the admin's language on them permanently — the exact
  // failure this column exists to end.
  const locale = await resolveBrowserLocale();

  // Everything that can refuse the activation runs inside one transaction, so
  // that none of it spends the invitation. The claim is irreversible on its own
  // and lands before the work it authorises: a deleted account, a ban, or a
  // write that threw each used to leave the invitee unactivated with a dead
  // link, and INVITE is minted only by an admin (no self-service resend), so
  // only an operator could rescue them.
  //
  // A transaction that never started, collided or ran out its deadline comes
  // back as `unavailable`, like a claim that could not run: nothing was spent
  // and a retry may work. Anything else — a failed write, a bug in here — is a
  // 500, and the invitation survives it.
  const redeemed = await redeemToken<void, InviteRefusal>(
    parsed.data.token,
    "INVITE",
    async (tx, userId) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Refused<InviteRefusal>("accountNotFound", userId);
      if (await checkEmailBanned(user.email, tx)) {
        throw new Refused<InviteRefusal>("emailBanned", user.id);
      }

      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          emailVerified: new Date(),
          locale,
          termsAcceptedAt: new Date(),
          termsVersion: TERMS_VERSION,
        },
      });
    },
  );

  if (!redeemed.ok) {
    switch (redeemed.reason) {
      // 503, not 400, when the claim could not be attempted: the invite is still
      // valid and the row is still there, so a retry may work — and this is the
      // one route where refusing wrongly means an account nobody but an admin
      // can rescue, because there is no self-service resend. See lib/tokens.ts.
      case "unavailable":
        return NextResponse.json({ error: t("linkUnavailable") }, { status: 503 });
      case "invalid":
        return NextResponse.json({ error: t("inviteInvalid") }, { status: 400 });
      // Reached only when the state changed under the pre-check above — a ban
      // or a deletion that landed in the gap. Same answer, and the claim rolls
      // back with it.
      case "accountNotFound":
      case "emailBanned":
        return refuse(t, redeemed.reason, redeemed.userId);
      // The success response sits directly after this switch, so falling out of
      // it would report an activation that never happened. A reason added to
      // InviteRefusal and not to this switch fails the build here, and anything
      // that still reaches it at runtime becomes a 500 rather than an `ok`.
      default: {
        const unhandled: never = redeemed.reason;
        throw new Error(`[invite] unhandled refusal ${String(unhandled)}`);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
