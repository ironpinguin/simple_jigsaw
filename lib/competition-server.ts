// Leaderboard reads shared by the competition routes and the puzzle page.

import { prisma } from "./db";
import { LEADERBOARD_SIZE } from "./competition";

export interface LeaderboardRow {
  id: string;
  rank: number;
  displayName: string;
  ms: number;
  moves: number;
  achievedAt: string;
  isYou: boolean;
}

export interface Leaderboard {
  entries: LeaderboardRow[];
  /** The viewer's own place, also when it is below the listed entries. */
  you: { rank: number; ms: number; moves: number } | null;
}

/**
 * The order of the board: faster first, fewer moves break a tie, and the one who
 * got there first wins what is left. `id` last only to make the order total.
 */
const ORDER = [
  { ms: "asc" as const },
  { moves: "asc" as const },
  { achievedAt: "asc" as const },
  { id: "asc" as const },
];

/** The place of a result: one more than the number of results strictly better. */
async function rankOf(competitionId: string, ms: number, moves: number): Promise<number> {
  const better = await prisma.leaderboardEntry.count({
    where: { competitionId, OR: [{ ms: { lt: ms } }, { ms, moves: { lt: moves } }] },
  });
  return better + 1;
}

export async function loadLeaderboard(
  competitionId: string,
  viewerId: string | null,
): Promise<Leaderboard> {
  const rows = await prisma.leaderboardEntry.findMany({
    where: { competitionId },
    orderBy: ORDER,
    take: LEADERBOARD_SIZE,
    // Only the public name: never the account id or email of another solver.
    select: {
      id: true,
      userId: true,
      ms: true,
      moves: true,
      achievedAt: true,
      user: { select: { displayName: true } },
    },
  });

  // Ties share a place, so the rank is not simply the position in the list.
  const entries: LeaderboardRow[] = [];
  for (const [i, row] of rows.entries()) {
    const prev = entries[i - 1];
    const tied = prev && prev.ms === row.ms && prev.moves === row.moves;
    entries.push({
      id: row.id,
      rank: tied ? prev.rank : i + 1,
      displayName: row.user.displayName ?? "—",
      ms: row.ms,
      moves: row.moves,
      achievedAt: row.achievedAt.toISOString(),
      isYou: row.userId === viewerId,
    });
  }

  let you: Leaderboard["you"] = null;
  if (viewerId) {
    const own = entries.find((e) => e.isYou);
    if (own) {
      you = { rank: own.rank, ms: own.ms, moves: own.moves };
    } else {
      const mine = await prisma.leaderboardEntry.findUnique({
        where: { competitionId_userId: { competitionId, userId: viewerId } },
        select: { ms: true, moves: true },
      });
      if (mine) you = { ...mine, rank: await rankOf(competitionId, mine.ms, mine.moves) };
    }
  }

  return { entries, you };
}

export { rankOf };
