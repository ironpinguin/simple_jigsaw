import { describe, it, expect } from "vitest";
import { generateEdges } from "./edges";
import { computeGrid, PIECE_PRESETS } from "./grid";
import { pieceOutlinePoints } from "./outline";
import { renderOrder, resolveConnections, pieceId, type PieceGroup } from "./groups";
import {
  boardGeometry,
  clampGroupPosition,
  gatherLoose,
  groupExtent,
  PIECE_PAD,
  pieceBox,
  scatterGroups,
  settleGroup,
  unionRect,
  type Rect,
} from "./board";

const STAGE = { containerW: 1400, availableH: 870, aspect: 4 / 3 };

describe("boardGeometry", () => {
  it("keeps the assembled picture well inside the stage", () => {
    // clampGroupPosition pins (and freezes) a group too large for the stage.
    // These bounds are what makes that branch unreachable in the real app.
    for (const containerW of [320, 768, 1400, 2560]) {
      for (const availableH of [290, 510, 690, 1230]) {
        for (const aspect of [3 / 4, 1, 4 / 3, 16 / 9]) {
          for (const preset of PIECE_PRESETS) {
            const { cols, rows } = computeGrid(preset, aspect);
            const g = boardGeometry({ containerW, availableH, aspect, cols, rows });
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
    const g = boardGeometry({ containerW: 100, availableH: 90, aspect: 1, cols: 4, rows: 3 });
    expect(g.stageW).toBe(360);
    expect(g.stageH).toBe(520);
  });

  it("caps the picture's height for a tall image instead of overflowing", () => {
    const tall = boardGeometry({ containerW: 4000, availableH: 870, aspect: 1 / 2, cols: 4, rows: 3 });
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

/** A real board: stage sizing plus the real jittered/tabbed bitmap rects. */
function board(cols: number, rows: number, stage = STAGE, edgeSeed = 777) {
  const g = boardGeometry({ ...stage, cols, rows });
  const grid = generateEdges(cols, rows, edgeSeed);
  const rects = new Map<string, Rect>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      rects.set(pieceId(r, c), pieceBox(grid, r, c, g.pieceW, g.pieceH).rect);
    }
  }
  return {
    cols,
    rows,
    stageW: g.stageW,
    stageH: g.stageH,
    rectOf: (id: string) => rects.get(id)!,
  };
}

/** Every piece's bitmap in stage coordinates, in draw order (last on top). */
function stageRects(groups: PieceGroup[], rectOf: (id: string) => Rect): Rect[] {
  return renderOrder(groups).map((g) => {
    const r = rectOf(g.members[0]);
    return { x: g.x + r.x, y: g.y + r.y, width: r.width, height: r.height };
  });
}

/**
 * Share of each rect not covered by anything drawn above it, sampled on an
 * n x n lattice. Konva hit-tests an Image as its whole rect, so this is the
 * share of the piece a click can still reach.
 */
function grabbableShares(rects: Rect[], n = 8): number[] {
  const inside = (r: Rect, x: number, y: number) =>
    x > r.x && x < r.x + r.width && y > r.y && y < r.y + r.height;
  return rects.map((r, i) => {
    let free = 0;
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        const x = r.x + ((a + 0.5) / n) * r.width;
        const y = r.y + ((b + 0.5) / n) * r.height;
        if (!rects.slice(i + 1).some((o) => inside(o, x, y))) free++;
      }
    }
    return free / (n * n);
  });
}

describe("scatterGroups", () => {
  it("creates exactly one single-piece group per cell, covering every id once", () => {
    // Regression guard for issue #1: a piece id falling out of the group model
    // would render as a permanently invisible piece.
    for (const [cols, rows] of [
      [4, 3],
      [8, 6],
      [20, 15],
    ] as const) {
      const groups = scatterGroups({ ...board(cols, rows), seed: 12345 });

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
    const args = board(8, 6);
    expect(scatterGroups({ ...args, seed: 42 })).toEqual(scatterGroups({ ...args, seed: 42 }));
    expect(scatterGroups({ ...args, seed: 42 })).not.toEqual(scatterGroups({ ...args, seed: 43 }));
  });

  it("starts every piece's whole bitmap inside the stage", () => {
    // The exact bitmap, not a nominal cell-plus-tab box: nothing should shift
    // on its first drop because it started past the edge.
    for (const containerW of [320, 1400, 2560]) {
      for (const availableH of [290, 870, 1230]) {
        const args = board(20, 15, { containerW, availableH, aspect: 4 / 3 });
        for (const r of stageRects(scatterGroups({ ...args, seed: 999 }), args.rectOf)) {
          expect(r.x).toBeGreaterThanOrEqual(-1e-9);
          expect(r.y).toBeGreaterThanOrEqual(-1e-9);
          expect(r.x + r.width).toBeLessThanOrEqual(args.stageW + 1e-9);
          expect(r.y + r.height).toBeLessThanOrEqual(args.stageH + 1e-9);
        }
      }
    }
  });

  it("leaves no piece without grabbable area, even at 300 pieces", () => {
    // The acceptance criterion from issue #3: uniform random placement left up
    // to two pieces per board entirely under others at 300 pieces on 1440x900.
    // Checked down to the minimum stage, where slots are smaller than bitmaps.
    for (const [containerW, availableH] of [
      [320, 290],
      [768, 510],
      [1440, 900],
      [1920, 1080],
    ]) {
      for (const aspect of [3 / 4, 4 / 3, 16 / 9]) {
        const { cols, rows } = computeGrid(300, aspect);
        const args = board(cols, rows, { containerW, availableH, aspect });
        for (const seed of [1, 42, 999, 2024, 31337]) {
          const shares = grabbableShares(stageRects(scatterGroups({ ...args, seed }), args.rectOf));
          expect(Math.min(...shares)).toBeGreaterThan(0.5);
        }
      }
    }
  });

  it("does not overlap bitmaps at all on a desktop-sized window", () => {
    for (const [containerW, availableH] of [
      [1440, 900],
      [1920, 1080],
    ]) {
      for (const preset of PIECE_PRESETS) {
        const { cols, rows } = computeGrid(preset, 4 / 3);
        const args = board(cols, rows, { containerW, availableH, aspect: 4 / 3 });
        const shares = grabbableShares(stageRects(scatterGroups({ ...args, seed: 7 }), args.rectOf));
        expect(shares.every((s) => s === 1)).toBe(true);
      }
    }
  });
});

describe("gatherLoose", () => {
  /** Scatter a real board, then join the first `joinRows` rows into assemblies. */
  function partlySolved(cols: number, rows: number, joinRows: number, stage = STAGE) {
    const b = board(cols, rows, stage);
    const scattered = scatterGroups({ ...b, seed: 4242 });
    const groups: PieceGroup[] = [];
    for (let r = 0; r < rows; r++) {
      if (r < joinRows) {
        // Park each assembled row in the middle band so it cuts across the stage.
        groups.push({
          id: 1000 + r,
          x: b.stageW * 0.3,
          y: b.stageH * 0.2 + r * 3,
          members: Array.from({ length: cols }, (_, c) => pieceId(r, c)),
        });
      } else {
        groups.push(...scattered.slice(r * cols, (r + 1) * cols));
      }
    }
    return { b, groups };
  }

  function stageRect(g: PieceGroup, rectOf: (id: string) => Rect): Rect {
    const e = groupExtent(g.members, rectOf)!;
    return { ...e, x: g.x + e.x, y: g.y + e.y };
  }
  const overlap = (a: Rect, b: Rect) =>
    a.x < b.x + b.width - 1e-9 &&
    b.x < a.x + a.width - 1e-9 &&
    a.y < b.y + b.height - 1e-9 &&
    b.y < a.y + a.height - 1e-9;

  it("moves every loose piece and nothing else, without touching its input", () => {
    const { b, groups } = partlySolved(8, 6, 2);
    const before = structuredClone(groups);
    const moved = gatherLoose({ groups, ...b });

    expect(groups).toEqual(before);
    const loose = groups.filter((g) => g.members.length === 1);
    expect(moved.map((g) => g.id).sort()).toEqual(loose.map((g) => g.id).sort());
    for (const g of moved) {
      expect(g.members).toEqual(loose.find((l) => l.id === g.id)!.members);
    }
  });

  it("collects the loose pieces clear of the assemblies and of each other", () => {
    for (const [containerW, availableH] of [
      [1440, 900],
      [1920, 1080],
    ]) {
      const { b, groups } = partlySolved(12, 9, 3, { containerW, availableH, aspect: 4 / 3 });
      const assemblies = groups.filter((g) => g.members.length > 1).map((g) => stageRect(g, b.rectOf));
      const gathered = gatherLoose({ groups, ...b }).map((g) => stageRect(g, b.rectOf));

      for (const [i, r] of gathered.entries()) {
        expect(r.x).toBeGreaterThanOrEqual(-1e-9);
        expect(r.y).toBeGreaterThanOrEqual(-1e-9);
        expect(r.x + r.width).toBeLessThanOrEqual(b.stageW + 1e-9);
        expect(r.y + r.height).toBeLessThanOrEqual(b.stageH + 1e-9);
        for (const a of assemblies) expect(overlap(r, a)).toBe(false);
        for (const o of gathered.slice(i + 1)) expect(overlap(r, o)).toBe(false);
      }
    }
  });

  it("is idempotent: gathering already gathered pieces moves nothing", () => {
    const { b, groups } = partlySolved(8, 6, 2);
    const once = gatherLoose({ groups, ...b });
    const byId = new Map(once.map((g) => [g.id, g]));
    const again = gatherLoose({ groups: groups.map((g) => byId.get(g.id) ?? g), ...b });
    expect(again).toEqual(once);
  });

  it("stays idempotent when the slots have to shrink below the bitmap size", () => {
    // Enough loose pieces that bitmap-sized slots run out: the top and bottom
    // rows then overhang the stage and are pulled back in by the clamp.
    const { cols, rows } = computeGrid(300, 4 / 3);
    for (const stage of [
      { containerW: 1440, availableH: 900, aspect: 4 / 3 },
      { containerW: 1024, availableH: 700, aspect: 4 / 3 },
      { containerW: 320, availableH: 290, aspect: 4 / 3 },
    ]) {
      const { b, groups } = partlySolved(cols, rows, 2, stage);
      const once = gatherLoose({ groups, ...b });
      const byId = new Map(once.map((g) => [g.id, g]));
      const again = gatherLoose({ groups: groups.map((g) => byId.get(g.id) ?? g), ...b });
      expect(again).toEqual(once);
    }
  });

  it("keeps whole bitmaps clear of the assemblies when the slots shrink", () => {
    // Uniform 100px bitmaps on a 1000px stage: 10 x 10 at full size, too few for
    // 130 loose pieces next to a 2 x 2 assembly, so the slots must shrink — yet
    // there is still room for all of them in the free area.
    const rectOf = (id: string): Rect => {
      const [r, c] = id.split("-").map(Number);
      return { x: c * 80 - 10, y: r * 80 - 10, width: 100, height: 100 };
    };
    const loose: PieceGroup[] = Array.from({ length: 130 }, (_, i) => ({
      id: 2 + i,
      x: (i * 37) % 800,
      y: (i * 53) % 800,
      members: [pieceId(10, i)],
    }));
    const b = { stageW: 1000, stageH: 1000, rectOf };
    // Slide the assembly so its edges meet the shrunken slot grid at every phase.
    for (let at = 380; at < 480; at += 7) {
      const assembly: PieceGroup = { id: 1, x: at, y: at, members: ["0-0", "0-1", "1-0", "1-1"] };
      const groups = [assembly, ...loose];
      const moved = gatherLoose({ groups, ...b });
      expect(moved.length).toBe(loose.length);

      const a = stageRect(assembly, rectOf);
      for (const g of moved) {
        const r = stageRect(g, rectOf);
        expect(overlap(r, a)).toBe(false);
        expect(r.x).toBeGreaterThanOrEqual(-1e-9);
        expect(r.y).toBeGreaterThanOrEqual(-1e-9);
        expect(r.x + r.width).toBeLessThanOrEqual(1000 + 1e-9);
        expect(r.y + r.height).toBeLessThanOrEqual(1000 + 1e-9);
      }
      // Shrunken slots do pack neighbours closer than a bitmap apart.
      const xs = [...new Set(moved.map((g) => Math.round(stageRect(g, rectOf).x)))].sort((p, q) => p - q);
      expect(xs[1] - xs[0]).toBeLessThan(100);

      const byId = new Map(moved.map((g) => [g.id, g]));
      const again = gatherLoose({ groups: groups.map((g) => byId.get(g.id) ?? g), ...b });
      expect(again).toEqual(moved);
    }
  });

  it("has nothing to do once no piece is loose", () => {
    const { b, groups } = partlySolved(4, 3, 3);
    expect(gatherLoose({ groups, ...b })).toEqual([]);
  });

  it("still keeps every piece on the stage and grabbable when the free area is too small", () => {
    // 300 pieces on the minimum stage: bitmap-sized slots cannot all fit, so the
    // slots shrink and may spill over the assemblies.
    const { cols, rows } = computeGrid(300, 4 / 3);
    const { b, groups } = partlySolved(cols, rows, 2, { containerW: 320, availableH: 290, aspect: 4 / 3 });
    const moved = gatherLoose({ groups, ...b });
    expect(moved.length).toBe(groups.filter((g) => g.members.length === 1).length);

    const byId = new Map(moved.map((g) => [g.id, g]));
    const after = groups.map((g) => byId.get(g.id) ?? g);
    const rects = stageRects(
      after.filter((g) => g.members.length === 1),
      b.rectOf,
    );
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.width).toBeLessThanOrEqual(b.stageW + 1e-9);
      expect(r.y + r.height).toBeLessThanOrEqual(b.stageH + 1e-9);
    }
    expect(Math.min(...grabbableShares(rects))).toBeGreaterThan(0);
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
