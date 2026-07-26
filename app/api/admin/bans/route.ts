import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeBanValue } from "@/lib/bans";
import { getErrorT } from "@/lib/i18n-server";

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: (await getErrorT())("noAccess") }, { status: 403 });
  }
  const bans = await prisma.bannedEmail.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json({ bans });
}

const Schema = z.object({
  value: z.string().trim().min(3),
  type: z.enum(["EMAIL", "DOMAIN"]),
});

export async function POST(request: Request) {
  const t = await getErrorT();
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: t("noAccess") }, { status: 403 });
  }
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t("invalidInput") }, { status: 400 });
  }

  const value = normalizeBanValue(parsed.data.value, parsed.data.type);
  const looksValid =
    parsed.data.type === "EMAIL" ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) : /\./.test(value);
  if (!looksValid) {
    return NextResponse.json(
      { error: parsed.data.type === "EMAIL" ? t("invalidEmail") : t("invalidDomain") },
      { status: 400 },
    );
  }

  if (await prisma.bannedEmail.findUnique({ where: { value } })) {
    return NextResponse.json({ error: t("alreadyBanned") }, { status: 409 });
  }

  const ban = await prisma.bannedEmail.create({
    data: { value, type: parsed.data.type },
  });
  return NextResponse.json({ ban }, { status: 201 });
}
