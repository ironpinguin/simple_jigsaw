import { NextResponse } from "next/server";
import { getSessionViewer } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";
import { canViewPuzzle } from "@/lib/visibility";
import { BestTimeImportSchema, isImportableBest } from "@/lib/best-times";
import { recordServerBest } from "@/lib/best-times-server";

/**
 * Take over best times the browser holds for this puzzle and this account
 * (#127) that the server lacks — a solve whose submission never arrived, or one
 * finished without a signed start. Only the account's own: the browser keeps
 * those apart from the ones set signed out, which it never sends. Each is kept where it beats the
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
  // One row per piece count, so the writes are independent of each other.
  const kept = await Promise.all(
    Object.entries(parsed.data.bests)
      .filter(([key, result]) => isImportableBest(Number(key), result))
      .map(async ([key, result]) => {
        const { best } = await recordServerBest(viewer.id, id, Number(key), result, now);
        return [key, best] as const;
      }),
  );
  return NextResponse.json({ bests: Object.fromEntries(kept) });
}
