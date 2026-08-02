import { describe, it, expect } from "vitest";
import { generateEdges } from "./edges";
import { computeGrid, PIECE_PRESETS } from "./grid";
import { pieceOutlinePoints } from "./outline";
import { parsePieceId, resolveConnections, pieceId, type PieceGroup } from "./groups";
import {
  boardGeometry,
  clampGroupPosition,
  groupExtent,
  PIECE_PAD,
  pieceBox,
  scatterGroups,
  settleGroup,
  unionRect,
  type Rect,
} from "./board";

const STAGE = { containerW: 1400, viewportH: 1080, aspect: 4 / 3 };

describe("boardGeometry", () => {
  it("keeps the assembled picture well inside the stage", () => {
    // clampGroupPosition pins (and freezes) a group too large for the stage.
    // These bounds are what makes that branch unreachable in the real app.
    for (const containerW of [320, 768, 1400, 2560]) {
      for (const viewportH of [500, 720, 900, 1440]) {
        for (const aspect of [3 / 4, 1, 4 / 3, 16 / 9]) {
          for (const preset of PIECE_PRESETS) {
            const { cols, rows } = computeGrid(preset, aspect);
            const g = boardGeometry({ containerW, viewportH, aspect, cols, rows });
            expect(g.boardW).toBeLessThan(g.stageW);
            expect(g.boardH).toBeLessThan(g.stageH);
            expect(g.pieceW).toBeGreaterThan(0);
            expect(g.pieceH).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("enforces a minimum stage even in a tiny window", () => {
    const g = boardGeometry({ containerW: 100, viewportH: 300, aspect: 1, cols: 4, rows: 3 });
    expect(g.stageW).toBe(360);
    expect(g.stageH).toBe(520);
  });

  it("caps the picture's height for a tall image instead of overflowing", () => {
    const tall = boardGeometry({ containerW: 4000, viewportH: 1080, aspect: 1 / 2, cols: 4, rows: 3 });
    expect(tall.boardH).toBeLessThanOrEqual(460);
    // width follows from the cap, so the aspect ratio is preserved
    expect(tall.boardW / tall.boardH).toBeCloseTo(1 / 2, 6);
  });

  it("derives snapDist from the smaller piece dimension", () => {
    const g = boardGeometry({ ...STAGE, cols: 4, rows: 3 });
    expect(g.snapDist).toBeCloseTo(Math.max(18, 0.4 * Math.min(g.pieceW, g.pieceH)), 6);
  });
});

describe("pieceBox", () => {
  const grid = generateEdges(4, 3, 777);
  const pieceW = 100;
  const pieceH = 80;

  it("fits the whole outline inside the bitmap with the padding intact", () => {
    // The strong property: every outline point must land at least PIECE_PAD away
    // from each bitmap edge. This is what pins offsetX/offsetY and the padding —
    // asserting only that the canvas is "bigger than the cell" does not.
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        const box = pieceBox(grid, r, c, pieceW, pieceH);
        for (const p of pieceOutlinePoints(grid, r, c, pieceW, pieceH)) {
          expect(box.offsetX + p.x).toBeGreaterThanOrEqual(PIECE_PAD - 1e-9);
          expect(box.offsetY + p.y).toBeGreaterThanOrEqual(PIECE_PAD - 1e-9);
          expect(box.offsetX + p.x).toBeLessThanOrEqual(box.canvasW - PIECE_PAD + 1e-9);
          expect(box.offsetY + p.y).toBeLessThanOrEqual(box.canvasH - PIECE_PAD + 1e-9);
        }
      }
    }
  });

  it("needs more room than the regular cell for a tabbed interior piece", () => {
    const box = pieceBox(grid, 1, 1, pieceW, pieceH);
    expect(box.canvasW).toBeGreaterThan(pieceW);
    expect(box.canvasH).toBeGreaterThan(pieceH);
  });

  it("gives the bitmap an integral size so it can back a canvas", () => {
    const box = pieceBox(grid, 1, 2, pieceW, pieceH);
    expect(Number.isInteger(box.canvasW)).toBe(true);
    expect(Number.isInteger(box.canvasH)).toBe(true);
  });

  it("places the rect where the KImage is drawn, at the solved cell", () => {
    // PuzzleBoard draws each piece at (solvedX, solvedY) with (offsetX, offsetY)
    // as the Konva offset, so this must match or the hit area and the clamp
    // would disagree with what the user sees.
    const box = pieceBox(grid, 2, 3, pieceW, pieceH);
    expect(box.rect.x).toBeCloseTo(3 * pieceW - box.offsetX, 6);
    expect(box.rect.y).toBeCloseTo(2 * pieceH - box.offsetY, 6);
    expect(box.rect.width).toBe(box.canvasW);
    expect(box.rect.height).toBe(box.canvasH);
  });
});

describe("scatterGroups", () => {
  function geo(cols: number, rows: number) {
    const g = boardGeometry({ ...STAGE, cols, rows });
    return { cols, rows, pieceW: g.pieceW, pieceH: g.pieceH, stageW: g.stageW, stageH: g.stageH };
  }

  it("creates exactly one single-piece group per cell, covering every id once", () => {
    // Regression guard for issue #1: a piece id falling out of the group model
    // would render as a permanently invisible piece.
    for (const [cols, rows] of [
      [4, 3],
      [8, 6],
      [20, 15],
    ] as const) {
      const groups = scatterGroups({ ...geo(cols, rows), seed: 12345 });

      expect(groups.length).toBe(cols * rows);
      const members = groups.flatMap((g) => g.members);
      expect(members.length).toBe(cols * rows);

      const expected: string[] = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) expected.push(pieceId(r, c));
      expect([...members].sort()).toEqual([...expected].sort());

      expect(new Set(groups.map((g) => g.id)).size).toBe(groups.length);
    }
  });

  it("is deterministic for a seed and differs between seeds", () => {
    const args = geo(8, 6);
    expect(scatterGroups({ ...args, seed: 42 })).toEqual(scatterGroups({ ...args, seed: 42 }));
    expect(scatterGroups({ ...args, seed: 42 })).not.toEqual(scatterGroups({ ...args, seed: 43 }));
  });

  it("starts every piece's cell inside the stage", () => {
    // The cell, not the bitmap: the margins use a nominal cell-plus-tab box, so
    // a small fraction of bitmaps overhang by a few px until first drop. See the
    // note on scatterGroups and issue #3.
    const args = geo(20, 15);
    for (const g of scatterGroups({ ...args, seed: 999 })) {
      const { row, col } = parsePieceId(g.members[0]);
      const cornerX = g.x + col * args.pieceW;
      const cornerY = g.y + row * args.pieceH;
      expect(cornerX).toBeGreaterThanOrEqual(0);
      expect(cornerY).toBeGreaterThanOrEqual(0);
      expect(cornerX + args.pieceW).toBeLessThanOrEqual(args.stageW);
      expect(cornerY + args.pieceH).toBeLessThanOrEqual(args.stageH);
    }
  });
});

describe("unionRect", () => {
  it("spans all input rects", () => {
    expect(
      unionRect([
        { x: 10, y: 20, width: 30, height: 40 },
        { x: -5, y: 25, width: 10, height: 10 },
      ]),
    ).toEqual({ x: -5, y: 20, width: 45, height: 40 });
  });

  it("reports no answer for no input rather than inventing a zero rect", () => {
    // A zero rect would read to clampGroupPosition as "keep the origin inside the
    // stage" and silently haul the group to the top-left corner.
    expect(unionRect([])).toBeNull();
  });
});

describe("groupExtent", () => {
  const rects = new Map<string, Rect>([
    ["0-0", { x: 0, y: 0, width: 50, height: 50 }],
    ["0-1", { x: 40, y: 0, width: 50, height: 50 }],
  ]);
  const rectOf = (id: string) => rects.get(id);

  it("spans the members it can resolve", () => {
    expect(groupExtent(["0-0", "0-1"], rectOf)).toEqual({ x: 0, y: 0, width: 90, height: 50 });
  });

  it("skips members the layout does not know", () => {
    expect(groupExtent(["0-0", "9-9"], rectOf)).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  it("reports no extent when nothing resolves", () => {
    expect(groupExtent(["9-9", "8-8"], rectOf)).toBeNull();
  });
});

describe("clampGroupPosition", () => {
  // A group whose extent reaches 20px left and 10px above its own origin.
  const extent: Rect = { x: -20, y: -10, width: 200, height: 100 };
  const stageW = 1000;
  const stageH = 500;

  it("leaves a position that is fully inside untouched", () => {
    const pos = { x: 300, y: 200 };
    expect(clampGroupPosition(pos, extent, stageW, stageH)).toEqual(pos);
  });

  it("stops the group escaping past the left and top edges", () => {
    const c = clampGroupPosition({ x: -500, y: -500 }, extent, stageW, stageH);
    expect(c.x + extent.x).toBeCloseTo(0, 6);
    expect(c.y + extent.y).toBeCloseTo(0, 6);
  });

  it("stops the group escaping past the right and bottom edges", () => {
    const c = clampGroupPosition({ x: 5000, y: 5000 }, extent, stageW, stageH);
    expect(c.x + extent.x + extent.width).toBeCloseTo(stageW, 6);
    expect(c.y + extent.y + extent.height).toBeCloseTo(stageH, 6);
  });

  it("pins a group larger than the stage to the near edge", () => {
    // Unreachable via boardGeometry (see its own test); kept as a guard.
    const huge: Rect = { x: 0, y: 0, width: stageW + 300, height: stageH + 300 };
    const c = clampGroupPosition({ x: 400, y: 400 }, huge, stageW, stageH);
    expect(c.x).toBeCloseTo(0, 6);
    expect(c.y).toBeCloseTo(0, 6);
  });

  it("always returns a position whose whole extent is inside the stage", () => {
    for (const pos of [
      { x: -1e6, y: 0 },
      { x: 1e6, y: 0 },
      { x: 0, y: -1e6 },
      { x: 0, y: 1e6 },
      { x: 12.5, y: 480.25 },
    ]) {
      const c = clampGroupPosition(pos, extent, stageW, stageH);
      expect(c.x + extent.x).toBeGreaterThanOrEqual(-1e-9);
      expect(c.y + extent.y).toBeGreaterThanOrEqual(-1e-9);
      expect(c.x + extent.x + extent.width).toBeLessThanOrEqual(stageW + 1e-9);
      expect(c.y + extent.y + extent.height).toBeLessThanOrEqual(stageH + 1e-9);
    }
  });
});

describe("settleGroup", () => {
  const cols = 8;
  const rows = 6;
  const g = boardGeometry({ ...STAGE, cols, rows });
  const grid = generateEdges(cols, rows, 4242);
  const rects = new Map<string, Rect>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      rects.set(pieceId(r, c), pieceBox(grid, r, c, g.pieceW, g.pieceH).rect);
    }
  }
  const rectOf = (id: string) => rects.get(id);

  /**
   * Settle `group` and assert the answer puts every member's bitmap inside the
   * stage — the property both tests below are really about.
   */
  function expectSettledOnStage(group: PieceGroup): void {
    const at = settleGroup(group, rectOf, g.stageW, g.stageH);
    expect(at).not.toBeNull();
    const { x, y } = at!;
    for (const m of group.members) {
      const r = rectOf(m)!;
      expect(x + r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(y + r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(x + r.x + r.width).toBeLessThanOrEqual(g.stageW + 1e-9);
      expect(y + r.y + r.height).toBeLessThanOrEqual(g.stageH + 1e-9);
    }
  }

  it("brings a group dropped far off the board fully back on, from any direction", () => {
    for (const [dx, dy] of [
      [-9999, -9999],
      [9999, 9999],
      [9999, -9999],
      [-9999, 9999],
    ] as const) {
      const group: PieceGroup = {
        id: 1,
        x: dx,
        y: dy,
        members: [pieceId(1, 1), pieceId(1, 2), pieceId(2, 1), pieceId(2, 2)],
      };
      expectSettledOnStage(group);
    }
  });

  it("leaves a group that is already fully on the board where it is", () => {
    const group: PieceGroup = { id: 1, x: 300, y: 200, members: [pieceId(0, 0), pieceId(0, 1)] };
    expect(settleGroup(group, rectOf, g.stageW, g.stageH)).toEqual({ x: 300, y: 200 });
  });

  it("leaves the position alone when no member resolves", () => {
    const group: PieceGroup = { id: 1, x: -9999, y: -9999, members: ["99-99"] };
    expect(settleGroup(group, rectOf, g.stageW, g.stageH)).toBeNull();
  });

  it("lets a piece attach to a neighbour parked flush against an edge", () => {
    // The regression this replaced a drag-time clamp to fix: piece (0,c) pushed
    // flush left sits at an origin its left neighbour could never reach while
    // staying on the board, because the two connect at a shared origin further
    // out still. Dragging is therefore unbounded and the *drop* is settled —
    // which must leave both pieces on the board.
    for (const c of [1, 2, 3, cols - 1]) {
      const bId = pieceId(0, c);
      const aId = pieceId(0, c - 1);
      // B parked flush against the left edge.
      const bFlush = -rectOf(bId)!.x;
      const groups = new Map<number, PieceGroup>([
        [1, { id: 1, x: bFlush, y: 100, members: [bId] }],
        [2, { id: 2, x: bFlush, y: 100, members: [aId] }], // A dragged onto B's origin
      ]);
      const p2g = new Map<string, number>([
        [bId, 1],
        [aId, 2],
      ]);

      const { survivorId, changed } = resolveConnections(groups, p2g, 2, rows, cols, g.snapDist);
      expect(changed).toBe(true);
      expect(groups.size).toBe(1);

      const survivor = groups.get(survivorId)!;
      expect(survivor.members.sort()).toEqual([aId, bId].sort());
      expectSettledOnStage(survivor);
    }
  });
});
