import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { consumeToken } from "@/lib/tokens";
import { passwordField } from "@/lib/password";
import { getErrorT } from "@/lib/i18n-server";

const Schema = z.object({ token: z.string().min(1), password: passwordField });

export async function POST(request: Request) {
  const t = await getErrorT();

  // Validated before the token is spent: a too-short password must not burn a
  // single-use link and leave the user to request another.
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const onPassword = parsed.error.issues.some((i) => i.path.includes("password"));
    return NextResponse.json(
      { error: t(onPassword ? "passwordMin" : "invalidRequest") },
      { status: 400 },
    );
  }

  const claim = await consumeToken(parsed.data.token, "PASSWORD_RESET");
  if (!claim.ok) {
    // "unavailable" means the store could not be read, not that the link is
    // bad — telling the user their valid link is invalid would send them round
    // the request loop for nothing. Mirrors app/api/invite/route.ts.
    return claim.reason === "unavailable"
      ? NextResponse.json({ error: t("linkUnavailable") }, { status: 503 })
      : NextResponse.json({ error: t("resetInvalid") }, { status: 400 });
  }

  const now = new Date();
  await prisma.user.update({
    where: { id: claim.userId },
    data: {
      passwordHash: await bcrypt.hash(parsed.data.password, 10),
      // Ends every other session: the jwt callback refuses any token issued at
      // or before this second (lib/auth.ts).
      passwordChangedAt: now,
      // Clicking a link sent to the address proves what the confirmation mail
      // asks, so a reset doubles as verification.
      emailVerified: now,
    },
  });

  return NextResponse.json({ ok: true });
}
