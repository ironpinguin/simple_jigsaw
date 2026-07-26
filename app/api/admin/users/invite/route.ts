import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/bans";
import { checkEmailBanned } from "@/lib/moderation";
import { createToken } from "@/lib/tokens";
import { sendInviteEmail } from "@/lib/mail";
import { getErrorT, localeFromCookie } from "@/lib/i18n-server";

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
  if (await prisma.user.findUnique({ where: { email } })) {
    return NextResponse.json({ error: t("emailTaken") }, { status: 409 });
  }

  const user = await prisma.user.create({
    data: { email, passwordHash: null, role: "USER", emailVerified: null },
    select: { id: true },
  });

  const token = await createToken(user.id, "INVITE");
  await sendInviteEmail(email, token, await localeFromCookie());

  return NextResponse.json({ ok: true }, { status: 201 });
}
