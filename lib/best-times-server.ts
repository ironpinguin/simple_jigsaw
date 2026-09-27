// Personal best times in the database (#127). Shared by the submit and the
// import route, and by the pages that show them.

import { prisma } from "./db";
import { isBetterResult } from "./competition";
import type { BestTimes, SolveResult } from "./puzzle/timer";

/**
 * Keep `result` as the solver's best for this puzzle and piece count if it
 * beats what is stored — faster, or as fast with fewer moves. Answers with
 * the best that stands afterwards and whether this result is it.
 *
 * The same conditional write as a leaderboard entry
 * (app/api/competitions/[id]/entries/route.ts): two tabs finishing at once
 * cannot overwrite a better time with a worse one, because the update only
 * lands where it still improves.
 */
export async function recordServerBest(
  userId: string,
  puzzleId: string,
  pieceCount: number,
  result: SolveResult,
  achievedAt: Date,
): Promise<{ best: SolveResult; improved: boolean }> {
  const { ms, moves } = result;
  const key = { userId_puzzleId_pieceCount: { userId, puzzleId, pieceCount } };
  const better = { OR: [{ ms: { gt: ms } }, { ms, moves: { gt: moves } }] };
  const data = { ms, moves, achievedAt };

  const improve = async () =>
    (
      await prisma.bestTime.updateMany({
        where: { userId, puzzleId, pieceCount, ...better },
        data,
      })
    ).count > 0;

  const standing = await prisma.bestTime.findUnique({
    where: key,
    select: { ms: true, moves: true },
  });
  // Nothing to write, and no second read needed, when it already stands better.
  if (standing && !isBetterResult(result, standing)) return { best: standing, improved: false };
  let landed: boolean;
  if (standing) {
    landed = await improve();
  } else {
    try {
      await prisma.bestTime.create({ data: { userId, puzzleId, pieceCount, ...data } });
      landed = true;
    } catch (err) {
      // Another tab created the row in between; fall back to improving it.
      if ((err as { code?: string }).code !== "P2002") throw err;
      landed = await improve();
    }
  }
  if (landed) return { best: { ms, moves }, improved: true };

  const current = await prisma.bestTime.findUnique({
    where: key,
    select: { ms: true, moves: true },
  });
  return { best: current ?? { ms, moves }, improved: false };
}

/** The solver's best times on one puzzle, keyed by piece count like the browser's. */
export async function loadBestTimes(userId: string, puzzleId: string): Promise<BestTimes> {
  const rows = await prisma.bestTime.findMany({
    where: { userId, puzzleId },
    select: { pieceCount: true, ms: true, moves: true },
  });
  const out: BestTimes = {};
  for (const row of rows) out[row.pieceCount] = { ms: row.ms, moves: row.moves };
  return out;
}
