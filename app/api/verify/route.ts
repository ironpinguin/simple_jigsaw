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

  const claim = await consumeToken(parsed.data.token, "EMAIL_VERIFY");
  if (!claim.ok) {
    // A claim that could not be attempted is not a bad link: the row is still
    // there and a retry may work, so this answers 503 rather than telling the
    // holder their link has expired and sending them to re-register. It is also
    // the status an operator's monitoring already watches. See lib/tokens.ts.
    return claim.reason === "unavailable"
      ? NextResponse.json({ error: t("linkUnavailable") }, { status: 503 })
      : NextResponse.json({ error: t("verifyInvalid") }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: claim.userId },
    data: { emailVerified: new Date() },
  });

  return NextResponse.json({ ok: true });
}
