import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT, resolveRequestLocale } from "@/lib/i18n-server";
import { loadAllEntries } from "@/lib/competition-server";
import { leaderboardCsv, leaderboardFileName } from "@/lib/leaderboard-csv";

/**
 * The whole leaderboard of the owner's competition as a CSV file (#139) —
 * running or ended, every entry rather than the shown top places. Only the
 * owner: the file carries what the board shows anyway (display name, time,
 * moves, when), but as a copy that leaves the site.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await getErrorT();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });

  const { id } = await params;
  const puzzle = await prisma.puzzle.findUnique({
    where: { id },
    select: { ownerId: true, title: true, competition: { select: { puzzleId: true } } },
  });
  // 404 for someone else's puzzle too, admins included — as for the settings.
  if (!puzzle || puzzle.ownerId !== user.id || !puzzle.competition) {
    return NextResponse.json({ error: t("competitionNotFound") }, { status: 404 });
  }

  const tc = await getTranslations({ locale: await resolveRequestLocale(), namespace: "competition" });
  const csv = leaderboardCsv(await loadAllEntries(id), {
    rank: tc("csvRank"),
    displayName: tc("csvDisplayName"),
    time: tc("csvTime"),
    ms: tc("csvMs"),
    moves: tc("csvMoves"),
    achievedAt: tc("csvAchievedAt"),
  });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${leaderboardFileName(puzzle.title)}"`,
      // A running competition changes with every entry; never serve a stale copy.
      "Cache-Control": "no-store",
    },
  });
}
