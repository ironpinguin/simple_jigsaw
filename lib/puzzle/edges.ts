// Edge & vertex generation. Every interior edge in the grid is shared by exactly
// two neighbouring pieces, and every interior grid vertex is shared by up to four
// pieces. By storing ONE edge object per boundary and ONE offset per vertex and
// letting neighbours reference them, complementary fit (one piece's tab is the
// other's blank, and shared corners coincide) is guaranteed by construction.

import { mulberry32, uniform, type Rng } from "./prng";
import { DEFAULT_PIECE_STYLE, type PieceStyle } from "./style";

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

/**
 * Extra per-edge randomisation for the wooden style, drawn from its own rng so
 * the classic sequence is untouched: the cap scales (`hs`) and the whole edge
 * bows faintly — `a1` is a half-wave over the edge, `a2` a full S-wave, both in
 * knob-height units.
 */
export interface WoodJitter {
  hs: number;
  a1: number;
  a2: number;
}

export type Edge =
  | { kind: "flat" }
  | { kind: "tab"; sign: 1 | -1; jitter: EdgeJitter; wood?: WoodJitter };

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

/**
 * Weaker vertex jitter for the wooden style: its pieces are nearly square, the
 * character is in the knobs. Applied to the same rng draws as the classic
 * jitter (uniform is linear), so it scales the corners without shifting the
 * sequence.
 */
const WOOD_VERTEX_JITTER = 0.03;

/** Salt for the wooden style's second rng stream. */
const WOOD_SALT = 0x5bd1e995;

function makeInteriorEdge(rng: Rng, woodRng: Rng | null): Edge {
  const edge: Edge = {
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
  if (woodRng) {
    edge.wood = {
      hs: uniform(woodRng, 0.9, 1.1),
      a1: uniform(woodRng, -0.08, 0.08),
      a2: uniform(woodRng, -0.05, 0.05),
    };
  }
  return edge;
}

/**
 * Build the full edge + vertex grid for a cols×rows puzzle. Deterministic in
 * its inputs: the same (cols, rows, seed, style) always produces identical
 * output. Every style consumes the main rng in the same order, so a wooden
 * puzzle keeps the tab/blank layout of its classic twin.
 */
export function generateEdges(
  cols: number,
  rows: number,
  seed: number,
  style: PieceStyle = DEFAULT_PIECE_STYLE,
): EdgeGrid {
  if (cols < 1 || rows < 1) {
    throw new Error(`cols and rows must be >= 1, got ${cols}x${rows}`);
  }
  const rng = mulberry32(seed);
  const wooden = style === "wooden";
  const woodRng = wooden ? mulberry32(seed ^ WOOD_SALT) : null;
  const vj = wooden ? WOOD_VERTEX_JITTER : VERTEX_JITTER;

  // Horizontal edges: (rows+1) lines, each with `cols` edges.
  const horiz: Edge[][] = [];
  for (let r = 0; r <= rows; r++) {
    const line: Edge[] = [];
    for (let c = 0; c < cols; c++) {
      line.push(r === 0 || r === rows ? { kind: "flat" } : makeInteriorEdge(rng, woodRng));
    }
    horiz.push(line);
  }

  // Vertical edges: `rows` lines, each with (cols+1) edges.
  const vert: Edge[][] = [];
  for (let r = 0; r < rows; r++) {
    const line: Edge[] = [];
    for (let c = 0; c <= cols; c++) {
      line.push(c === 0 || c === cols ? { kind: "flat" } : makeInteriorEdge(rng, woodRng));
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
              dx: uniform(rng, -vj, vj),
              dy: uniform(rng, -vj, vj),
            },
      );
    }
    vertices.push(line);
  }

  return { cols, rows, horiz, vert, vertices };
}
