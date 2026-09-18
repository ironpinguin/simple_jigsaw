import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/bans";
import { checkEmailBanned } from "@/lib/moderation";
import { createToken } from "@/lib/tokens";
import { sendPasswordResetEmail } from "@/lib/mail";
import { hashReporterIp } from "@/lib/report-ip";
import { resolveRequestLocale } from "@/lib/i18n-server";
import {
  RESET_PER_EMAIL_LIMIT,
  RESET_PER_IP_LIMIT,
  RESET_RATE_WINDOW_MS,
  recordProbe,
} from "@/lib/password-reset";

const Schema = z.object({ email: z.string().email() });

/**
 * The one answer this route ever gives. Unknown address, banned address, a row
 * with no password, a spent rate limit, a malformed body and a sent mail all
 * produce exactly this — which is what lets the endpoint be public without
 * telling the internet which addresses have accounts.
 */
const SAME_ANSWER = { ok: true };
const answer = () => NextResponse.json(SAME_ANSWER);

export async function POST(request: Request) {
  const ipHash = hashReporterIp(request.headers.get("x-forwarded-for"));

  // Before anything that costs a query. This is the only limit that sees a
  // request for an address with no account, because such a request creates no
  // row for the database counts below to find.
  if (!recordProbe(ipHash)) return answer();

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return answer();

  const email = normalizeEmail(parsed.data.email);
  if (await checkEmailBanned(email)) return answer();

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, passwordHash: true },
  });

  // A row with no hash is an invitation that was never redeemed; those belong to
  // the invite flow (#33), and a reset link would be a second, quieter way to
  // activate one. Verification is deliberately NOT required — an account that
  // never confirmed its address is exactly the one with no other way back, and
  // completing the reset marks it verified.
  if (!user?.passwordHash) return answer();

  const since = new Date(Date.now() - RESET_RATE_WINDOW_MS);
  const [forUser, forIp] = await Promise.all([
    prisma.verificationToken.count({
      where: { userId: user.id, type: "PASSWORD_RESET", createdAt: { gte: since } },
    }),
    prisma.verificationToken.count({
      where: { requesterIpHash: ipHash, type: "PASSWORD_RESET", createdAt: { gte: since } },
    }),
  ]);
  if (forUser >= RESET_PER_EMAIL_LIMIT || forIp >= RESET_PER_IP_LIMIT) return answer();

  // Deliberately no revokeTokens here, unlike the admin invite route. Revoking
  // deletes the rows the counts above read, so the per-address limit could never
  // exceed one. The invite route's reasoning does not transfer either: its two
  // live links can sit in two different mailboxes, where every reset link goes
  // to the account's own address. Single use and a two-hour life are what keep
  // the extras harmless.
  const locale = await resolveRequestLocale();
  const token = await createToken(user.id, "PASSWORD_RESET", ipHash);
  await sendPasswordResetEmail(user.email, token, locale);

  return answer();
}
