import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { consumeToken } from "@/lib/tokens";
import { checkEmailBanned } from "@/lib/moderation";
import { TERMS_VERSION } from "@/lib/legal";
import { InviteSchema, signupErrorKey } from "@/lib/signup";
import { getErrorT, resolveBrowserLocale } from "@/lib/i18n-server";

export async function POST(request: Request) {
  const t = await getErrorT();
  const parsed = InviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t(signupErrorKey(parsed.error.issues)) }, { status: 400 });
  }

  const claim = await consumeToken(parsed.data.token, "INVITE");
  if (!claim.ok) {
    // 503, not 400, when the claim could not be attempted: the invite is still
    // valid and the row is still there, so a retry may work — and this is the
    // one route where refusing wrongly means an account nobody but an admin can
    // rescue, because there is no self-service resend. See lib/tokens.ts.
    return claim.reason === "unavailable"
      ? NextResponse.json({ error: t("linkUnavailable") }, { status: 503 })
      : NextResponse.json({ error: t("inviteInvalid") }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: claim.userId } });
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
      // The invite went out in the admin's language, so the row still carries
      // the default. This request is the first one the invitee themselves makes
      // — the only signal of their language before something mails them without
      // being asked.
      //
      // Accept-Language only (resolveBrowserLocale), never NEXT_LOCALE: the
      // invitee arrived through a link whose `/de` prefix the *admin* chose, and
      // next-intl's middleware writes that prefix into the cookie on their first
      // page view. Reading it back would pin the admin's language on them
      // permanently — the exact failure this column exists to end.
      locale: await resolveBrowserLocale(),
      termsAcceptedAt: new Date(),
      termsVersion: TERMS_VERSION,
    },
  });

  return NextResponse.json({ ok: true });
}
