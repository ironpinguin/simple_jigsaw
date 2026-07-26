import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { consumeToken } from "@/lib/tokens";
import { checkEmailBanned } from "@/lib/moderation";
import { getErrorT } from "@/lib/i18n-server";

const Schema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export async function POST(request: Request) {
  const t = await getErrorT();
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const onPassword = parsed.error.issues.some((i) => i.path.includes("password"));
    return NextResponse.json(
      { error: onPassword ? t("passwordMin") : t("invalidInput") },
      { status: 400 },
    );
  }

  const result = await consumeToken(parsed.data.token, "INVITE");
  if (!result) {
    return NextResponse.json({ error: t("inviteInvalid") }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: result.userId } });
  if (!user) {
    return NextResponse.json({ error: t("accountNotFound") }, { status: 404 });
  }
  if (await checkEmailBanned(user.email)) {
    return NextResponse.json({ error: t("emailBanned") }, { status: 403 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, emailVerified: new Date() },
  });

  return NextResponse.json({ ok: true });
}
