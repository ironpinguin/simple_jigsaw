import { NextResponse } from "next/server";
import { getSessionViewer } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";
import { canViewPuzzle } from "@/lib/visibility";
import { minimumSolveMs } from "@/lib/competition";
import { PIECE_PRESETS } from "@/lib/puzzle/grid";
import { BestTimeImportSchema } from "@/lib/best-times";
import { recordServerBest } from "@/lib/best-times-server";
import type { SolveResult } from "@/lib/puzzle/timer";

/**
 * Take over best times the browser already holds for this puzzle (#127), once
 * the solver is signed in: those set before signing in, on this device, or
 * while the server could not be reached. Each is kept where it beats the
 * stored one, as a submitted solve would be.
 *
 * There is no signed start to judge them by, so only the floor for the piece
 * count applies; one below it is skipped rather than failing the rest. That is
 * weaker than a submission, and acceptable here only because a best time is
 * shown to nobody but the solver — it is not a leaderboard.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await getErrorT();
  const viewer = await getSessionViewer();
  if (!viewer) return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });

  const parsed = BestTimeImportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: t("invalidInput") }, { status: 400 });

  const { id } = await params;
  const puzzle = await prisma.puzzle.findUnique({
    where: { id },
    select: { isPublic: true, ownerId: true },
  });
  if (!puzzle || !canViewPuzzle(puzzle, viewer)) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }

  const now = new Date();
  const bests: Record<string, SolveResult> = {};
  for (const [key, result] of Object.entries(parsed.data.bests)) {
    const pieceCount = Number(key);
    if (!(PIECE_PRESETS as readonly number[]).includes(pieceCount)) continue;
    if (result.ms < minimumSolveMs(pieceCount)) continue;
    bests[key] = (await recordServerBest(viewer.id, id, pieceCount, result, now)).best;
  }
  return NextResponse.json({ bests });
}
