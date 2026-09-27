// Personal best times on the server (#127): the rules both the browser and the
// API routes need. Pure, so it is safe in a client bundle — the signing lives
// in lib/attempt-token.ts, the database side in lib/best-times-server.ts.

import { z } from "zod";
import { minimumSolveMs } from "./competition";
import { PIECE_PRESETS } from "./puzzle/grid";
import type { BestTimes, SolveResult } from "./puzzle/timer";

/**
 * How long a best-time start stays good. Far longer than a competition's day
 * (`ATTEMPT_MAX_MS`): a personal best is nobody else's concern, and a 300-piece
 * puzzle solved over a week of evenings should still count. The clock pauses
 * while the tab is hidden, so the time itself stays well inside this.
 */
export const BEST_ATTEMPT_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The longest time the `ms` column holds — a 32-bit Int, about 24.8 days, so
 * less than `BEST_ATTEMPT_MAX_MS` lets through on its own.
 */
export const MAX_RESULT_MS = 2_147_483_647;
const MAX_MOVES = 1_000_000;

const isPreset = (n: number) => (PIECE_PRESETS as readonly number[]).includes(n);

const PieceCount = z.number().int().refine(isPreset);

const Result = {
  // Both bounded: the columns are 32-bit Ints, and a value past either would be
  // a 500 from the write rather than a 400 here. No honest solve comes near.
  ms: z.number().int().nonnegative().max(MAX_RESULT_MS),
  moves: z.number().int().positive().max(MAX_MOVES),
};

/** A finished, timed solve, with the start the server signed for it. */
export const BestTimeSubmissionSchema = z.object({
  token: z.string().max(200),
  pieceCount: PieceCount,
  ...Result,
});

/**
 * Best times the browser holds for the signed-in account, per piece count,
 * that the server lacks — never the ones set signed out. There is no start to
 * check them against — their submission never arrived, or they were finished
 * without one — so the server holds them only to the floor every honest solve
 * clears (`minimumSolveMs`).
 */
export const BestTimeImportSchema = z.object({
  bests: z
    .record(z.string().regex(/^\d{1,4}$/), z.object(Result))
    .refine((r) => Object.keys(r).length <= PIECE_PRESETS.length),
});

/**
 * Whether the import would keep `result` for `pieceCount`: a preset count, a
 * time at or above its floor, and values the columns hold. The route skips the
 * rest; the browser leaves them out, so one odd entry in its storage neither
 * fails the whole import nor goes out again on every visit.
 */
export function isImportableBest(pieceCount: number, result: SolveResult): boolean {
  const { ms, moves } = result;
  return (
    isPreset(pieceCount) &&
    Number.isInteger(ms) &&
    ms >= minimumSolveMs(pieceCount) &&
    ms <= MAX_RESULT_MS &&
    Number.isInteger(moves) &&
    moves >= 1 &&
    moves <= MAX_MOVES
  );
}

/** The entries of `bests` the import would keep; see `isImportableBest`. */
export function importableBests(bests: BestTimes): BestTimes {
  return Object.fromEntries(
    Object.entries(bests).filter(([count, result]) => isImportableBest(Number(count), result)),
  );
}

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
