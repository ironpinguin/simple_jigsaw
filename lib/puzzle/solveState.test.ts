import { describe, it, expect } from "vitest";
import { pieceId, type PieceGroup } from "./groups";
import { boardGeometry, pieceBox, scatterGroups, type Rect } from "./board";
import { generateEdges } from "./edges";
import {
  MAX_STORED_SOLVES,
  SOLVE_STATE_VERSION,
  deserialiseSolveState,
  readSolveTiming,
  restoreSolveState,
  serialiseSolveState,
  solveKeysToPrune,
  solveStateKey,
} from "./solveState";

/** A 2x2 board split into two vertical dominoes, at plausible stage positions. */
const GROUPS: PieceGroup[] = [
  { id: 4, x: 100, y: 50, members: ["0-0", "1-0"] },
  { id: 9, x: 600, y: 300, members: ["0-1", "1-1"] },
];

const BOARD = { cols: 2, rows: 2, stageW: 1000, stageH: 600 };

function stored(groups: Iterable<PieceGroup> = GROUPS, board = BOARD, updatedAt = 1000) {
  return serialiseSolveState({ groups, ...board, updatedAt });
}

/** The stored JSON, with one field replaced — for the rejection paths. */
function tampered(patch: Record<string, unknown>) {
  return JSON.stringify({ ...JSON.parse(stored()), ...patch });
}

function everyPiece(cols: number, rows: number): PieceGroup[] {
  const members: string[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) members.push(pieceId(r, c));
  return [{ id: 1, x: 0, y: 0, members }];
}

describe("solveStateKey", () => {
  it("namespaces by puzzle so two puzzles never share a state", () => {
    expect(solveStateKey("abc")).toBe("solve:abc");
    expect(solveStateKey("abc")).not.toBe(solveStateKey("abd"));
  });
});

describe("serialise/deserialise round trip", () => {
  it("restores positions and membership at the same stage size", () => {
    const back = deserialiseSolveState(stored(), BOARD);
    expect(back).toEqual([
      { id: 1, x: 100, y: 50, members: ["0-0", "1-0"] },
      { id: 2, x: 600, y: 300, members: ["0-1", "1-1"] },
    ]);
  });

  it("re-assigns group ids so a restored board never collides on one", () => {
    // The stored ids (4, 9) are whatever the solve session ended up with; the
    // board seeds a fresh model, so restored ids must be its own 1..n.
    const back = deserialiseSolveState(stored(), BOARD)!;
    expect(back.map((g) => g.id)).toEqual([1, 2]);
  });

  it("scales a state saved in a wide window into a narrow one", () => {
    // Stored relative to the stage, so a group half way across stays half way
    // across instead of restoring off-screen. See issue #12.
    const back = deserialiseSolveState(stored(GROUPS, BOARD), {
      ...BOARD,
      stageW: 500,
      stageH: 1200,
    })!;
    expect(back[0]).toMatchObject({ x: 50, y: 100 });
    expect(back[1]).toMatchObject({ x: 300, y: 600 });
  });

  it("keeps negative origins, which is where most groups sit", () => {
    // A group origin is the scattered corner minus the piece's solved corner, so
    // any group holding a piece from a right-hand column has a negative x.
    const groups: PieceGroup[] = [
      { id: 1, x: -80, y: -40, members: ["0-0", "0-1", "1-0", "1-1"] },
    ];
    const back = deserialiseSolveState(stored(groups), BOARD)!;
    expect(back[0]).toMatchObject({ x: -80, y: -40 });
  });

  it("rejects a state that was written against a degenerate stage", () => {
    // Unreachable through boardGeometry, which floors the stage at 360x520. Pinned
    // because the failure is quiet: dividing by 0 gives Infinity, JSON.stringify
    // writes that as null, and the finiteness guard on load is the only thing
    // between that and every group being placed at NaN.
    const back = deserialiseSolveState(stored(GROUPS, { ...BOARD, stageW: 0, stageH: 0 }), BOARD);
    expect(back).toBeNull();
  });

  it("writes the current format version and the given timestamp", () => {
    const raw = JSON.parse(stored(GROUPS, BOARD, 12345));
    expect(raw).toMatchObject({
      version: SOLVE_STATE_VERSION,
      cols: 2,
      rows: 2,
      updatedAt: 12345,
    });
  });

  it("writes positions as stage fractions, not pixels", () => {
    // Asserted on the stored bytes, not just round-tripped: making both sides
    // absolute would keep every round-trip test green while silently misreading
    // every `version: 1` entry already in a solver's browser.
    expect(JSON.parse(stored()).groups).toEqual([
      { x: 100 / 1000, y: 50 / 600, members: ["0-0", "1-0"] },
      { x: 600 / 1000, y: 300 / 600, members: ["0-1", "1-1"] },
    ]);
  });
});

describe("deserialiseSolveState rejects unusable state", () => {
  it("returns null when nothing is stored", () => {
    expect(deserialiseSolveState(null, BOARD)).toBeNull();
  });

  it("returns null for a value that is not JSON", () => {
    expect(deserialiseSolveState("{not json", BOARD)).toBeNull();
  });

  it("returns null for JSON that is not an object", () => {
    expect(deserialiseSolveState("42", BOARD)).toBeNull();
    expect(deserialiseSolveState("null", BOARD)).toBeNull();
  });

  it("returns null for an unknown format version", () => {
    expect(deserialiseSolveState(tampered({ version: SOLVE_STATE_VERSION + 1 }), BOARD)).toBeNull();
    expect(deserialiseSolveState(tampered({ version: undefined }), BOARD)).toBeNull();
  });

  it("returns null for a state saved with a different grid", () => {
    // What keeps a 12-piece state out of a 108-piece board.
    expect(deserialiseSolveState(stored(), { ...BOARD, cols: 3 })).toBeNull();
    expect(deserialiseSolveState(stored(), { ...BOARD, rows: 3 })).toBeNull();
  });

  it("returns null when groups is missing or not an array", () => {
    expect(deserialiseSolveState(tampered({ groups: undefined }), BOARD)).toBeNull();
    expect(deserialiseSolveState(tampered({ groups: {} }), BOARD)).toBeNull();
  });

  it("returns null when a group is not an object", () => {
    // Without this check the destructure throws instead of rejecting, and the
    // board never seeds at all — a blank board rather than a fresh scatter.
    for (const entry of [null, "0-0", 7, []]) {
      expect(deserialiseSolveState(tampered({ groups: [entry] }), BOARD)).toBeNull();
    }
  });

  it("returns null when a group position is not a finite number", () => {
    // Both axes: `null * stageH` is 0, so an unchecked y would silently park the
    // group against the top edge instead of rejecting the state.
    for (const bad of [null, "100", NaN, Infinity, undefined]) {
      expect(
        deserialiseSolveState(tampered({ groups: [{ x: bad, y: 0, members: ["0-0"] }] }), BOARD),
      ).toBeNull();
      expect(
        deserialiseSolveState(tampered({ groups: [{ x: 0, y: bad, members: ["0-0"] }] }), BOARD),
      ).toBeNull();
    }
  });

  it("returns null when members is not an array", () => {
    for (const members of ["0-0", 7, {}, undefined]) {
      expect(deserialiseSolveState(tampered({ groups: [{ x: 0, y: 0, members }] }), BOARD))
        .toBeNull();
    }
  });

  it("returns null when a member is not a string", () => {
    expect(
      deserialiseSolveState(
        tampered({ groups: [{ x: 0, y: 0, members: ["0-0", "0-1", "1-0", 3] }] }),
        BOARD,
      ),
    ).toBeNull();
  });

  it("returns null when a piece of the grid is missing", () => {
    expect(
      deserialiseSolveState(
        tampered({ groups: [{ x: 0, y: 0, members: ["0-0", "0-1", "1-0"] }] }),
        BOARD,
      ),
    ).toBeNull();
  });

  it("returns null when a piece appears in two groups", () => {
    expect(
      deserialiseSolveState(
        tampered({
          groups: [
            { x: 0, y: 0, members: ["0-0", "0-1", "1-0", "1-1"] },
            { x: 9, y: 9, members: ["0-0"] },
          ],
        }),
        BOARD,
      ),
    ).toBeNull();
  });

  it("returns null when a member is not a piece of this grid", () => {
    for (const bad of ["2-0", "0-2", "-1-0", "x-y", "0", ""]) {
      expect(
        deserialiseSolveState(
          tampered({ groups: [{ x: 0, y: 0, members: ["0-0", "0-1", "1-0", bad] }] }),
          BOARD,
        ),
      ).toBeNull();
    }
  });

  it("returns null when a group has no members at all", () => {
    expect(
      deserialiseSolveState(
        tampered({
          groups: [{ x: 0, y: 0, members: ["0-0", "0-1", "1-0", "1-1"] }, { x: 1, y: 1, members: [] }],
        }),
        BOARD,
      ),
    ).toBeNull();
  });

  it("accepts a full grid however the pieces are grouped", () => {
    const board = { cols: 4, rows: 3, stageW: 800, stageH: 600 };
    const back = deserialiseSolveState(
      serialiseSolveState({ groups: everyPiece(4, 3), ...board, updatedAt: 1 }),
      board,
    );
    expect(back).toHaveLength(1);
    expect(back![0].members).toHaveLength(12);
  });
});

describe("restoreSolveState", () => {
  /**
   * A real board: `boardGeometry` sizing, real jittered/tabbed piece extents from
   * `pieceBox`, real starting positions from `scatterGroups`. Needed because the
   * whole point of settling on restore is the piece bitmaps' extents, which the
   * fraction arithmetic alone cannot see.
   */
  function board(containerW: number, availableH: number, cols = 12, rows = 9) {
    const geo = boardGeometry({ containerW, availableH, aspect: 1200 / 800, cols, rows });
    const grid = generateEdges(cols, rows, 4242);
    const rects = new Map<string, Rect>();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        rects.set(pieceId(r, c), pieceBox(grid, r, c, geo.pieceW, geo.pieceH).rect);
      }
    }
    return {
      geo,
      cols,
      rows,
      stageW: geo.stageW,
      stageH: geo.stageH,
      rectOf: (id: string) => rects.get(id),
    };
  }

  /** Every member's bitmap lies inside the stage — "no group off the play area". */
  function expectAllOnStage(groups: PieceGroup[], b: ReturnType<typeof board>) {
    for (const g of groups) {
      for (const m of g.members) {
        const r = b.rectOf(m)!;
        expect(g.x + r.x).toBeGreaterThanOrEqual(-1e-9);
        expect(g.y + r.y).toBeGreaterThanOrEqual(-1e-9);
        expect(g.x + r.x + r.width).toBeLessThanOrEqual(b.stageW + 1e-9);
        expect(g.y + r.y + r.height).toBeLessThanOrEqual(b.stageH + 1e-9);
      }
    }
  }

  /** Half-solve the board: join each row into one group, then save it. */
  function halfSolved(b: ReturnType<typeof board>) {
    const scattered = scatterGroups({
      cols: b.cols,
      rows: b.rows,
      seed: 4242,
      stageW: b.stageW,
      stageH: b.stageH,
      rectOf: (id) => b.rectOf(id)!,
    });
    const rowGroups: PieceGroup[] = [];
    for (let r = 0; r < b.rows; r++) {
      const first = scattered[r * b.cols];
      rowGroups.push({
        id: r + 1,
        x: first.x,
        y: first.y,
        members: Array.from({ length: b.cols }, (_, c) => pieceId(r, c)),
      });
    }
    return rowGroups;
  }

  it("keeps every group on the board when the window is much narrower", () => {
    // The acceptance criterion from issue #12: "A state saved at one window width
    // restores correctly at another; no group ends up outside the play area."
    const wide = board(2400, 1190);
    const narrow = board(380, 490);
    const raw = serialiseSolveState({
      groups: halfSolved(wide),
      cols: wide.cols,
      rows: wide.rows,
      stageW: wide.stageW,
      stageH: wide.stageH,
      updatedAt: 1,
    });

    const back = restoreSolveState(raw, narrow, narrow.rectOf)!;

    expect(back).toHaveLength(9);
    expectAllOnStage(back, narrow);
  });

  it("keeps every group on the board when the window is much wider", () => {
    const narrow = board(380, 490);
    const wide = board(2400, 1190);
    const raw = serialiseSolveState({
      groups: halfSolved(narrow),
      cols: narrow.cols,
      rows: narrow.rows,
      stageW: narrow.stageW,
      stageH: narrow.stageH,
      updatedAt: 1,
    });

    const back = restoreSolveState(raw, wide, wide.rectOf)!;

    expectAllOnStage(back, wide);
  });

  it("loses no piece and duplicates none across the rescale", () => {
    const wide = board(2400, 1190);
    const narrow = board(380, 490);
    const raw = serialiseSolveState({
      groups: halfSolved(wide),
      cols: wide.cols,
      rows: wide.rows,
      stageW: wide.stageW,
      stageH: wide.stageH,
      updatedAt: 1,
    });

    const members = restoreSolveState(raw, narrow, narrow.rectOf)!.flatMap((g) => g.members);

    expect(members).toHaveLength(narrow.cols * narrow.rows);
    expect(new Set(members).size).toBe(narrow.cols * narrow.rows);
  });

  it("leaves a group that already fits exactly where it is", () => {
    // Settling must be a clamp, not a re-layout: reloading in an unchanged window
    // has to give the solver their arrangement back untouched. Restoring twice is
    // what makes that testable — the first pass produces positions known to fit,
    // so any drift on the second is the clamp moving something it should not.
    const b = board(1400, 790);
    const save = (groups: PieceGroup[]) =>
      serialiseSolveState({
        groups,
        cols: b.cols,
        rows: b.rows,
        stageW: b.stageW,
        stageH: b.stageH,
        updatedAt: 1,
      });

    const once = restoreSolveState(save(halfSolved(b)), b, b.rectOf)!;
    const twice = restoreSolveState(save(once), b, b.rectOf)!;

    for (const [i, g] of twice.entries()) {
      expect(g.x).toBeCloseTo(once[i].x, 6);
      expect(g.y).toBeCloseTo(once[i].y, 6);
    }
  });

  it("returns null for a state it cannot use, so the caller scatters", () => {
    const b = board(1400, 790);
    expect(restoreSolveState(null, b, b.rectOf)).toBeNull();
    expect(restoreSolveState("{not json", b, b.rectOf)).toBeNull();
  });
});

describe("the solve timing", () => {
  it("round-trips with the state", () => {
    const raw = serialiseSolveState({
      groups: GROUPS,
      ...BOARD,
      updatedAt: 1000,
      timing: { elapsedMs: 83_500, moves: 17 },
    });
    expect(readSolveTiming(raw)).toEqual({ elapsedMs: 83_500, moves: 17 });
    // …without getting in the way of the pieces.
    expect(deserialiseSolveState(raw, BOARD)).toHaveLength(2);
  });

  it("reads an entry from before the timer as zero", () => {
    const older = JSON.parse(stored());
    delete older.elapsedMs;
    delete older.moves;
    const raw = JSON.stringify(older);
    expect(readSolveTiming(raw)).toEqual({ elapsedMs: 0, moves: 0 });
    // Still restorable: the fields were added without a version bump.
    expect(deserialiseSolveState(raw, BOARD)).toHaveLength(2);
  });

  it.each([
    ["a negative time", { elapsedMs: -5, moves: 3 }, { elapsedMs: 0, moves: 3 }],
    ["a fractional move count", { elapsedMs: 10, moves: 1.5 }, { elapsedMs: 10, moves: 0 }],
    ["strings", { elapsedMs: "10", moves: "3" }, { elapsedMs: 0, moves: 0 }],
  ])("zeroes %s field by field", (_, patch, expected) => {
    expect(readSolveTiming(tampered(patch))).toEqual(expected);
  });

  it.each([null, "", "{nope", "null"])("reads %j as zero", (raw) => {
    expect(readSolveTiming(raw)).toEqual({ elapsedMs: 0, moves: 0 });
  });
});

describe("solveKeysToPrune", () => {
  function entry(key: string, updatedAt: number) {
    return { key, raw: JSON.stringify({ version: SOLVE_STATE_VERSION, updatedAt }) };
  }

  it("returns nothing while the number of entries is within the cap", () => {
    const entries = [entry("solve:a", 3), entry("solve:b", 1), entry("solve:c", 2)];
    expect(solveKeysToPrune(entries, "solve:a", 3)).toEqual([]);
  });

  it("drops the least recently updated entries beyond the cap", () => {
    const entries = [entry("solve:a", 30), entry("solve:b", 10), entry("solve:c", 20)];
    expect(solveKeysToPrune(entries, "solve:a", 2)).toEqual(["solve:b"]);
  });

  it("never drops the entry about to be written, however old it is", () => {
    const entries = [entry("solve:old", 1), entry("solve:b", 20), entry("solve:c", 30)];
    expect(solveKeysToPrune(entries, "solve:old", 2)).toEqual(["solve:b"]);
  });

  it("counts the entry about to be written even when it is not stored yet", () => {
    const entries = [entry("solve:a", 10), entry("solve:b", 20)];
    expect(solveKeysToPrune(entries, "solve:new", 2)).toEqual(["solve:a"]);
  });

  it("drops entries it cannot read first, before any readable one", () => {
    const entries = [
      { key: "solve:junk", raw: "{not json" },
      { key: "solve:noTime", raw: JSON.stringify({ version: SOLVE_STATE_VERSION }) },
      { key: "solve:empty", raw: null },
      entry("solve:old", 0), // the oldest possible real stamp still beats unreadable
    ];
    expect(solveKeysToPrune(entries, "solve:new", 2).sort()).toEqual([
      "solve:empty",
      "solve:junk",
      "solve:noTime",
    ]);
  });

  it("drops an entry of a foreign format version before any usable one", () => {
    // It could never be restored, so ranking it by recency would let it evict an
    // older entry that still works.
    const entries = [
      { key: "solve:future", raw: JSON.stringify({ version: 99, updatedAt: 9999 }) },
      entry("solve:usable", 1),
    ];
    expect(solveKeysToPrune(entries, "solve:new", 2)).toEqual(["solve:future"]);
  });

  it("drops everything but the entry being written when the cap is one", () => {
    const entries = [entry("solve:a", 10), entry("solve:b", 20)];
    expect(solveKeysToPrune(entries, "solve:new", 1).sort()).toEqual(["solve:a", "solve:b"]);
  });

  it("keeps the real cap at MAX_STORED_SOLVES entries in total", () => {
    // 19 others survive alongside the one being written.
    const entries = Array.from({ length: 40 }, (_, i) => entry(`solve:p-${i}`, i));
    const pruned = solveKeysToPrune(entries, "solve:new", MAX_STORED_SOLVES);
    expect(entries.length - pruned.length).toBe(MAX_STORED_SOLVES - 1);
    expect(pruned).toContain("solve:p-0");
    expect(pruned).not.toContain("solve:p-39");
  });
});
