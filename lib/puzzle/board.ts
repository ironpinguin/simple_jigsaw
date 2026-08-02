// Board geometry: how big the stage and the assembled picture are, where a
// piece's bitmap sits inside its group, where the loose pieces start out, and
// where a group must end up after a drag. Kept free of canvas and Konva calls
// (like ./groups) so all of it is unit-testable in plain node — PuzzleBoard adds
// only the rasterising and the event wiring on top.

import type { EdgeGrid } from "./edges";
import { pieceOutlinePoints, TAB } from "./outline";
import { mulberry32 } from "./prng";
import { pieceId, type PieceGroup } from "./groups";

/** Room left around the outline for the bevel/inner-shadow, in pixels. */
export const PIECE_PAD = 7;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GeometryInput {
  /** Width available to the board element. */
  containerW: number;
  /** Window height; the stage fills what is left below the toolbar. */
  viewportH: number;
  /** imageWidth / imageHeight. */
  aspect: number;
  cols: number;
  rows: number;
}

export interface BoardGeometry {
  stageW: number;
  stageH: number;
  /** Size of the assembled picture. */
  boardW: number;
  boardH: number;
  pieceW: number;
  pieceH: number;
  /** How close two group origins must be to snap together. */
  snapDist: number;
}

/**
 * Stage and piece sizing for one puzzle. The assembled picture takes ~40% of the
 * width (capped in height) so the rest of the window is free to spread and
 * assemble pieces.
 */
export function boardGeometry({
  containerW,
  viewportH,
  aspect,
  cols,
  rows,
}: GeometryInput): BoardGeometry {
  const stageW = Math.max(360, containerW);
  const stageH = Math.max(520, Math.floor(viewportH - 210));

  let boardW = stageW * 0.4;
  let boardH = boardW / aspect;
  const maxBoardH = Math.min(460, stageH * 0.6);
  if (boardH > maxBoardH) {
    boardH = maxBoardH;
    boardW = boardH * aspect;
  }

  const pieceW = boardW / cols;
  const pieceH = boardH / rows;

  return {
    stageW,
    stageH,
    boardW,
    boardH,
    pieceW,
    pieceH,
    snapDist: Math.max(18, 0.4 * Math.min(pieceW, pieceH)),
  };
}

export interface PieceBox {
  /** Bitmap size needed to hold the whole (tabbed, jittered) outline plus padding. */
  canvasW: number;
  canvasH: number;
  /** Where the piece's local (0,0) — its regular cell corner — sits in that bitmap. */
  offsetX: number;
  offsetY: number;
  /**
   * The area the bitmap occupies in group coordinates. Also the piece's hit
   * area: Konva tests an Image against this whole rectangle, transparent
   * padding included.
   */
  rect: Rect;
}

/**
 * Extent of one piece. With vertex jitter and tabs on any side the outline
 * reaches past its regular cell by a varying amount, so the bitmap is sized to
 * the actual bounding box rather than a fixed cell-plus-tab box.
 */
export function pieceBox(
  grid: EdgeGrid,
  row: number,
  col: number,
  pieceW: number,
  pieceH: number,
): PieceBox {
  const pts = pieceOutlinePoints(grid, row, col, pieceW, pieceH);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const offsetX = -minX + PIECE_PAD;
  const offsetY = -minY + PIECE_PAD;
  const canvasW = Math.ceil(maxX - minX + 2 * PIECE_PAD);
  const canvasH = Math.ceil(maxY - minY + 2 * PIECE_PAD);

  return {
    canvasW,
    canvasH,
    offsetX,
    offsetY,
    rect: {
      // Pieces live in a shared puzzle frame: piece (row,col) always sits at
      // (col*pieceW, row*pieceH) relative to its group's origin.
      x: col * pieceW - offsetX,
      y: row * pieceH - offsetY,
      width: canvasW,
      height: canvasH,
    },
  };
}

export interface ScatterInput {
  cols: number;
  rows: number;
  seed: number;
  pieceW: number;
  pieceH: number;
  stageW: number;
  stageH: number;
}

/**
 * The starting position of every piece: one single-piece group per cell, its
 * cell corner dropped somewhere in the stage. The group origin is the scattered
 * corner minus the piece's solved corner, which keeps the shared puzzle
 * coordinate frame intact.
 *
 * Deterministic in its inputs, and the random stream depends only on `seed`, so
 * the same link produces the same relative arrangement for everyone. Absolute
 * positions still scale with the viewport, because `stageW`/`stageH` are
 * viewport-derived.
 *
 * Note the margins use a nominal cell-plus-tab box rather than the exact
 * `pieceBox` extent, so ~0.3% of pieces start a few pixels outside the area
 * `settleGroup` would allow and shift inwards on first drop. Overlap-free
 * placement (issue #3) is where that is worth reworking.
 */
export function scatterGroups({
  cols,
  rows,
  seed,
  pieceW,
  pieceH,
  stageW,
  stageH,
}: ScatterInput): PieceGroup[] {
  const tabV = TAB * pieceW;
  const tabH = TAB * pieceH;
  const boxW = pieceW + 2 * tabV;
  const boxH = pieceH + 2 * tabH;
  const rng = mulberry32(seed ^ 0x9e3779b9);

  const groups: PieceGroup[] = [];
  let gid = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cornerX = tabV + 6 + rng() * Math.max(1, stageW - boxW - 12);
      const cornerY = tabH + 6 + rng() * Math.max(1, stageH - boxH - 12);
      groups.push({
        id: gid++,
        x: cornerX - c * pieceW,
        y: cornerY - r * pieceH,
        members: [pieceId(r, c)],
      });
    }
  }
  return groups;
}

/**
 * Smallest rect covering all of `rects`, or `null` for no input.
 *
 * `null` rather than a zero rect on purpose: to a clamp, `{0,0,0,0}` is not
 * "nothing is known" but the constraint "keep the origin inside the stage",
 * which would silently drag a group to the top-left instead of leaving it be.
 */
export function unionRect(rects: Iterable<Rect>): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * A group's extent in its own coordinates, from its members' bitmap rects.
 * `null` when no member resolves — see `unionRect` for why that is not a zero
 * rect. Members the layout does not know are skipped: the group model is
 * reseeded in an effect after the layout is rebuilt, so for the one render in
 * between a group can still name pieces of the previous grid.
 */
export function groupExtent(
  members: Iterable<string>,
  rectOf: (id: string) => Rect | undefined,
): Rect | null {
  const rects: Rect[] = [];
  for (const id of members) {
    const r = rectOf(id);
    if (r) rects.push(r);
  }
  return unionRect(rects);
}

/**
 * Restrict a group origin so the group's whole extent stays inside the stage.
 * Without this a group dropped past the stage edge is clipped away and only
 * findable by blind panning — `resetView` restores the viewport, not the pieces.
 *
 * `extent` is what is being kept inside (the group's own extent in group
 * coordinates), not the region to stay within; that is `stageW`/`stageH`.
 *
 * A group too large to fit on an axis is pinned flush to the near edge, which
 * also makes it immovable on that axis. That is unreachable through
 * `boardGeometry`, where a fully assembled puzzle is at most 40% of the stage
 * width and 60% of its height.
 */
export function clampGroupPosition(
  pos: { x: number; y: number },
  extent: Rect,
  stageW: number,
  stageH: number,
): { x: number; y: number } {
  /** One axis: keep `[p + min, p + min + size]` within `[0, stage]`. */
  function axis(p: number, min: number, size: number, stage: number): number {
    const lo = -min; // near edge flush with the stage
    const hi = stage - min - size; // far edge flush with the stage
    if (hi < lo) return lo; // larger than the stage: pin the near edge
    return Math.min(hi, Math.max(lo, p));
  }
  return {
    x: axis(pos.x, extent.x, extent.width, stageW),
    y: axis(pos.y, extent.y, extent.height, stageH),
  };
}

/**
 * Where a group must sit once a drag ends so that all of it is back on the
 * board. Dragging itself is deliberately unbounded: confining it would make a
 * piece unable to reach a neighbour parked flush against an edge, because the
 * two connect at a shared origin that lies further out than the neighbour's own
 * limit. Bounding the *result* instead keeps every connection reachable while
 * still guaranteeing nothing is left off-board at rest.
 *
 * `null` when the group's extent is unknown, meaning "leave the position alone".
 */
export function settleGroup(
  g: PieceGroup,
  rectOf: (id: string) => Rect | undefined,
  stageW: number,
  stageH: number,
): { x: number; y: number } | null {
  const extent = groupExtent(g.members, rectOf);
  if (!extent) return null;
  return clampGroupPosition({ x: g.x, y: g.y }, extent, stageW, stageH);
}
