import { NextResponse } from "next/server";
import { getSessionViewer } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";
import { canViewPuzzle } from "@/lib/visibility";
import { signAttemptStart } from "@/lib/attempt-token";

/**
 * Start a timed solve for the signed-in solver's best times (#127): the
 * server's own note of when it began, signed, for the browser to hand back
 * with the result. Stateless like a competition start, and under its own
 * purpose, so it is never accepted as one (lib/attempt-token.ts).
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await getErrorT();
  const viewer = await getSessionViewer();
  if (!viewer) return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });

  const { id } = await params;
  const puzzle = await prisma.puzzle.findUnique({
    where: { id },
    select: { isPublic: true, ownerId: true },
  });
  // 404, not 403 — a private puzzle must not confirm its own existence.
  if (!puzzle || !canViewPuzzle(puzzle, viewer)) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }

  return NextResponse.json({
    token: signAttemptStart("best-time-start:v1", id, viewer.id, Date.now()),
  });
}
