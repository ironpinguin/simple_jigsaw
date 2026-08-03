import { describe, it, expect } from "vitest";
import { pieceId, type PieceGroup } from "./groups";
import {
  SOLVE_STATE_VERSION,
  deserialiseSolveState,
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

  it("survives a stage of zero width without producing NaN", () => {
    // boardGeometry floors the stage at 360x520, but a divide-by-zero here would
    // corrupt every position instead of being rejected, so pin the behaviour.
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

  it("returns null when a group position is not a finite number", () => {
    for (const x of [null, "100", NaN, Infinity]) {
      expect(deserialiseSolveState(tampered({ groups: [{ x, y: 0, members: ["0-0"] }] }), BOARD))
        .toBeNull();
    }
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
      entry("solve:old", 1),
    ];
    expect(solveKeysToPrune(entries, "solve:new", 2).sort()).toEqual([
      "solve:junk",
      "solve:noTime",
    ]);
  });
});
