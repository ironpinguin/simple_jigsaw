import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { consumeToken } from "@/lib/tokens";
import { checkEmailBanned } from "@/lib/moderation";

const Schema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, "Passwort muss mindestens 8 Zeichen haben."),
});

export async function POST(request: Request) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." },
      { status: 400 },
    );
  }

  const result = await consumeToken(parsed.data.token, "INVITE");
  if (!result) {
    return NextResponse.json(
      { error: "Der Einladungslink ist ungültig oder abgelaufen." },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({ where: { id: result.userId } });
  if (!user) {
    return NextResponse.json({ error: "Konto nicht gefunden." }, { status: 404 });
  }
  if (await checkEmailBanned(user.email)) {
    return NextResponse.json({ error: "Diese E-Mail-Adresse ist gesperrt." }, { status: 403 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, emailVerified: new Date() },
  });

  return NextResponse.json({ ok: true });
}
