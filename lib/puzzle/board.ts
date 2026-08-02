// Board geometry: where a piece's bitmap sits inside its group, where the loose
// pieces start out, and how far a group may be dragged. Kept free of canvas and
// Konva calls (like ./groups) so all of it is unit-testable in plain node —
// PuzzleBoard only adds the rasterising and the event wiring on top.

import type { EdgeGrid } from "./edges";
import { pieceOutlinePoints } from "./outline";
import { mulberry32 } from "./prng";
import { pieceId, type PieceGroup } from "./groups";

/** Room left around the outline for the bevel/inner-shadow, in pixels. */
export const PIECE_PAD = 7;

/** Knob height as a fraction of the cell — must match TAB in ./outline. */
const TAB_FRAC = 0.2;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
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
 * Deterministic in `seed`, and consumed in row-major order, so everyone opening
 * the same link gets the same scatter.
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
  const tabV = TAB_FRAC * pieceW;
  const tabH = TAB_FRAC * pieceH;
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

/** Smallest rect covering all of `rects`; an empty rect at the origin for none. */
export function unionRect(rects: Iterable<Rect>): Rect {
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
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Restrict a group origin so the group's whole extent stays inside the stage.
 * Without this a group dropped past the stage edge is clipped away entirely and
 * only findable by blind panning — `resetView` restores the viewport, not the
 * pieces.
 *
 * `bounds` is the group's extent in group coordinates (see `unionRect` over its
 * members' `rect`s). A group too large to fit keeps its top-left corner on
 * screen, which is where the rest of it can be reached from.
 */
export function clampGroupPosition(
  pos: { x: number; y: number },
  bounds: Rect,
  stageW: number,
  stageH: number,
): { x: number; y: number } {
  const axis = (p: number, min: number, size: number, stage: number) => {
    const lo = -min; // left/top edge flush with the stage
    const hi = stage - min - size; // right/bottom edge flush with the stage
    if (hi < lo) return lo; // larger than the stage: pin the near corner
    return Math.min(hi, Math.max(lo, p));
  };
  return {
    x: axis(pos.x, bounds.x, bounds.width, stageW),
    y: axis(pos.y, bounds.y, bounds.height, stageH),
  };
}
