import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { passwordErrorKey, passwordField } from "@/lib/password";
import { getErrorT } from "@/lib/i18n-server";
import { revokeTokens } from "@/lib/tokens";

const Schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordField,
});

// Change the password of the logged-in user. Re-authenticates first: the
// session cookie alone must not be enough, exactly as for account deletion
// (app/api/account/route.ts).
export async function PUT(request: Request) {
  const t = await getErrorT();

  // auth() rather than getSessionUser(), which is the usual idiom here: it
  // selects no passwordHash, so this route would read the same row twice —
  // three times counting the lookup the jwt callback already made.
  const session = await auth();
  const id = session?.user?.id;
  if (!id) {
    return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });
  }

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // Only a new password of the wrong length means anything to the user;
    // a missing or non-string field is a malformed client and says so.
    const key = passwordErrorKey(parsed.error.issues, "newPassword");
    return NextResponse.json({ error: t(key ?? "invalidRequest") }, { status: 400 });
  }

  // Confirms the session's user still exists, which getSessionUser would
  // otherwise have done, and fetches the hash to re-authenticate against.
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, passwordHash: true },
  });

  // The null check stays in the condition because bcrypt.compare against a null
  // hash throws. Such a row cannot hold a session at all (lib/auth.ts rejects it
  // at login), so it needs no answer of its own.
  if (
    !user?.passwordHash ||
    !(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))
  ) {
    return NextResponse.json({ error: t("wrongPassword") }, { status: 401 });
  }

  // One write: the hash and the stamp that invalidates every session issued
  // before it must not be able to disagree. termsAcceptedAt and termsVersion
  // are deliberately absent — a password change is not a new consent.
  //
  // The stamp is read here, before the row commits, so sessions resolved
  // during the write could still slip past it; SESSION_CUTOFF_MARGIN_MS in
  // lib/session-freshness.ts is what covers that window. Keeping the column
  // itself honest is why the margin lives in the comparison and not here.
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, passwordChangedAt: new Date() },
  });

  // A reset mail still sitting in an inbox is a second key. Changing the
  // password deliberately answers whatever prompted it, so the link goes.
  // After the update, not before: a failed write must not disarm a link the
  // user may still need.
  //
  // Swallowed rather than reported: the update above already succeeded and
  // the caller's own session is already invalid because of the stamp it just
  // wrote, so a 500 here would tell the user the opposite of what happened —
  // ChangePassword.tsx shows a generic failure and does not sign them out,
  // so they would retry with the old password, be told that is wrong too,
  // and then get signed out anyway on their next request. The cost of
  // swallowing it is a surviving reset link, live for up to its two-hour
  // TTL — the reason this is logged rather than ignored.
  try {
    await revokeTokens(user.id, "PASSWORD_RESET");
  } catch (error) {
    console.error(
      `[account-password] revoking PASSWORD_RESET links for user ${user.id} failed after ` +
        `the password was already changed; a reset link may still work for up to its TTL:`,
      error,
    );
  }

  return NextResponse.json({ ok: true });
}
