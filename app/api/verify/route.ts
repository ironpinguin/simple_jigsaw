import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { consumeToken, recordClaimFailure, type ClaimRefusal } from "@/lib/tokens";
import { isTransientTransactionError } from "@/lib/prisma-errors";
import { getErrorT } from "@/lib/i18n-server";

const Schema = z.object({ token: z.string().min(1) });

/**
 * A refusal decided inside the transaction. Thrown rather than returned so the
 * claim rolls back with it — the route's answer is chosen from it afterwards.
 */
class Refused extends Error {
  constructor(readonly reason: ClaimRefusal) {
    super(reason);
  }
}

export async function POST(request: Request) {
  const t = await getErrorT();
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t("invalidRequest") }, { status: 400 });
  }

  // Claim and confirmation in one transaction (#50). The claim is irreversible
  // on its own and lands before the work it authorises, so a write that threw
  // here used to leave the address unconfirmed with the token already spent —
  // and EMAIL_VERIFY is only minted at registration, which a second attempt
  // answers 409. Rolling back hands the link back instead.
  try {
    await prisma.$transaction(async (tx) => {
      const claim = await consumeToken(parsed.data.token, "EMAIL_VERIFY", tx);
      if (!claim.ok) throw new Refused(claim.reason);

      await tx.user.update({
        where: { id: claim.userId },
        data: { emailVerified: new Date() },
      });
    });
  } catch (error) {
    // A transaction that never started, or that ran out its deadline, throws
    // here rather than inside the claim, and means the same thing a failed
    // claim means: nothing was spent and a retry may work. Left as an unknown
    // error it would be a bare 500, and the claim counters would stay clean
    // while every confirmation in the instance failed.
    if (isTransientTransactionError(error)) {
      recordClaimFailure("EMAIL_VERIFY", error);
      return NextResponse.json({ error: t("linkUnavailable") }, { status: 503 });
    }
    // Anything else — a failed write, a bug in here — is a 500. What changed is
    // that the token survives it.
    if (!(error instanceof Refused)) throw error;

    // A claim that could not be attempted is not a bad link: the row is still
    // there and a retry may work, so this answers 503 rather than telling the
    // holder their link has expired and sending them to re-register. It is also
    // the status an operator's monitoring already watches. See lib/tokens.ts.
    return error.reason === "unavailable"
      ? NextResponse.json({ error: t("linkUnavailable") }, { status: 503 })
      : NextResponse.json({ error: t("verifyInvalid") }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
