import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/bans";
import { checkEmailBanned } from "@/lib/moderation";
import { isAdminEmail } from "@/lib/admin-emails";
import { createToken } from "@/lib/tokens";
import { sendVerificationEmail } from "@/lib/mail";
import { isRegistrationEnabled } from "@/lib/registration";
import { TERMS_VERSION } from "@/lib/legal";
import { RegisterSchema, signupErrorKey } from "@/lib/signup";
import { getErrorT, resolveRequestLocale } from "@/lib/i18n-server";

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
    return NextResponse.json({ error: t(signupErrorKey(parsed.error.issues)) }, { status: 400 });
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
      termsAcceptedAt: new Date(),
      termsVersion: TERMS_VERSION,
    },
    select: { id: true },
  });

  try {
    const token = await createToken(user.id, "EMAIL_VERIFY");
    await sendVerificationEmail(email, token, await resolveRequestLocale());
  } catch (error) {
    // The account already exists here — a retry only yields the 409. Say what
    // actually happened instead of an opaque 500, and leave a server-side
    // trace, or an operator has nothing to debug a "mail never arrived" with.
    console.error(`[register] verification email for user ${user.id} failed:`, error);
    return NextResponse.json({ error: t("verificationEmailFailed") }, { status: 500 });
  }

  return NextResponse.json({ ok: true, requiresVerification: true }, { status: 201 });
}
