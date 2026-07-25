// Edge generation. Every interior edge in the grid is shared by exactly two
// neighbouring pieces. By storing ONE edge object per boundary and letting both
// pieces reference it, complementary fit (one piece's tab is the other's blank)
// is guaranteed by construction — there is no way for neighbours to disagree.

import { mulberry32, uniform, type Rng } from "./prng";

/**
 * Per-edge randomisation. Every field varies independently so no two knobs look
 * alike: the knob slides along the edge, changes width/height, leans to one side
 * (skew), has unequal neck undercuts and unequal bulbous sides, and the two
 * shoulders wave slightly instead of being dead straight.
 */
export interface EdgeJitter {
  /** Shift of the knob centre along the edge. */
  pos: number;
  /** Half-width of the knob base along the edge. */
  width: number;
  /** Knob height scale factor. */
  height: number;
  /** Sideways lean of the knob apex (fraction of width). */
  skew: number;
  /** Left/right neck undercut widths. */
  neckL: number;
  neckR: number;
  /** Left/right side "bulbousness" (control-point pull). */
  legL: number;
  legR: number;
  /** Small perpendicular waviness on the two shoulders. */
  waveL1: number;
  waveL2: number;
  waveR1: number;
  waveR2: number;
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
      pos: uniform(rng, -0.06, 0.06),
      width: uniform(rng, 0.11, 0.17),
      height: uniform(rng, 0.8, 1.2),
      skew: uniform(rng, -0.35, 0.35),
      neckL: uniform(rng, 0.02, 0.06),
      neckR: uniform(rng, 0.02, 0.06),
      legL: uniform(rng, 0.42, 0.78),
      legR: uniform(rng, 0.42, 0.78),
      waveL1: uniform(rng, -0.04, 0.04),
      waveL2: uniform(rng, -0.04, 0.04),
      waveR1: uniform(rng, -0.04, 0.04),
      waveR2: uniform(rng, -0.04, 0.04),
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
