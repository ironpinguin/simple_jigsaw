import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { passwordField } from "@/lib/password";
import { getErrorT } from "@/lib/i18n-server";

const Schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordField,
});

// Change the password of the logged-in user. Re-authenticates first: the
// session cookie alone must not be enough, exactly as for account deletion
// (app/api/account/route.ts).
export async function PUT(request: Request) {
  const t = await getErrorT();

  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });
  }

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // The only rule that can fail here and mean something to the user is the
    // length of the new password; anything else is a malformed client.
    const onNew = parsed.error.issues.some((i) => i.path.includes("newPassword"));
    return NextResponse.json(
      { error: t(onNew ? "passwordMin" : "invalidRequest") },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: session.id },
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
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 10), passwordChangedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
