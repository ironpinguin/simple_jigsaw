import { NextResponse } from "next/server";
import { getSessionViewer } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";
import { canViewPuzzle } from "@/lib/visibility";
import { competitionPhase } from "@/lib/competition";
import { loadLeaderboard } from "@/lib/competition-server";

/**
 * A puzzle's competition and leaderboard. Readable by whoever may view the
 * puzzle, without an account — only taking part needs one.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await getErrorT();
  const { id } = await params;
  const viewer = await getSessionViewer();
  const puzzle = await prisma.puzzle.findUnique({
    where: { id },
    select: {
      isPublic: true,
      ownerId: true,
      competition: { select: { pieceCount: true, startsAt: true, endsAt: true } },
    },
  });
  if (!puzzle || !canViewPuzzle(puzzle, viewer) || !puzzle.competition) {
    return NextResponse.json({ error: t("competitionNotFound") }, { status: 404 });
  }

  const { competition } = puzzle;
  const leaderboard = await loadLeaderboard(id, viewer?.id ?? null);
  return NextResponse.json({
    competition: {
      pieceCount: competition.pieceCount,
      startsAt: competition.startsAt?.toISOString() ?? null,
      endsAt: competition.endsAt?.toISOString() ?? null,
      phase: competitionPhase(competition, new Date()),
    },
    ...leaderboard,
  });
}
