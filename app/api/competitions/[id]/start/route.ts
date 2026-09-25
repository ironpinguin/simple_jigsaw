import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";
import { competitionPhase } from "@/lib/competition";
import { signCompetitionStart } from "@/lib/competition-token";

/**
 * Start an attempt: the server's own note of when it began, signed, for the
 * browser to hand back with the result. Stateless — nothing is stored, and
 * asking again simply starts a new attempt.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await getErrorT();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });

  const { id } = await params;
  const puzzle = await prisma.puzzle.findUnique({
    where: { id },
    select: { isPublic: true, competition: { select: { startsAt: true, endsAt: true } } },
  });
  // A private puzzle's competition is suspended, not merely hidden: nobody but
  // the owner can open it, so nobody else could take part fairly.
  if (!puzzle?.isPublic || !puzzle.competition) {
    return NextResponse.json({ error: t("competitionNotFound") }, { status: 404 });
  }
  const now = new Date();
  if (competitionPhase(puzzle.competition, now) !== "OPEN") {
    return NextResponse.json({ error: t("competitionNotOpen") }, { status: 409 });
  }

  return NextResponse.json({ token: signCompetitionStart(id, user.id, now.getTime()) });
}
