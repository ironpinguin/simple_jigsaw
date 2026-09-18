import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { consumeToken, revokeTokens } from "@/lib/tokens";
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

  // Up to RESET_PER_EMAIL_LIMIT other PASSWORD_RESET links can still be live
  // for this account — a reset mail still sitting in an inbox is a second
  // key. Completing this one answers the same question the others were sent
  // for just as deliberately as changing the password from inside the account
  // does (app/api/account/password/route.ts), so it revokes for the same
  // reason. After the update, not before: a failed write must not disarm
  // links the user may still need.
  //
  // Swallowed rather than reported: the password has already been reset
  // above, so a 500 here would tell the user the opposite of what happened.
  // The cost of swallowing it is the other links surviving for up to their
  // two-hour TTL — the reason this is logged rather than ignored. Unlike the
  // request route's rate limiter, this cannot be ground down by an attacker:
  // reaching this point already required clicking a mailed link, which
  // implies the mailbox access the limiter exists to approximate.
  try {
    await revokeTokens(claim.userId, "PASSWORD_RESET");
  } catch (error) {
    console.error(
      `[account-password-reset] revoking other PASSWORD_RESET links for user ${claim.userId} failed ` +
        `after the password was already reset; another link may still work for up to its TTL:`,
      error,
    );
  }

  return NextResponse.json({ ok: true });
}
