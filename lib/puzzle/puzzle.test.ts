import { describe, it, expect } from "vitest";
import { computeGrid, PIECE_PRESETS } from "./grid";
import { generateEdges } from "./edges";
import { pieceEdgePoints, pieceOutlinePath, type Point } from "./outline";

function expectPointsClose(a: Point[], b: Point[], eps = 1e-6) {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i].x).toBeCloseTo(b[i].x, 6);
    expect(a[i].y).toBeCloseTo(b[i].y, 6);
    void eps;
  }
}

describe("computeGrid", () => {
  it("produces a near-square grid for a square image", () => {
    const { cols, rows } = computeGrid(100, 1);
    expect(cols).toBe(10);
    expect(rows).toBe(10);
  });

  it("keeps the total piece count close to each preset", () => {
    for (const preset of PIECE_PRESETS) {
      for (const aspect of [1, 4 / 3, 16 / 9, 3 / 4]) {
        const { cols, rows } = computeGrid(preset, aspect);
        expect(cols).toBeGreaterThanOrEqual(1);
        expect(rows).toBeGreaterThanOrEqual(1);
        const total = cols * rows;
        // within 20% of the requested count
        expect(Math.abs(total - preset) / preset).toBeLessThanOrEqual(0.2);
      }
    }
  });

  it("orients the grid to match a wide image (more cols than rows)", () => {
    const { cols, rows } = computeGrid(108, 16 / 9);
    expect(cols).toBeGreaterThan(rows);
  });

  it("rejects invalid input", () => {
    expect(() => computeGrid(0, 1)).toThrow();
    expect(() => computeGrid(100, 0)).toThrow();
  });
});

describe("generateEdges", () => {
  it("is deterministic for a given seed", () => {
    const a = generateEdges(6, 4, 12345);
    const b = generateEdges(6, 4, 12345);
    expect(a).toEqual(b);
  });

  it("differs for different seeds", () => {
    const a = generateEdges(6, 4, 1);
    const b = generateEdges(6, 4, 2);
    expect(a).not.toEqual(b);
  });

  it("makes the outer border flat and interior edges tabbed", () => {
    const g = generateEdges(5, 3, 99);
    // top and bottom border lines are all flat
    expect(g.horiz[0].every((e) => e.kind === "flat")).toBe(true);
    expect(g.horiz[g.rows].every((e) => e.kind === "flat")).toBe(true);
    // left and right border columns are flat
    expect(g.vert.every((line) => line[0].kind === "flat")).toBe(true);
    expect(g.vert.every((line) => line[g.cols].kind === "flat")).toBe(true);
    // an interior horizontal edge is a tab
    expect(g.horiz[1][2].kind).toBe("tab");
  });
});

describe("piece outlines fit together", () => {
  const grid = generateEdges(4, 4, 777);
  const W = 100;
  const H = 80;

  it("shares an identical boundary with the piece below", () => {
    const top = pieceEdgePoints(grid, 0, 0, W, H);
    const below = pieceEdgePoints(grid, 1, 0, W, H);
    // piece(0,0) bottom, shifted up by one cell, reversed == piece(1,0) top
    const shifted = top.bottom.map((p) => ({ x: p.x, y: p.y - H }));
    expectPointsClose([...shifted].reverse(), below.top);
  });

  it("shares an identical boundary with the piece to the right", () => {
    const left = pieceEdgePoints(grid, 0, 0, W, H);
    const right = pieceEdgePoints(grid, 0, 1, W, H);
    // piece(0,0) right, shifted left by one cell, reversed == piece(0,1) left
    const shifted = left.right.map((p) => ({ x: p.x - W, y: p.y }));
    expectPointsClose([...shifted].reverse(), right.left);
  });

  it("produces a valid closed SVG path", () => {
    const d = pieceOutlinePath(grid, 1, 1, W, H);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.trim().endsWith("Z")).toBe(true);
    expect(d).toContain("C ");
  });
});
