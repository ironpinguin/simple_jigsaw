// Edge & vertex generation. Every interior edge in the grid is shared by exactly
// two neighbouring pieces, and every interior grid vertex is shared by up to four
// pieces. By storing ONE edge object per boundary and ONE offset per vertex and
// letting neighbours reference them, complementary fit (one piece's tab is the
// other's blank, and shared corners coincide) is guaranteed by construction.

import { mulberry32, uniform, type Rng } from "./prng";

/**
 * Per-edge randomisation for the classic knob: the knob slides along the edge
 * (`pos`), scales in width (`wN`), leans to one side (`sk`), varies its neck
 * undercut (`uc`), and its two flanks differ slightly in height (`hL`/`hR`).
 */
export interface EdgeJitter {
  pos: number;
  wN: number;
  sk: number;
  uc: number;
  hL: number;
  hR: number;
}

export type Edge =
  | { kind: "flat" }
  | { kind: "tab"; sign: 1 | -1; jitter: EdgeJitter };

/** Offset of a grid vertex from its regular position, in fractions of a cell. */
export interface VertexOffset {
  dx: number;
  dy: number;
}

export interface EdgeGrid {
  cols: number;
  rows: number;
  /** Horizontal edges (run left→right). `horiz[r][c]`, r in 0..rows. */
  horiz: Edge[][];
  /** Vertical edges (run top→bottom). `vert[r][c]`, c in 0..cols. */
  vert: Edge[][];
  /**
   * Grid vertices `vertices[r][c]` for r in 0..rows, c in 0..cols. Interior
   * vertices are jittered; outer-border vertices stay at {0,0} so the puzzle's
   * overall outline remains a clean rectangle.
   */
  vertices: VertexOffset[][];
}

/** Light jitter amplitude for interior vertices (fraction of a cell). */
const VERTEX_JITTER = 0.07;

function makeInteriorEdge(rng: Rng): Edge {
  return {
    kind: "tab",
    sign: rng() < 0.5 ? -1 : 1,
    jitter: {
      pos: uniform(rng, -0.05, 0.05),
      wN: uniform(rng, 0.9, 1.12),
      sk: uniform(rng, -1, 1),
      uc: uniform(rng, 0.8, 1.2),
      hL: uniform(rng, 0.94, 1.06),
      hR: uniform(rng, 0.94, 1.06),
    },
  };
}

/**
 * Build the full edge + vertex grid for a cols×rows puzzle. Deterministic in
 * `seed`: the same (cols, rows, seed) always produces identical output.
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

  // Vertices: (rows+1) x (cols+1); interior ones jittered, border ones fixed.
  const vertices: VertexOffset[][] = [];
  for (let r = 0; r <= rows; r++) {
    const line: VertexOffset[] = [];
    for (let c = 0; c <= cols; c++) {
      const border = r === 0 || r === rows || c === 0 || c === cols;
      line.push(
        border
          ? { dx: 0, dy: 0 }
          : {
              dx: uniform(rng, -VERTEX_JITTER, VERTEX_JITTER),
              dy: uniform(rng, -VERTEX_JITTER, VERTEX_JITTER),
            },
      );
    }
    vertices.push(line);
  }

  return { cols, rows, horiz, vert, vertices };
}
