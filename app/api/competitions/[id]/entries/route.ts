import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";
import {
  DisplayNameSchema,
  competitionPhase,
  isBetterResult,
  judgeSubmission,
} from "@/lib/competition";
import { verifyCompetitionStart } from "@/lib/competition-token";
import { rankOf } from "@/lib/competition-server";

const EntrySchema = z.object({
  token: z.string().max(200),
  ms: z.number().int().nonnegative(),
  // Bounded: the column is a 32-bit Int, and a value past it would be a 500
  // from the write rather than a 400 here. No honest solve comes near either.
  moves: z.number().int().positive().max(1_000_000),
  // The count the board was cut into. A competition's count can still change
  // while it has no entries, and a page opened before that keeps the old one.
  pieceCount: z.number().int(),
  // Only needed, and only honoured, while the account has no display name yet.
  displayName: z.string().max(200).optional(),
});

/**
 * Submit a finished attempt. Keeps the better of this and the solver's standing
 * entry; answers with the place either way, so the solver learns where they
 * stand even when the new time did not improve it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await getErrorT();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });

  const parsed = EntrySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: t("invalidInput") }, { status: 400 });
  const { token, ms, moves } = parsed.data;

  const { id } = await params;
  const puzzle = await prisma.puzzle.findUnique({
    where: { id },
    select: {
      isPublic: true,
      competition: { select: { pieceCount: true, startsAt: true, endsAt: true } },
    },
  });
  if (!puzzle?.isPublic || !puzzle.competition) {
    return NextResponse.json({ error: t("competitionNotFound") }, { status: 404 });
  }
  const { competition } = puzzle;
  const now = new Date();
  // Checked at submission, not at the start: the leaderboard closes at the end
  // date, including for attempts that were still running then.
  if (competitionPhase(competition, now) !== "OPEN") {
    return NextResponse.json({ error: t("competitionNotOpen") }, { status: 409 });
  }
  // Times at another piece count are not comparable with the ones on the board.
  if (parsed.data.pieceCount !== competition.pieceCount) {
    return NextResponse.json({ error: t("competitionCountChanged") }, { status: 409 });
  }

  const startedAt = verifyCompetitionStart(token, id, user.id);
  if (startedAt === null) {
    return NextResponse.json({ error: t("attemptInvalid") }, { status: 400 });
  }
  const verdict = judgeSubmission({
    ms,
    pieceCount: competition.pieceCount,
    startedAt,
    now: now.getTime(),
  });
  if (verdict === "EXPIRED" || verdict === "BAD_START") {
    return NextResponse.json({ error: t("attemptInvalid") }, { status: 400 });
  }
  if (verdict !== "OK") {
    return NextResponse.json({ error: t("resultImplausible") }, { status: 422 });
  }

  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: { displayName: true },
  });
  let displayName = account?.displayName ?? null;
  if (!displayName) {
    // A public name is never made up: the solver chooses it, once.
    if (parsed.data.displayName === undefined) {
      // `code` beside the translated message: the solver answers this one with a
      // name prompt rather than showing it, so it has to tell it apart.
      return NextResponse.json(
        { error: t("displayNameRequired"), code: "displayNameRequired" },
        { status: 409 },
      );
    }
    const name = DisplayNameSchema.safeParse(parsed.data.displayName);
    if (!name.success) {
      return NextResponse.json(
        { error: t("displayNameInvalid"), code: "displayNameInvalid" },
        { status: 400 },
      );
    }
    displayName = name.data;
    await prisma.user.update({ where: { id: user.id }, data: { displayName } });
  }

  const key = { competitionId_userId: { competitionId: id, userId: user.id } };
  const standing = await prisma.leaderboardEntry.findUnique({
    where: key,
    select: { ms: true, moves: true },
  });
  let improved = isBetterResult({ ms, moves }, standing);
  let best = improved ? { ms, moves } : standing!;
  if (improved) {
    // Conditional, so two tabs finishing at once cannot overwrite a better
    // time with a worse one: the write only lands where it still improves.
    const better = { OR: [{ ms: { gt: ms } }, { ms, moves: { gt: moves } }] };
    const data = { ms, moves, achievedAt: now };
    const improve = async () =>
      (
        await prisma.leaderboardEntry.updateMany({
          where: { competitionId: id, userId: user.id, ...better },
          data,
        })
      ).count > 0;
    let landed: boolean;
    if (standing) {
      landed = await improve();
    } else {
      try {
        await prisma.leaderboardEntry.create({
          data: { competitionId: id, userId: user.id, ...data },
        });
        landed = true;
      } catch (err) {
        // Another tab created the entry in between; fall back to improving it.
        if ((err as { code?: string }).code !== "P2002") throw err;
        landed = await improve();
      }
    }
    if (!landed) {
      // The other tab's time was the better one: answer with what is on the
      // board, not with a result that never made it there.
      const current = await prisma.leaderboardEntry.findUnique({
        where: key,
        select: { ms: true, moves: true },
      });
      if (current) {
        improved = false;
        best = current;
      }
    }
  }

  return NextResponse.json({
    improved,
    best,
    rank: await rankOf(id, best.ms, best.moves),
    displayName,
  });
}
