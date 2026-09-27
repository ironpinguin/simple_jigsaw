import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";
import { competitionDto, competitionPhase, endedWindow } from "@/lib/competition";

/**
 * End the owner's competition now (#139): no further starts or entries, and the
 * leaderboard stays — as the final result, on the puzzle page and under My
 * puzzles, and for download. Deleting it is DELETE on the competition itself.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await getErrorT();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });

  const { id } = await params;
  const puzzle = await prisma.puzzle.findUnique({
    where: { id },
    select: {
      ownerId: true,
      competition: { select: { pieceCount: true, startsAt: true, endsAt: true } },
    },
  });
  // 404 for someone else's puzzle too, as everywhere under /api/puzzles.
  if (!puzzle || puzzle.ownerId !== user.id || !puzzle.competition) {
    return NextResponse.json({ error: t("competitionNotFound") }, { status: 404 });
  }

  const now = new Date();
  // Already over: ending it again would move its end date, and with it the
  // "ended on" everybody sees, to today.
  if (competitionPhase(puzzle.competition, now) === "CLOSED") {
    return NextResponse.json({ competition: competitionDto(puzzle.competition) });
  }

  const competition = await prisma.competition.update({
    where: { puzzleId: id },
    data: endedWindow(puzzle.competition, now),
  });
  return NextResponse.json({ competition: competitionDto(competition) });
}
