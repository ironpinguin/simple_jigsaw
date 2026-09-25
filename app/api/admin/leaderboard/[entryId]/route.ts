import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";

/**
 * Remove one leaderboard entry — an offensive display name, say, or a result
 * that got past the plausibility check. The solver can enter again; removing
 * them for good is what a ban is for.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ entryId: string }> },
) {
  const t = await getErrorT();
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: t("noAccess") }, { status: 403 });
  }
  const { entryId } = await params;
  const removed = await prisma.leaderboardEntry.deleteMany({ where: { id: entryId } });
  if (removed.count === 0) {
    return NextResponse.json({ error: t("entryNotFound") }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
