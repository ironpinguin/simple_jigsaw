import { NextResponse } from "next/server";
import { z } from "zod";
import { redeemToken } from "@/lib/token-redeem";
import { getErrorT } from "@/lib/i18n-server";

const Schema = z.object({ token: z.string().min(1) });

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
  // answers 409. Rolling back hands the link back instead. Any other error — a
  // failed write, a bug in here — is a 500, and the token survives it.
  const redeemed = await redeemToken(parsed.data.token, "EMAIL_VERIFY", async (tx, userId) => {
    await tx.user.update({ where: { id: userId }, data: { emailVerified: new Date() } });
  });

  if (!redeemed.ok) {
    // A claim that could not be attempted is not a bad link: the row is still
    // there and a retry may work, so this answers 503 rather than telling the
    // holder their link has expired and sending them to re-register. It is also
    // the status an operator's monitoring already watches. See lib/tokens.ts.
    return redeemed.reason === "unavailable"
      ? NextResponse.json({ error: t("linkUnavailable") }, { status: 503 })
      : NextResponse.json({ error: t("verifyInvalid") }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
