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

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Passwort muss mindestens 8 Zeichen haben."),
  name: z.string().trim().max(80).optional(),
});

export async function POST(request: Request) {
  if (!isRegistrationEnabled()) {
    return NextResponse.json({ error: "Registrierung ist deaktiviert." }, { status: 403 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Ungültige Anfrage." }, { status: 400 });
  }

  const parsed = RegisterSchema.safeParse(json);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Ungültige Eingabe.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const email = normalizeEmail(parsed.data.email);

  if (await checkEmailBanned(email)) {
    return NextResponse.json(
      { error: "Diese E-Mail-Adresse ist gesperrt." },
      { status: 403 },
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "Diese E-Mail ist bereits registriert." },
      { status: 409 },
    );
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
  await sendVerificationEmail(email, token);

  return NextResponse.json({ ok: true, requiresVerification: true }, { status: 201 });
}
