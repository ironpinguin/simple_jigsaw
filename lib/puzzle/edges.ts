// Edge generation. Every interior edge in the grid is shared by exactly two
// neighbouring pieces. By storing ONE edge object per boundary and letting both
// pieces reference it, complementary fit (one piece's tab is the other's blank)
// is guaranteed by construction — there is no way for neighbours to disagree.

import { mulberry32, uniform, type Rng } from "./prng";

/** Small per-edge randomisation so the knobs look organic, not stamped. */
export interface EdgeJitter {
  /** Horizontal shift of the knob centre along the edge, roughly [-0.04, 0.04]. */
  center: number;
  /** Knob height scale factor, roughly [0.9, 1.1]. */
  height: number;
}

export type Edge =
  | { kind: "flat" }
  | { kind: "tab"; sign: 1 | -1; jitter: EdgeJitter };

export interface EdgeGrid {
  cols: number;
  rows: number;
  /**
   * Horizontal edges (run left→right). `horiz[r][c]` is the edge between grid
   * row r-1 and row r for column c. r ranges 0..rows (rows+1 lines); r==0 and
   * r==rows are the flat outer border.
   */
  horiz: Edge[][];
  /**
   * Vertical edges (run top→bottom). `vert[r][c]` is the edge between column
   * c-1 and column c for row r. c ranges 0..cols (cols+1 lines); c==0 and
   * c==cols are the flat outer border.
   */
  vert: Edge[][];
}

function makeInteriorEdge(rng: Rng): Edge {
  return {
    kind: "tab",
    sign: rng() < 0.5 ? -1 : 1,
    jitter: {
      center: uniform(rng, -0.04, 0.04),
      height: uniform(rng, 0.9, 1.1),
    },
  };
}

/**
 * Build the full edge grid for a cols×rows puzzle. Deterministic in `seed`:
 * the same (cols, rows, seed) always produces identical edges.
 */
export function generateEdges(cols: number, rows: number, seed: number): EdgeGrid {
  if (cols < 1 || rows < 1) {
    throw new Error(`cols and rows must be >= 1, got ${cols}x${rows}`);
  }
  const rng = mulberry32(seed);

  // Horizontal edges: (rows+1) lines, each with `cols` edges.
  const horiz: Edge[][] = [];
  for (let r = 0; r <= rows; r++) {
    const line: Edge[] = [];
    for (let c = 0; c < cols; c++) {
      line.push(r === 0 || r === rows ? { kind: "flat" } : makeInteriorEdge(rng));
    }
    horiz.push(line);
  }

  // Vertical edges: `rows` lines, each with (cols+1) edges.
  const vert: Edge[][] = [];
  for (let r = 0; r < rows; r++) {
    const line: Edge[] = [];
    for (let c = 0; c <= cols; c++) {
      line.push(c === 0 || c === cols ? { kind: "flat" } : makeInteriorEdge(rng));
    }
    vert.push(line);
  }

  return { cols, rows, horiz, vert };
}
