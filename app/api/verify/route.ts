import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { consumeToken } from "@/lib/tokens";
import { getErrorT } from "@/lib/i18n-server";

const Schema = z.object({ token: z.string().min(1) });

export async function POST(request: Request) {
  const t = await getErrorT();
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t("invalidRequest") }, { status: 400 });
  }

  const result = await consumeToken(parsed.data.token, "EMAIL_VERIFY");
  if (!result) {
    return NextResponse.json({ error: t("verifyInvalid") }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: result.userId },
    data: { emailVerified: new Date() },
  });

  return NextResponse.json({ ok: true });
}
