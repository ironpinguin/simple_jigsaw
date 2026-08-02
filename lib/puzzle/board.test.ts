import { describe, it, expect } from "vitest";
import { generateEdges } from "./edges";
import {
  clampGroupPosition,
  pieceBox,
  scatterGroups,
  unionRect,
  type Rect,
} from "./board";

const STAGE = { stageW: 1400, stageH: 870 };

/** The geometry buildLayout() derives for a 4:3 image on `STAGE`. */
function geometry(cols: number, rows: number) {
  const boardW = Math.min(STAGE.stageW * 0.4, (4 / 3) * Math.min(460, STAGE.stageH * 0.6));
  const boardH = boardW / (4 / 3);
  return { pieceW: boardW / cols, pieceH: boardH / rows };
}

describe("pieceBox", () => {
  const grid = generateEdges(4, 3, 777);
  const pieceW = 100;
  const pieceH = 80;

  it("sizes the canvas to hold the whole outline plus padding", () => {
    const box = pieceBox(grid, 1, 1, pieceW, pieceH);
    // An interior piece has tabs, so it must exceed its regular cell.
    expect(box.canvasW).toBeGreaterThan(pieceW);
    expect(box.canvasH).toBeGreaterThan(pieceH);
    // The rect is the canvas placed so local (0,0) lands on the offset.
    expect(box.rect.width).toBe(box.canvasW);
    expect(box.rect.height).toBe(box.canvasH);
  });

  it("places the piece's local origin inside its own canvas", () => {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        const box = pieceBox(grid, r, c, pieceW, pieceH);
        expect(box.offsetX).toBeGreaterThan(0);
        expect(box.offsetY).toBeGreaterThan(0);
        expect(box.offsetX).toBeLessThan(box.canvasW);
        expect(box.offsetY).toBeLessThan(box.canvasH);
      }
    }
  });

  it("positions the rect in group coordinates at the piece's solved cell", () => {
    const box = pieceBox(grid, 2, 3, pieceW, pieceH);
    // rect origin = solved corner (col*pieceW, row*pieceH) minus the canvas offset
    expect(box.rect.x).toBeCloseTo(3 * pieceW - box.offsetX, 6);
    expect(box.rect.y).toBeCloseTo(2 * pieceH - box.offsetY, 6);
  });
});

describe("scatterGroups", () => {
  it("creates exactly one single-piece group per cell, covering every id once", () => {
    // Regression guard for issue #1 item (4): the number of rendered pieces must
    // always equal cols * rows, with no id missing and none duplicated.
    for (const [cols, rows] of [
      [4, 3],
      [8, 6],
      [20, 15],
    ] as const) {
      const { pieceW, pieceH } = geometry(cols, rows);
      const groups = scatterGroups({ cols, rows, seed: 12345, pieceW, pieceH, ...STAGE });

      expect(groups.length).toBe(cols * rows);
      const members = groups.flatMap((g) => g.members);
      expect(members.length).toBe(cols * rows);

      const expected: string[] = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) expected.push(`${r}-${c}`);
      expect([...members].sort()).toEqual([...expected].sort());

      // Group ids must be unique — the group model is keyed by them.
      expect(new Set(groups.map((g) => g.id)).size).toBe(groups.length);
    }
  });

  it("is deterministic for a seed and differs between seeds", () => {
    const { pieceW, pieceH } = geometry(8, 6);
    const args = { cols: 8, rows: 6, pieceW, pieceH, ...STAGE };
    expect(scatterGroups({ ...args, seed: 42 })).toEqual(scatterGroups({ ...args, seed: 42 }));
    expect(scatterGroups({ ...args, seed: 42 })).not.toEqual(scatterGroups({ ...args, seed: 43 }));
  });

  it("starts every piece's cell inside the stage", () => {
    const cols = 20;
    const rows = 15;
    const { pieceW, pieceH } = geometry(cols, rows);
    const groups = scatterGroups({ cols, rows, seed: 999, pieceW, pieceH, ...STAGE });

    for (const g of groups) {
      const [row, col] = g.members[0].split("-").map(Number);
      // Group origin + solved cell corner = the scattered cell corner.
      const cornerX = g.x + col * pieceW;
      const cornerY = g.y + row * pieceH;
      expect(cornerX).toBeGreaterThanOrEqual(0);
      expect(cornerY).toBeGreaterThanOrEqual(0);
      expect(cornerX + pieceW).toBeLessThanOrEqual(STAGE.stageW);
      expect(cornerY + pieceH).toBeLessThanOrEqual(STAGE.stageH);
    }
  });
});

describe("unionRect", () => {
  it("spans all input rects", () => {
    const r = unionRect([
      { x: 10, y: 20, width: 30, height: 40 },
      { x: -5, y: 25, width: 10, height: 10 },
    ]);
    expect(r).toEqual({ x: -5, y: 20, width: 45, height: 40 });
  });

  it("returns an empty rect at the origin for no input", () => {
    expect(unionRect([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("clampGroupPosition", () => {
  // A group whose extent reaches 20px left and 10px above its own origin.
  const bounds: Rect = { x: -20, y: -10, width: 200, height: 100 };
  const stageW = 1000;
  const stageH = 500;

  it("leaves a position that is fully inside untouched", () => {
    const pos = { x: 300, y: 200 };
    expect(clampGroupPosition(pos, bounds, stageW, stageH)).toEqual(pos);
  });

  it("stops the group escaping past the left and top edges", () => {
    const c = clampGroupPosition({ x: -500, y: -500 }, bounds, stageW, stageH);
    expect(c.x + bounds.x).toBeCloseTo(0, 6);
    expect(c.y + bounds.y).toBeCloseTo(0, 6);
  });

  it("stops the group escaping past the right and bottom edges", () => {
    const c = clampGroupPosition({ x: 5000, y: 5000 }, bounds, stageW, stageH);
    expect(c.x + bounds.x + bounds.width).toBeCloseTo(stageW, 6);
    expect(c.y + bounds.y + bounds.height).toBeCloseTo(stageH, 6);
  });

  it("keeps the top-left corner reachable when the group is larger than the stage", () => {
    const huge: Rect = { x: 0, y: 0, width: stageW + 300, height: stageH + 300 };
    const c = clampGroupPosition({ x: 400, y: 400 }, huge, stageW, stageH);
    expect(c.x).toBeCloseTo(0, 6);
    expect(c.y).toBeCloseTo(0, 6);
  });

  it("never places a scattered piece where it cannot be grabbed", () => {
    // Every clamped position must keep the whole extent within the stage.
    const cases = [
      { x: -1e6, y: 0 },
      { x: 1e6, y: 0 },
      { x: 0, y: -1e6 },
      { x: 0, y: 1e6 },
      { x: 12.5, y: 480.25 },
    ];
    for (const pos of cases) {
      const c = clampGroupPosition(pos, bounds, stageW, stageH);
      expect(c.x + bounds.x).toBeGreaterThanOrEqual(-1e-9);
      expect(c.y + bounds.y).toBeGreaterThanOrEqual(-1e-9);
      expect(c.x + bounds.x + bounds.width).toBeLessThanOrEqual(stageW + 1e-9);
      expect(c.y + bounds.y + bounds.height).toBeLessThanOrEqual(stageH + 1e-9);
    }
  });
});
