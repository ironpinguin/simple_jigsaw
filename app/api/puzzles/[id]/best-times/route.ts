import { NextResponse } from "next/server";
import { getSessionViewer } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";
import { canViewPuzzle } from "@/lib/visibility";
import { judgeSubmission } from "@/lib/competition";
import { verifyAttemptStart } from "@/lib/attempt-token";
import { BEST_ATTEMPT_MAX_MS, BestTimeSubmissionSchema } from "@/lib/best-times";
import { recordServerBest } from "@/lib/best-times-server";

/**
 * Submit a finished, timed solve of the signed-in solver (#127). Kept as their
 * best for that piece count if it beats the stored one; answers with the best
 * that stands either way.
 *
 * Judged like a competition entry against the signed start — no faster than
 * the floor for the piece count, no longer than has really passed since the
 * start — except that a start stays good for `BEST_ATTEMPT_MAX_MS`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await getErrorT();
  const viewer = await getSessionViewer();
  if (!viewer) return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });

  const parsed = BestTimeSubmissionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: t("invalidInput") }, { status: 400 });
  const { token, pieceCount, ms, moves } = parsed.data;

  const { id } = await params;
  const puzzle = await prisma.puzzle.findUnique({
    where: { id },
    select: { isPublic: true, ownerId: true },
  });
  if (!puzzle || !canViewPuzzle(puzzle, viewer)) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }

  const startedAt = verifyAttemptStart("best-time-start:v1", token, id, viewer.id);
  const now = Date.now();
  const verdict =
    startedAt === null
      ? "BAD_START"
      : judgeSubmission({ ms, pieceCount, startedAt, now, maxMs: BEST_ATTEMPT_MAX_MS });
  if (verdict === "EXPIRED" || verdict === "BAD_START") {
    return NextResponse.json({ error: t("bestTimeAttemptInvalid") }, { status: 400 });
  }
  if (verdict !== "OK") {
    return NextResponse.json({ error: t("resultImplausible") }, { status: 422 });
  }

  const { best, improved } = await recordServerBest(
    viewer.id,
    id,
    pieceCount,
    { ms, moves },
    new Date(now),
  );
  return NextResponse.json({ best, improved });
}
