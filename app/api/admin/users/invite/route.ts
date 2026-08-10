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
  // account is, and a null `passwordHash` says it does not. The invariant that
  // makes that safe is the converse of the obvious one: plenty of code writes a
  // hash (register, the admin direct-create below this route, invite redemption,
  // scripts/create-user.mjs), but *nothing anywhere sets an existing hash back
  // to null*, and the create below is the only writer that stores null in the
  // first place. So a row with a hash always belongs to somebody who can log in
  // — hence the 409 — and a row without one is an invitation that was never
  // redeemed. Should a future password-reset ever clear a hash, this branch
  // becomes "mint a password-setting link for an active account", so the
  // invariant has to be re-checked before that lands.
  //
  // Three ways to end up here, not two: the invite mail failed to send, the
  // token expired before it was used, or — most often — the invitee simply has
  // not clicked yet and their link is still live. Re-inviting covers all three
  // and supersedes the old link in every case, which is why it is an explicit
  // action and not something that happens by itself.
  //
  // Such a row can never be used (lib/auth.ts rejects a falsy hash) and yet it
  // occupies the address globally, so the invitee's own attempt to register
  // answers 409 — or 403 on an invite-only instance — for an account they
  // neither created nor can reach. Re-inviting it is the way out; deleting the
  // row and starting over used to be the only one, and the UI only ever said so
  // on the failed-send path, in the error message below.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, role: true },
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

  // Resolving the locale is unrelated to delivery — keep it out of the catches
  // below so it cannot be reported as a failed invite.
  const locale = await resolveRequestLocale();

  // Supersede the previous link rather than adding a second one: an invite sets
  // a password, and two live ones in two mailboxes is the worse failure.
  //
  // Its own try, because its aftermath is the opposite of the one below. Nothing
  // has been sent yet, and the earlier link — quite possibly still valid — still
  // works, so reporting a delivery failure here would be false. Nor is "send it
  // again" reliably the recovery: a database role without delete rights (see
  // lib/tokens.ts) fails this way on every attempt, and that needs an operator,
  // not another click.
  let revoked = 0;
  if (reinvited) {
    try {
      revoked = await revokeTokens(user.id, "INVITE");
    } catch (error) {
      console.error(
        `[admin-invite] revoking the previous INVITE link of user ${user.id} failed; ` +
          `nothing was sent and the earlier link, if there was one, still works:`,
        error,
      );
      return NextResponse.json({ error: t("inviteRevokeFailed") }, { status: 500 });
    }
  }

  try {
    const token = await createToken(user.id, "INVITE");
    await sendInviteEmail(email, token, locale);
  } catch (error) {
    // A password-less row exists at this point either way — created just above,
    // or left behind by the earlier attempt — and it cannot log in. Sending
    // again is the recovery, which is what the message says; it used to have to
    // tell the admin to delete the row first. Letting the throw escape as a bare
    // 500 would say neither. The revoked count goes into the log because it is
    // what decides what the admin owes the invitee: past a successful revoke the
    // account has no working link at all, where before it may have had one.
    console.error(
      `[admin-invite] invite for user ${user.id} failed after revoking ${revoked} link(s), ` +
        `so the account has no valid invitation link now:`,
      error,
    );
    return NextResponse.json({ error: t("inviteEmailFailed") }, { status: 500 });
  }

  // Nothing else records that a live password-setting credential was destroyed,
  // or that a second invitation went out at all: consumeToken deliberately does
  // not log a refused claim, so an invitee reporting a dead link is otherwise
  // indistinguishable from an expired, purged or already-claimed one. The id
  // rather than the address, so the log stays free of personal data — the admin
  // list maps one to the other.
  console.info(
    `[admin-invite] ${reinvited ? "re-invited" : "invited"} user ${user.id}, ` +
      `${revoked} previous link(s) revoked`,
  );
  if (revoked > 1) {
    // Exactly the condition revokeTokens exists to end: more than one live
    // password-setting link, in more than one mailbox.
    console.warn(
      `[admin-invite] user ${user.id} held ${revoked} live INVITE links before this one`,
    );
  }
  if (existing?.role === "ADMIN") {
    // An INVITE link against an admin row sets an administrator's password. The
    // button is offered — an invited admin who never activated is exactly as
    // stuck as anyone else — but this is not something to do unnoticed.
    console.warn(`[admin-invite] user ${user.id} re-invited while holding role ADMIN`);
  }

  // 200 rather than 201 on the re-invite path: a link was sent, but nothing was
  // created. `reinvited` is what lets the admin UI say which of the two
  // happened: the invite form reaches this route too, and a typed-in address
  // gives the form no way of knowing whether it already had a row.
  return NextResponse.json({ ok: true, reinvited }, { status: reinvited ? 200 : 201 });
}
