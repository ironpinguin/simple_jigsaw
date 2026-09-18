import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/bans";
import { checkEmailBanned } from "@/lib/moderation";
import { createToken } from "@/lib/tokens";
import { sendPasswordResetEmail } from "@/lib/mail";
import { hasTrustedProxy, hashReporterIp } from "@/lib/report-ip";
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
 *
 * Status and body only, deliberately not timing: an unknown address returns
 * after one `findUnique`, while an eligible one additionally runs two counts,
 * an insert, an opportunistic sweep and an awaited SMTP round trip — tens to
 * hundreds of milliseconds more. Equalising that would mean firing the mail
 * send without awaiting it, which is worse in this runtime (a failure has
 * nowhere left to be handled). The gap is real and left alone; `recordProbe`
 * below is what limits how fast a caller can sample it, not what closes it.
 */
const SAME_ANSWER = { ok: true };
const answer = () => NextResponse.json(SAME_ANSWER);

export async function POST(request: Request) {
  const ipHash = hashReporterIp(request.headers.get("x-forwarded-for"));

  // Record unconditionally so the counter stays warm if the deployment later
  // gains a trusted proxy; enforce only when the hash identifies one client.
  // Before anything that costs a query — this is the only limit that sees a
  // request for an address with no account, because such a request creates no
  // row for the database counts below to find. See lib/password-reset.ts for
  // why enforcement is gated: without a trusted proxy, every visitor hashes to
  // one shared bucket, and enforcing here would make this a lever one caller
  // could hold over everyone's password recovery.
  const withinProbeLimit = recordProbe(ipHash);
  if (hasTrustedProxy() && !withinProbeLimit) return answer();

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
  const forUser = await prisma.verificationToken.count({
    where: { userId: user.id, type: "PASSWORD_RESET", createdAt: { gte: since } },
  });
  if (forUser >= RESET_PER_EMAIL_LIMIT) return answer();

  // The per-IP durable count is only meaningful when x-forwarded-for can be
  // trusted to identify a single client (lib/report-ip.ts). With the shipped
  // default of no trusted proxy, every visitor hashes to the same "unknown"
  // bucket, so counting it here would turn RESET_PER_IP_LIMIT into a
  // deployment-wide cap: one visitor spending it would silently deny password
  // recovery to everyone else, and — because the response never varies —
  // nobody would ever learn why. The per-email count above stays unconditional
  // because it is meaningful in every configuration.
  if (hasTrustedProxy()) {
    const forIp = await prisma.verificationToken.count({
      where: { requesterIpHash: ipHash, type: "PASSWORD_RESET", createdAt: { gte: since } },
    });
    if (forIp >= RESET_PER_IP_LIMIT) return answer();
  }

  // Deliberately no revokeTokens here, unlike the admin invite route. Revoking
  // deletes the rows the counts above read, so the per-address limit could never
  // exceed one. The invite route's reasoning does not transfer either: its two
  // live links can sit in two different mailboxes, where every reset link goes
  // to the account's own address. Single use and a two-hour life are what keep
  // the extras harmless.
  const locale = await resolveRequestLocale();
  try {
    const token = await createToken(user.id, "PASSWORD_RESET", ipHash);
    await sendPasswordResetEmail(user.email, token, locale);
  } catch (error) {
    // Swallowed on purpose and never surfaced as anything but the identical
    // answer. This branch is reachable only for an address that exists, is
    // unbanned, has a password hash and is under its limit — so letting an
    // exception here escape as a 500 (an SMTP outage, a relay rejecting one
    // recipient, a database blip) would make mail trouble an oracle telling
    // the caller exactly which addresses have accounts.
    console.error(`[reset-request] sending a reset email for user ${user.id} failed:`, error);
  }

  // A token created just above may now exist even though the mail failed to
  // send. Left in place on purpose: it is single-use, expires in two hours,
  // only ever mailed to the account's own address, and already counted
  // against the per-address budget checked above — deleting it here would let
  // an attacker who can induce send failures reset that budget for free.

  return answer();
}
