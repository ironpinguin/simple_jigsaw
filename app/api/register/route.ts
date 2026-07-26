import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/bans";
import { checkEmailBanned } from "@/lib/moderation";
import { isAdminEmail } from "@/lib/admin-emails";
import { createToken } from "@/lib/tokens";
import { sendVerificationEmail } from "@/lib/mail";
import { isRegistrationEnabled } from "@/lib/registration";
import { getErrorT, localeFromCookie } from "@/lib/i18n-server";

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().trim().max(80).optional(),
});

export async function POST(request: Request) {
  const t = await getErrorT();

  if (!isRegistrationEnabled()) {
    return NextResponse.json({ error: t("registrationDisabled") }, { status: 403 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: t("invalidRequest") }, { status: 400 });
  }

  const parsed = RegisterSchema.safeParse(json);
  if (!parsed.success) {
    const onPassword = parsed.error.issues.some((i) => i.path.includes("password"));
    return NextResponse.json(
      { error: onPassword ? t("passwordMin") : t("invalidInput") },
      { status: 400 },
    );
  }

  const email = normalizeEmail(parsed.data.email);

  if (await checkEmailBanned(email)) {
    return NextResponse.json({ error: t("emailBanned") }, { status: 403 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: t("emailRegistered") }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: parsed.data.name || null,
      role: isAdminEmail(email) ? "ADMIN" : "USER",
      emailVerified: null,
    },
    select: { id: true },
  });

  const token = await createToken(user.id, "EMAIL_VERIFY");
  await sendVerificationEmail(email, token, await localeFromCookie());

  return NextResponse.json({ ok: true, requiresVerification: true }, { status: 201 });
}
