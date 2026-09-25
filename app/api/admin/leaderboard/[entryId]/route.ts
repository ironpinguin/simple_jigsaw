import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";

/**
 * Remove one leaderboard entry — a result that got past the plausibility check,
 * say. The solver can enter again; removing them for good is what a ban is for.
 *
 * `?resetName=1` also clears the solver's display name, for an entry removed
 * because of the name: it is one name per account, so leaving it would bring
 * it straight back with the next entry. Their entries on other leaderboards
 * show a dash until they choose a new one, which the next entry asks for.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ entryId: string }> },
) {
  const t = await getErrorT();
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: t("noAccess") }, { status: 403 });
  }
  const { entryId } = await params;
  const resetName = new URL(request.url).searchParams.get("resetName") === "1";

  if (!resetName) {
    const removed = await prisma.leaderboardEntry.deleteMany({ where: { id: entryId } });
    if (removed.count === 0) {
      return NextResponse.json({ error: t("entryNotFound") }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  }

  const done = await prisma.$transaction(async (tx) => {
    const entry = await tx.leaderboardEntry.findUnique({
      where: { id: entryId },
      select: { userId: true },
    });
    if (!entry) return false;
    await tx.leaderboardEntry.delete({ where: { id: entryId } });
    await tx.user.update({ where: { id: entry.userId }, data: { displayName: null } });
    return true;
  });
  if (!done) return NextResponse.json({ error: t("entryNotFound") }, { status: 404 });
  return NextResponse.json({ ok: true, nameReset: true });
}
