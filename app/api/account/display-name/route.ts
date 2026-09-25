import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";
import { DisplayNameSchema } from "@/lib/competition";

const BodySchema = z.object({ displayName: z.string().max(200) });

/** Change the public leaderboard name (rectification, Art. 16). */
export async function PATCH(request: Request) {
  const t = await getErrorT();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: t("invalidInput") }, { status: 400 });
  const name = DisplayNameSchema.safeParse(body.data.displayName);
  if (!name.success) {
    return NextResponse.json({ error: t("displayNameInvalid") }, { status: 400 });
  }

  await prisma.user.update({ where: { id: user.id }, data: { displayName: name.data } });
  return NextResponse.json({ displayName: name.data });
}
