import { describe, expect, it } from "vitest";
import {
  BestTimeImportSchema,
  MAX_RESULT_MS,
  groupBestTimes,
  importableBests,
  isImportableBest,
  type BestTimeWithPuzzle,
} from "./best-times";

function row(
  puzzleId: string,
  pieceCount: number,
  owner: { ownerId: string; isPublic: boolean },
): BestTimeWithPuzzle {
  return {
    pieceCount,
    ms: pieceCount * 1_000,
    moves: pieceCount,
    puzzle: { id: puzzleId, title: `T-${puzzleId}`, imageKey: `k-${puzzleId}`, ...owner },
  };
}

describe("groupBestTimes", () => {
  const mine = { ownerId: "me", isPublic: false };
  const theirs = { ownerId: "them", isPublic: true };
  const theirsPrivate = { ownerId: "them", isPublic: false };

  it("groups per puzzle, keeping the rows' order", () => {
    const { byPuzzle } = groupBestTimes(
      [row("a", 48, mine), row("b", 12, theirs), row("a", 12, mine)],
      "me",
    );
    expect(byPuzzle.get("a")!.map((b) => b.pieceCount)).toEqual([48, 12]);
    expect(byPuzzle.get("b")!.map((b) => b.pieceCount)).toEqual([12]);
  });

  it("lists other people's public puzzles once each, not the solver's own", () => {
    const { others } = groupBestTimes(
      [row("a", 48, mine), row("b", 12, theirs), row("b", 48, theirs)],
      "me",
    );
    expect(others.map((p) => p.id)).toEqual(["b"]);
    expect(others[0]).toMatchObject({ title: "T-b", imageKey: "k-b" });
    expect(others[0].bests.map((b) => b.pieceCount)).toEqual([12, 48]);
  });

  it("leaves out someone else's puzzle that has been made private", () => {
    expect(groupBestTimes([row("c", 12, theirsPrivate)], "me").others).toEqual([]);
  });

  it("carries no owner or visibility into the rows it hands on", () => {
    const [best] = groupBestTimes([row("b", 12, theirs)], "me").others[0].bests;
    expect(best).toEqual({ pieceCount: 12, ms: 12_000, moves: 12 });
  });
});

describe("BestTimeImportSchema", () => {
  it("accepts results keyed by piece count", () => {
    expect(BestTimeImportSchema.safeParse({ bests: { 12: { ms: 1, moves: 1 } } }).success).toBe(true);
  });

  it("refuses more entries than there are presets, and odd keys", () => {
    const many = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [String(i + 1), { ms: 1, moves: 1 }]),
    );
    expect(BestTimeImportSchema.safeParse({ bests: many }).success).toBe(false);
    expect(BestTimeImportSchema.safeParse({ bests: { abc: { ms: 1, moves: 1 } } }).success).toBe(false);
  });
});

describe("importableBests", () => {
  it("keeps what the import would take, and leaves out what it would skip or refuse", () => {
    expect(
      importableBests({
        12: { ms: 50_000, moves: 20 },
        48: { ms: 1_000, moves: 20 }, // below the floor
        13: { ms: 50_000, moves: 20 }, // not a preset
        108: { ms: 900_000, moves: 0 }, // no moves
        300: { ms: MAX_RESULT_MS + 1, moves: 400 }, // past the column
        abc: { ms: 50_000, moves: 20 },
      }),
    ).toEqual({ 12: { ms: 50_000, moves: 20 } });
  });

  it("agrees with the schema on what fits", () => {
    const fits = { ms: MAX_RESULT_MS, moves: 1 };
    expect(isImportableBest(300, fits)).toBe(true);
    expect(BestTimeImportSchema.safeParse({ bests: { 300: fits } }).success).toBe(true);
    expect(isImportableBest(12, { ms: 6_000.5, moves: 1 })).toBe(false);
  });
});
