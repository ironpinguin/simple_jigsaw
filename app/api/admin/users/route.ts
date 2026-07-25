import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/bans";
import { checkEmailBanned } from "@/lib/moderation";

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Kein Zugriff." }, { status: 403 });
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      emailVerified: true,
      passwordHash: true,
      createdAt: true,
    },
  });

  // Never leak the hash; expose a boolean instead.
  const safe = users.map(({ passwordHash, emailVerified, ...u }) => ({
    ...u,
    verified: emailVerified !== null,
    hasPassword: passwordHash !== null,
  }));
  return NextResponse.json({ users: safe });
}

const CreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Passwort muss mindestens 8 Zeichen haben."),
  role: z.enum(["USER", "ADMIN"]).optional(),
});

// Direct create: admin sets an initial password; the account is active & verified.
export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Kein Zugriff." }, { status: 403 });
  }

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." },
      { status: 400 },
    );
  }

  const email = normalizeEmail(parsed.data.email);
  if (await checkEmailBanned(email)) {
    return NextResponse.json({ error: "Diese E-Mail-Adresse ist gesperrt." }, { status: 403 });
  }
  if (await prisma.user.findUnique({ where: { email } })) {
    return NextResponse.json({ error: "Diese E-Mail ist bereits vergeben." }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: parsed.data.role ?? "USER",
      emailVerified: new Date(),
    },
    select: { id: true },
  });

  return NextResponse.json({ id: user.id }, { status: 201 });
}
