// Outline generation: turn the abstract edges of a single piece into a concrete
// closed path in the piece's LOCAL coordinate space (origin at the top-left of
// the piece's cell; tabs may extend into negative coordinates or beyond the
// cell size). The same edge object is shared with the neighbouring piece, so the
// two boundaries are identical curves traced in opposite directions — a perfect
// fit.

import type { Edge, EdgeGrid, EdgeJitter } from "./edges";

export interface Point {
  x: number;
  y: number;
}

/** Fraction of the perpendicular cell dimension that a knob protrudes. */
const TAB = 0.2;

// Template for a flat edge: a single straight cubic (3 points after the start).
const FLAT_TEMPLATE: ReadonlyArray<readonly [number, number]> = [
  [0.3333, 0],
  [0.6667, 0],
  [1.0, 0],
];

/**
 * Build a tabbed-edge template procedurally from the edge's jitter, as (t, p)
 * pairs where t runs 0→1 along the edge and p is the perpendicular offset in
 * knob-height units. Returns the 12 bezier points AFTER the start point (4 cubic
 * segments): left shoulder, up the (undercut) left flank to the apex, down the
 * right flank, right shoulder. Every edge produces a distinct, asymmetric knob;
 * because a shared edge stores one jitter, both neighbours build the identical
 * curve, so the pieces still fit perfectly.
 */
function tabTemplate(j: EdgeJitter): ReadonlyArray<readonly [number, number]> {
  const pos = 0.5 + j.pos; // knob centre along the edge
  const w = j.width; // knob half-width
  const sL = pos - w - j.neckL; // left neck base
  const sR = pos + w + j.neckR; // right neck base
  const apex = pos + j.skew * w; // apex leans to one side

  return [
    // left shoulder (slightly wavy) up to the left neck base
    [sL * 0.4, j.waveL1],
    [sL * 0.78, j.waveL2],
    [sL, 0],
    // up the left flank to the apex, control pulled inward for an undercut neck
    [sL + j.neckL * 0.6, j.legL],
    [apex - w * 0.7, 1],
    [apex, 1],
    // down the right flank to the right neck base
    [apex + w * 0.7, 1],
    [sR - j.neckR * 0.6, j.legR],
    [sR, 0],
    // right shoulder (slightly wavy) to the far corner
    [sR + (1 - sR) * 0.22, j.waveR1],
    [sR + (1 - sR) * 0.6, j.waveR2],
    [1, 0],
  ];
}

/**
 * Produce the full point list (including the start corner) for one edge, going
 * from corner A to corner B, with the knob bulging along the given signed
 * perpendicular vector (perp already scaled to knob height and sign).
 */
function edgePoints(edge: Edge, a: Point, b: Point, perp: Point): Point[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const template = edge.kind === "flat" ? FLAT_TEMPLATE : tabTemplate(edge.jitter);
  const hScale = edge.kind === "tab" ? edge.jitter.height : 1;

  const pts: Point[] = [{ x: a.x, y: a.y }];
  for (const [t, p0] of template) {
    const p = p0 * hScale;
    pts.push({
      x: a.x + t * dx + p * perp.x,
      y: a.y + t * dy + p * perp.y,
    });
  }
  return pts;
}

/**
 * The four edges of a piece as point lists in the piece's local coordinate
 * space. Each list includes both end corners. Exposed mainly so tests can
 * verify that neighbouring pieces share an identical boundary.
 */
export function pieceEdgePoints(
  grid: EdgeGrid,
  row: number,
  col: number,
  pieceW: number,
  pieceH: number,
): { top: Point[]; right: Point[]; bottom: Point[]; left: Point[] } {
  const thH = TAB * pieceH; // knob height for horizontal edges
  const thV = TAB * pieceW; // knob height for vertical edges

  const c00 = { x: 0, y: 0 };
  const c10 = { x: pieceW, y: 0 };
  const c11 = { x: pieceW, y: pieceH };
  const c01 = { x: 0, y: pieceH };

  const topEdge = grid.horiz[row][col];
  const bottomEdge = grid.horiz[row + 1][col];
  const leftEdge = grid.vert[row][col];
  const rightEdge = grid.vert[row][col + 1];

  const signOf = (e: Edge): number => (e.kind === "tab" ? e.sign : 0);

  // Canonical perpendiculars: horizontal edges bulge +Y (down), vertical edges
  // bulge +X (right). The knob's ABSOLUTE side is fixed by the edge sign,
  // independent of the direction a given piece happens to traverse it.
  const top = edgePoints(topEdge, c00, c10, { x: 0, y: signOf(topEdge) * thH });
  const right = edgePoints(rightEdge, c10, c11, { x: signOf(rightEdge) * thV, y: 0 });

  // Bottom canonical goes (0,pieceH)→(pieceW,pieceH); this piece traverses it
  // right→left, so reverse the canonical list.
  const bottomCanonical = edgePoints(bottomEdge, c01, c11, {
    x: 0,
    y: signOf(bottomEdge) * thH,
  });
  const bottom = [...bottomCanonical].reverse();

  // Left canonical goes (0,0)→(0,pieceH); this piece traverses it bottom→top.
  const leftCanonical = edgePoints(leftEdge, c00, c01, {
    x: signOf(leftEdge) * thV,
    y: 0,
  });
  const left = [...leftCanonical].reverse();

  return { top, right, bottom, left };
}

/**
 * The closed outline of a piece as a flat point list [p0, c1, c2, p3, ...]
 * suitable for stitching into an SVG path. The start corner appears once; each
 * following group of three points is a cubic bezier (two controls + end).
 */
export function pieceOutlinePoints(
  grid: EdgeGrid,
  row: number,
  col: number,
  pieceW: number,
  pieceH: number,
): Point[] {
  const { top, right, bottom, left } = pieceEdgePoints(grid, row, col, pieceW, pieceH);
  // Chain edges, dropping each edge's first point (equal to the previous end).
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
