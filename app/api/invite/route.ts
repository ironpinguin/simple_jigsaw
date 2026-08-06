import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { consumeToken } from "@/lib/tokens";
import { checkEmailBanned } from "@/lib/moderation";
import { TERMS_VERSION } from "@/lib/legal";
import { InviteSchema, signupErrorKey } from "@/lib/signup";
import { getErrorT } from "@/lib/i18n-server";

export async function POST(request: Request) {
  const t = await getErrorT();
  const parsed = InviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t(signupErrorKey(parsed.error.issues)) }, { status: 400 });
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
    data: {
      passwordHash,
      emailVerified: new Date(),
      termsAcceptedAt: new Date(),
      termsVersion: TERMS_VERSION,
    },
  });

  return NextResponse.json({ ok: true });
}
