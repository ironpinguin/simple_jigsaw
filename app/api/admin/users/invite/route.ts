import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/bans";
import { checkEmailBanned } from "@/lib/moderation";
import { createToken, revokeTokens } from "@/lib/tokens";
import { sendInviteEmail } from "@/lib/mail";
import { getErrorT, resolveRequestLocale } from "@/lib/i18n-server";

const Schema = z.object({ email: z.string().email() });

// Invite: create a password-less account and email a link to set the password.
export async function POST(request: Request) {
  const t = await getErrorT();

  if (!(await requireAdmin())) {
    return NextResponse.json({ error: t("noAccess") }, { status: 403 });
  }

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t("invalidEmail") }, { status: 400 });
  }

  const email = normalizeEmail(parsed.data.email);
  if (await checkEmailBanned(email)) {
    return NextResponse.json({ error: t("emailBanned") }, { status: 403 });
  }
  // The existence of a row is not the question — whether it belongs to a usable
  // account is. `passwordHash` is set only by app/api/invite/route.ts, when the
  // invitee actually redeems their link, so a null hash is a reliable "this
  // invite never completed": the mail failed to send, or the token expired
  // first. Such a row can never be used (auth rejects a null hash) and yet it
  // occupies the address globally, so that the invitee's own attempt to register
  // answers 409 for an account they neither created nor can reach. Re-inviting
  // it is the way out; deleting the row and starting over used to be the only
  // one, and nothing in the UI said so.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true },
  });
  if (existing && existing.passwordHash !== null) {
    return NextResponse.json({ error: t("emailTaken") }, { status: 409 });
  }

  const reinvited = existing !== null;
  const user =
    existing ??
    (await prisma.user.create({
      data: { email, passwordHash: null, role: "USER", emailVerified: null },
      select: { id: true },
    }));

  // Resolving the locale is unrelated to delivery — keep it out of the catch
  // below so it cannot be reported as a failed invite.
  const locale = await resolveRequestLocale();

  try {
    // Supersede the previous link rather than adding a second one: an invite
    // sets a password, and two live ones in two mailboxes is the worse failure.
    if (reinvited) await revokeTokens(user.id, "INVITE");
    const token = await createToken(user.id, "INVITE");
    await sendInviteEmail(email, token, locale);
  } catch (error) {
    // A password-less row exists at this point either way — created just above,
    // or left behind by the earlier attempt — and it cannot log in. Sending
    // again is now the recovery, which is what the message says; it used to have
    // to tell the admin to delete the row first. Letting the throw escape as a
    // bare 500 would say neither. Any of the revoke, the token write or the send
    // lands here, so the log names the invite and the error says which.
    console.error(`[admin-invite] invite for user ${user.id} failed:`, error);
    return NextResponse.json({ error: t("inviteEmailFailed") }, { status: 500 });
  }

  // 200 rather than 201 on the re-invite path: a link was sent, but nothing was
  // created. `reinvited` is what lets the admin UI say which of the two happened
  // — the invite form reaches this route too, so it cannot tell from the button
  // the admin pressed.
  return NextResponse.json({ ok: true, reinvited }, { status: reinvited ? 200 : 201 });
}
