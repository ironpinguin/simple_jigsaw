import { describe, it, expect } from "vitest";
import { computeGrid, PIECE_PRESETS } from "./grid";
import { generateEdges } from "./edges";
import { pieceEdgePoints, pieceOutlinePath, pieceOutlinePoints, type Point } from "./outline";
import { PIECE_STYLES } from "./style";

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

  it.each(PIECE_STYLES)("is deterministic per seed in the %s style", (style) => {
    expect(generateEdges(6, 4, 12345, style)).toEqual(generateEdges(6, 4, 12345, style));
    expect(generateEdges(6, 4, 1, style)).not.toEqual(generateEdges(6, 4, 2, style));
  });

  it("keeps the wooden border flat and its corners unjittered", () => {
    const g = generateEdges(5, 3, 99, "wooden");
    expect(g.horiz[0].every((e) => e.kind === "flat")).toBe(true);
    expect(g.horiz[g.rows].every((e) => e.kind === "flat")).toBe(true);
    expect(g.vert.every((line) => line[0].kind === "flat" && line[g.cols].kind === "flat")).toBe(true);
    for (let r = 0; r <= g.rows; r++) {
      for (let c = 0; c <= g.cols; c++) {
        if (r === 0 || r === g.rows || c === 0 || c === g.cols) {
          expect(g.vertices[r][c]).toEqual({ dx: 0, dy: 0 });
        }
      }
    }
  });

  it("gives a wooden puzzle the tab/blank layout of its classic twin", () => {
    // The wooden extras come from a second rng stream, so the main sequence —
    // and with it every sign and classic jitter value — is shared.
    const classic = generateEdges(6, 4, 4242, "classic");
    const wooden = generateEdges(6, 4, 4242, "wooden");
    for (const key of ["horiz", "vert"] as const) {
      classic[key].forEach((line, r) =>
        line.forEach((e, c) => {
          const w = wooden[key][r][c];
          expect(w.kind).toBe(e.kind);
          if (e.kind === "tab" && w.kind === "tab") {
            expect(w.sign).toBe(e.sign);
            expect(w.jitter).toEqual(e.jitter);
            expect(w.wood).toBeDefined();
            expect(e.wood).toBeUndefined();
          }
        }),
      );
    }
    expect(pieceOutlinePath(wooden, 1, 1, 100, 80)).not.toBe(pieceOutlinePath(classic, 1, 1, 100, 80));
  });
});

/** A closed bezier outline flattened into a polygon, `n` points per segment. */
function flatten(pts: Point[], n = 12): Point[] {
  const out: Point[] = [];
  for (let i = 0; i + 3 < pts.length; i += 3) {
    const [a, b, c, d] = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3]];
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const u = 1 - t;
      const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      out.push({
        x: w[0] * a.x + w[1] * b.x + w[2] * c.x + w[3] * d.x,
        y: w[0] * a.y + w[1] * b.y + w[2] * c.y + w[3] * d.y,
      });
    }
  }
  return out;
}

/** Whether segments pq and rs cross properly (touching does not count). */
function segmentsCross(p: Point, q: Point, r: Point, s: Point): boolean {
  const side = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return side(p, q, r) * side(p, q, s) < 0 && side(r, s, p) * side(r, s, q) < 0;
}

function selfIntersects(poly: Point[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < n; k++) {
      if (i === 0 && k === n - 1) continue; // neighbours across the closing point
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[k], poly[(k + 1) % n])) return true;
    }
  }
  return false;
}

describe("wooden piece outlines", () => {
  const style = "wooden";
  it("never cross themselves — two knobs of one piece do not collide", () => {
    // Its large round heads grow towards each other at every corner; on a
    // squashed cell the ones along the short side come closest. Checked over
    // many seeds because a collision needs an unlucky mix of positions and
    // sizes. Not asserted for classic: its knob tip has a sub-pixel kink where
    // the two apex segments meet, which this check counts — and classic is
    // frozen for the sake of existing links.
    for (let seed = 1; seed <= 40; seed++) {
      for (const [w, h] of [[100, 100], [100, 70], [70, 100]]) {
        const grid = generateEdges(6, 5, seed, style);
        for (let r = 0; r < 5; r++) {
          for (let c = 0; c < 6; c++) {
            const poly = flatten(pieceOutlinePoints(grid, r, c, w, h));
            expect(selfIntersects(poly), `seed ${seed}, ${w}x${h}, piece ${r}-${c}`).toBe(false);
          }
        }
      }
    }
  });
});

/** FNV-1a — enough to fingerprint a long string in a readable assertion. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

describe("classic style regression guard", () => {
  // Shared links render from (cols, rows, seed): if these change, every puzzle
  // already out there changes shape. The values were taken before the wooden
  // style existed — update them only for a deliberate, announced reshape.
  it.each([
    [5, 4, 12345, "2de0c9fa", "2e416da1"],
    [8, 6, 1, "da44a4e3", "3c1e66ae"],
    [3, 7, 987654321, "23279d8d", "8d53c2d9"],
  ] as const)("%ix%i seed %i is bit-identical", (cols, rows, seed, gridHash, pathHash) => {
    for (const g of [generateEdges(cols, rows, seed), generateEdges(cols, rows, seed, "classic")]) {
      let paths = "";
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) paths += pieceOutlinePath(g, r, c, 100, 80) + "\n";
      }
      expect(fnv1a(JSON.stringify(g))).toBe(gridHash);
      expect(fnv1a(paths)).toBe(pathHash);
    }
  });
});

describe.each(PIECE_STYLES)("%s piece outlines fit together", (style) => {
  const grid = generateEdges(4, 4, 777, style);
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
