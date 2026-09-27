// Personal best times on the server (#127): the rules both the browser and the
// API routes need. Pure, so it is safe in a client bundle — the signing lives
// in lib/attempt-token.ts, the database side in lib/best-times-server.ts.

import { z } from "zod";
import { PIECE_PRESETS } from "./puzzle/grid";

/**
 * How long a best-time start stays good. Far longer than a competition's day
 * (`ATTEMPT_MAX_MS`): a personal best is nobody else's concern, and a 300-piece
 * puzzle solved over a week of evenings should still count. The clock pauses
 * while the tab is hidden, so the time itself stays well inside this.
 */
export const BEST_ATTEMPT_MAX_MS = 30 * 24 * 60 * 60 * 1000;

const PieceCount = z
  .number()
  .int()
  .refine((n) => (PIECE_PRESETS as readonly number[]).includes(n));

const Result = {
  ms: z.number().int().nonnegative(),
  // Bounded: the column is a 32-bit Int, and a value past it would be a 500
  // from the write rather than a 400 here. No honest solve comes near either.
  moves: z.number().int().positive().max(1_000_000),
};

/** A finished, timed solve, with the start the server signed for it. */
export const BestTimeSubmissionSchema = z.object({
  token: z.string().max(200),
  pieceCount: PieceCount,
  ...Result,
});

/**
 * Best times the browser already holds, per piece count, handed over once the
 * solver is signed in. There is no start to check them against — they were
 * finished before, or without, one — so the server holds them only to the
 * floor every honest solve clears (`minimumSolveMs`).
 */
export const BestTimeImportSchema = z.object({
  bests: z
    .record(z.string().regex(/^\d{1,4}$/), z.object(Result))
    .refine((r) => Object.keys(r).length <= PIECE_PRESETS.length),
});

export interface BestTimeRow {
  pieceCount: number;
  ms: number;
  moves: number;
}

/** A best-time row with the puzzle it belongs to, as /my reads it. */
export interface BestTimeWithPuzzle extends BestTimeRow {
  puzzle: { id: string; title: string; imageKey: string; ownerId: string; isPublic: boolean };
}

/**
 * The solver's best times as /my shows them: per puzzle, for the cards of the
 * solver's own puzzles, and a list of other people's puzzles for a section of
 * its own — in the order the rows came, so the query decides it. Another
 * person's puzzle made private since is left out of that list: it cannot be
 * opened any more, and a card for it would link to a 404.
 */
export function groupBestTimes(
  rows: readonly BestTimeWithPuzzle[],
  userId: string,
): {
  byPuzzle: Map<string, BestTimeRow[]>;
  others: Array<{ id: string; title: string; imageKey: string; bests: BestTimeRow[] }>;
} {
  const byPuzzle = new Map<string, BestTimeRow[]>();
  const others: Array<{ id: string; title: string; imageKey: string; bests: BestTimeRow[] }> = [];
  for (const { puzzle, pieceCount, ms, moves } of rows) {
    let list = byPuzzle.get(puzzle.id);
    if (!list) {
      list = [];
      byPuzzle.set(puzzle.id, list);
      if (puzzle.ownerId !== userId && puzzle.isPublic) {
        others.push({ id: puzzle.id, title: puzzle.title, imageKey: puzzle.imageKey, bests: list });
      }
    }
    list.push({ pieceCount, ms, moves });
  }
  return { byPuzzle, others };
}
