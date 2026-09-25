import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";
import { CompetitionSettingsSchema } from "@/lib/competition";

type Params = { params: Promise<{ id: string }> };

/** The competition as the owner's settings form shows it. */
function toDto(c: { pieceCount: number; startsAt: Date | null; endsAt: Date | null }) {
  return {
    pieceCount: c.pieceCount,
    startsAt: c.startsAt?.toISOString() ?? null,
    endsAt: c.endsAt?.toISOString() ?? null,
  };
}

/**
 * Turn the owner's puzzle into a competition, or change its window. Only a
 * public puzzle: the leaderboard shows names to everyone who can open the link,
 * and a private puzzle has nobody to compete.
 */
export async function PUT(request: Request, { params }: Params) {
  const t = await getErrorT();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });

  const parsed = CompetitionSettingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: t("invalidInput") }, { status: 400 });
  const { pieceCount } = parsed.data;
  const startsAt = parsed.data.startsAt ? new Date(parsed.data.startsAt) : null;
  const endsAt = parsed.data.endsAt ? new Date(parsed.data.endsAt) : null;

  const { id } = await params;
  const puzzle = await prisma.puzzle.findUnique({
    where: { id },
    select: {
      ownerId: true,
      isPublic: true,
      competition: { select: { pieceCount: true, _count: { select: { entries: true } } } },
    },
  });
  // 404 for someone else's puzzle too, as everywhere under /api/puzzles.
  if (!puzzle || puzzle.ownerId !== user.id) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }
  if (!puzzle.isPublic) {
    return NextResponse.json({ error: t("competitionNeedsPublic") }, { status: 409 });
  }
  // Times at another piece count are not comparable with the ones on the board.
  const existing = puzzle.competition;
  if (existing && existing.pieceCount !== pieceCount && existing._count.entries > 0) {
    return NextResponse.json({ error: t("competitionHasEntries") }, { status: 409 });
  }

  const competition = await prisma.competition.upsert({
    where: { puzzleId: id },
    create: { puzzleId: id, pieceCount, startsAt, endsAt },
    update: { pieceCount, startsAt, endsAt },
  });
  return NextResponse.json({ competition: toDto(competition) });
}

/** End the competition. The leaderboard goes with it (cascade). */
export async function DELETE(_request: Request, { params }: Params) {
  const t = await getErrorT();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });

  const { id } = await params;
  const removed = await prisma.competition.deleteMany({
    where: { puzzleId: id, puzzle: { ownerId: user.id } },
  });
  if (removed.count === 0) {
    return NextResponse.json({ error: t("competitionNotFound") }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
