// Outline generation: turn a piece's four (shared, jittered) corner vertices and
// four (shared) edges into a closed path in the piece's LOCAL coordinate space
// (origin at the top-left of the piece's REGULAR cell; tabs and jittered corners
// may extend beyond the cell). Because neighbours reference the same vertices and
// the same edge objects, the shared boundary is one identical curve traced in
// opposite directions — a perfect fit.

import type { Edge, EdgeGrid, EdgeJitter } from "./edges";

export interface Point {
  x: number;
  y: number;
}

/**
 * Fraction of the perpendicular cell dimension that a knob protrudes. Exported
 * because ./board needs the same figure to reason about how far a piece's
 * bitmap reaches beyond its cell; keeping one definition avoids the two drifting
 * apart.
 */
export const TAB = 0.2;

/**
 * Classic jigsaw knob as (t, p) pairs: t runs 0→1 along the edge, p is the
 * perpendicular offset in knob-height units. The head is wider than the neck
 * (an undercut/overhang) — the iconic interlocking shape. Returns the 12 bezier
 * points after the start corner (4 cubic segments). Deterministic in the edge's
 * jitter, so both neighbours build the identical curve.
 */
function tabTemplate(j: EdgeJitter): ReadonlyArray<readonly [number, number]> {
  const c = 0.5 + j.pos; // knob centre along the edge
  const nl = c - 0.13 * j.wN; // left neck
  const nr = c + 0.13 * j.wN; // right neck
  const bl = c - 0.19 * j.wN; // left bulb edge (beyond the neck → overhang)
  const br = c + 0.19 * j.wN; // right bulb edge
  const al = c - 0.02 * j.sk; // apex, slightly skewed
  const ar = c + 0.02 * j.sk;
  return [
    [0.2, 0],
    [nl - 0.05, 0],
    [nl, 0.02], // left shoulder → neck
    [nl + 0.02 * j.uc, 0.3],
    [bl, 0.55],
    [al, j.hL], // up the undercut left flank to the apex
    [ar, j.hR],
    [br, 0.55],
    [nr - 0.02 * j.uc, 0.3], // over the top, down the right flank
    [nr, 0.02],
    [nr + 0.05, 0],
    [1, 0], // neck → right shoulder
  ];
}

/**
 * Point list (including the start corner) for one edge from corner A to B. The
 * perpendicular is derived from the edge direction, so knobs sit correctly even
 * on the slightly slanted edges produced by vertex jitter. `tab` is the knob
 * height in pixels; the edge's sign picks the side.
 */
function edgePoints(edge: Edge, a: Point, b: Point, tab: number): Point[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (edge.kind === "flat") {
    return [
      { x: a.x, y: a.y },
      { x: a.x + dx / 3, y: a.y + dy / 3 },
      { x: a.x + (2 * dx) / 3, y: a.y + (2 * dy) / 3 },
      { x: b.x, y: b.y },
    ];
  }

  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len; // perpendicular unit (rotate direction +90°)
  const py = dx / len;
  const s = edge.sign;

  const pts: Point[] = [{ x: a.x, y: a.y }];
  for (const [t, p] of tabTemplate(edge.jitter)) {
    const off = p * tab * s;
    pts.push({ x: a.x + t * dx + off * px, y: a.y + t * dy + off * py });
  }
  return pts;
}

/**
 * The four edges of a piece as point lists in the piece's local coordinate
 * space (each list includes both end corners). Corners come from the shared,
 * jittered grid vertices. Exposed so tests can verify neighbouring pieces share
 * an identical boundary.
 */
export function pieceEdgePoints(
  grid: EdgeGrid,
  row: number,
  col: number,
  pieceW: number,
  pieceH: number,
): { top: Point[]; right: Point[]; bottom: Point[]; left: Point[] } {
  const V = grid.vertices;
  // Vertex (r,c) in this piece's local coordinates (origin = regular cell corner).
  const vx = (r: number, cc: number) => (cc + V[r][cc].dx - col) * pieceW;
  const vy = (r: number, cc: number) => (r + V[r][cc].dy - row) * pieceH;

  const c00 = { x: vx(row, col), y: vy(row, col) };
  const c10 = { x: vx(row, col + 1), y: vy(row, col + 1) };
  const c11 = { x: vx(row + 1, col + 1), y: vy(row + 1, col + 1) };
  const c01 = { x: vx(row + 1, col), y: vy(row + 1, col) };

  const topEdge = grid.horiz[row][col];
  const bottomEdge = grid.horiz[row + 1][col];
  const leftEdge = grid.vert[row][col];
  const rightEdge = grid.vert[row][col + 1];

  const thH = TAB * pieceH; // knob height for horizontal (top/bottom) edges
  const thV = TAB * pieceW; // knob height for vertical (left/right) edges

  // Canonical directions (shared with neighbours): top & bottom left→right,
  // left & right top→bottom. Bottom and left are traversed reversed here.
  const top = edgePoints(topEdge, c00, c10, thH);
  const right = edgePoints(rightEdge, c10, c11, thV);
  const bottom = [...edgePoints(bottomEdge, c01, c11, thH)].reverse();
  const left = [...edgePoints(leftEdge, c00, c01, thV)].reverse();

  return { top, right, bottom, left };
}

/**
 * The closed outline of a piece as a flat point list [p0, c1, c2, p3, ...]: the
 * start corner once, then groups of three (two controls + end) per cubic bezier.
 */
export function pieceOutlinePoints(
  grid: EdgeGrid,
  row: number,
  col: number,
  pieceW: number,
  pieceH: number,
): Point[] {
  const { top, right, bottom, left } = pieceEdgePoints(grid, row, col, pieceW, pieceH);
  return [top[0], ...top.slice(1), ...right.slice(1), ...bottom.slice(1), ...left.slice(1)];
}

/** SVG path `data` string for a piece outline, ready for a Konva Path. */
export function pieceOutlinePath(
  grid: EdgeGrid,
  row: number,
  col: number,
  pieceW: number,
  pieceH: number,
): string {
  const pts = pieceOutlinePoints(grid, row, col, pieceW, pieceH);
  const round = (n: number) => Math.round(n * 100) / 100;
  let d = `M ${round(pts[0].x)} ${round(pts[0].y)}`;
  for (let i = 1; i < pts.length; i += 3) {
    const c1 = pts[i];
    const c2 = pts[i + 1];
    const end = pts[i + 2];
    d += ` C ${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(end.x)} ${round(end.y)}`;
  }
  return d + " Z";
}
