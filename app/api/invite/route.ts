import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { consumeToken, type ClaimRefusal } from "@/lib/tokens";
import { checkEmailBanned } from "@/lib/moderation";
import { TERMS_VERSION } from "@/lib/legal";
import { InviteSchema, signupErrorKey } from "@/lib/signup";
import { getErrorT, resolveBrowserLocale } from "@/lib/i18n-server";

/** Why an activation was refused, beyond the two a claim itself can report. */
type InviteRefusal = ClaimRefusal | "accountNotFound" | "emailBanned";

/**
 * A refusal decided inside the transaction. Thrown rather than returned so the
 * claim rolls back with it — the route's answer is chosen from it afterwards.
 * Without this an invitation died on a moderation decision that an admin can
 * reverse, while the link it killed stayed dead (#50).
 */
class Refused extends Error {
  constructor(
    readonly reason: InviteRefusal,
    /** Whose activation this was, once the claim has told us. For the log. */
    readonly userId?: string,
  ) {
    super(reason);
  }
}

export async function POST(request: Request) {
  const t = await getErrorT();
  const parsed = InviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t(signupErrorKey(parsed.error.issues)) }, { status: 400 });
  }

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
  try {
    await prisma.$transaction(async (tx) => {
      const claim = await consumeToken(parsed.data.token, "INVITE", tx);
      if (!claim.ok) throw new Refused(claim.reason);

      const user = await tx.user.findUnique({ where: { id: claim.userId } });
      if (!user) throw new Refused("accountNotFound", claim.userId);
      if (await checkEmailBanned(user.email, tx)) throw new Refused("emailBanned", user.id);

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
    });
  } catch (error) {
    // Anything else — a failed write, a lock timeout — is a 500 the way it
    // always was. What changed is that the invitation survives it.
    if (!(error instanceof Refused)) throw error;

    switch (error.reason) {
      // 503, not 400, when the claim could not be attempted: the invite is still
      // valid and the row is still there, so a retry may work — and this is the
      // one route where refusing wrongly means an account nobody but an admin
      // can rescue, because there is no self-service resend. See lib/tokens.ts.
      case "unavailable":
        return NextResponse.json({ error: t("linkUnavailable") }, { status: 503 });
      case "invalid":
        return NextResponse.json({ error: t("inviteInvalid") }, { status: 400 });
      // The two moderation refusals are the ones nothing else records. A silent
      // early return here is how "my invite does not work" becomes unanswerable:
      // an operator sees a 404 or a 403 in an access log and nothing that names
      // the account. The id, never the address — this lands in a log for someone
      // who may since have asked to be erased.
      case "accountNotFound":
        console.warn(`[invite] user ${error.userId} activated an invite but no longer exists`);
        return NextResponse.json({ error: t("accountNotFound") }, { status: 404 });
      case "emailBanned":
        console.warn(`[invite] user ${error.userId} activated an invite from a banned address`);
        return NextResponse.json({ error: t("emailBanned") }, { status: 403 });
      // The success response sits directly after this switch, so falling out of
      // it would report an activation that never happened. A reason added to
      // InviteRefusal and not to this switch fails the build here, and anything
      // that still reaches it at runtime becomes a 500 rather than an `ok`.
      default: {
        const unhandled: never = error.reason;
        throw new Error(`[invite] unhandled refusal ${String(unhandled)}`);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
