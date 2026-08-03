// The board overview: how big the thumbnail is, which part of the stage is on
// screen, where each group sits on it, and where the stage has to move to bring
// a point of the overview into view. Pure like the rest of ./puzzle — the
// component adds the SVG and the pointer wiring on top.
//
// Everything here works in *stage* coordinates. The overview draws the stage
// rectangle scaled down, so the drawing needs no coordinates of its own; only
// `minimapSize` knows the thumbnail's pixel size, and it is the SVG viewBox that
// does the scaling.

import { groupExtent, type Rect } from "./board";
import type { PieceGroup } from "./groups";

/**
 * The stage transform, mirrored out of Konva. `x`/`y` are the stage's own
 * position — the offset applied *after* scaling, so a stage panned right has a
 * positive `x` while the content shown starts at a negative stage coordinate.
 */
export interface StageView {
  x: number;
  y: number;
  scale: number;
}

/**
 * `0` for `-0`. Negating a position produces one whenever the stage sits at the
 * origin, and while it compares equal to `0` it is not *identical* to it — which
 * is enough to make two positions that describe the same view look different to
 * anything comparing them structurally.
 */
function zeroed(n: number): number {
  return n === 0 ? 0 : n;
}

export interface MinimapSize {
  /** Thumbnail size in CSS pixels. */
  width: number;
  height: number;
  /** Thumbnail pixels per stage pixel. */
  scale: number;
}

/**
 * The largest thumbnail of a `stageW x stageH` stage that fits in `maxW x maxH`,
 * keeping the stage's aspect ratio so the overview is not a distorted map.
 *
 * A stage without an area has no meaningful thumbnail; it collapses to zero
 * rather than returning `Infinity` and rendering an SVG with a broken viewBox.
 */
export function minimapSize(
  stageW: number,
  stageH: number,
  maxW: number,
  maxH: number,
): MinimapSize {
  if (!(stageW > 0) || !(stageH > 0)) return { width: 0, height: 0, scale: 0 };
  const scale = Math.min(maxW / stageW, maxH / stageH);
  return { width: Math.round(stageW * scale), height: Math.round(stageH * scale), scale };
}

/**
 * The part of the stage currently on screen, in stage coordinates — the
 * rectangle the overview draws as the viewport indicator.
 *
 * Not clamped to the stage: the stage is freely pannable, so the visible area
 * genuinely can lie partly (or wholly) outside it, and drawing the indicator
 * where it really is — clipped by the thumbnail's edge — is what tells the
 * solver they have panned off the board.
 */
export function visibleRect(view: StageView, stageW: number, stageH: number): Rect {
  return {
    x: zeroed(-view.x / view.scale),
    y: zeroed(-view.y / view.scale),
    width: stageW / view.scale,
    height: stageH / view.scale,
  };
}

/**
 * The stage position that brings `centre` (a stage coordinate) to the middle of
 * the screen, clamped so the visible area stays on the stage — jumping to a spot
 * near an edge must not leave half the view showing nothing.
 *
 * When the stage is zoomed out far enough to fit on screen on an axis, there is
 * nothing to scroll on it and the stage is centred instead.
 */
export function stagePositionFor(
  centre: { x: number; y: number },
  scale: number,
  stageW: number,
  stageH: number,
): { x: number; y: number } {
  /** One axis: the stage offset that puts `c` in the middle of `stage / scale`. */
  function axis(c: number, stage: number): number {
    const visible = stage / scale;
    const maxStart = stage - visible;
    const start =
      maxStart < 0 ? maxStart / 2 : Math.min(maxStart, Math.max(0, c - visible / 2));
    return zeroed(-start * scale);
  }
  return { x: axis(centre.x, stageW), y: axis(centre.y, stageH) };
}

/** One group as the overview draws it: its extent in stage coordinates. */
export interface GroupMarker extends Rect {
  id: number;
  /** Pieces in the group, so the drawing can tell a lone piece from a block. */
  count: number;
}

/**
 * Where every group sits on the stage. Reuses `groupExtent`, so a marker is the
 * group's real footprint and grows as pieces join — no separate notion of size.
 *
 * `minSize` widens a marker that would otherwise be sub-pixel on the thumbnail,
 * around its centre so it still marks the spot. Groups whose extent is unknown
 * are skipped, exactly as `settleGroup` leaves such a group alone: for the one
 * render between a layout rebuild and the group model being reseeded, a group
 * can still name pieces of the previous grid.
 */
export function groupMarkers(
  groups: Iterable<PieceGroup>,
  rectOf: (id: string) => Rect | undefined,
  minSize = 0,
): GroupMarker[] {
  const markers: GroupMarker[] = [];
  for (const g of groups) {
    const extent = groupExtent(g.members, rectOf);
    if (!extent) continue;
    const width = Math.max(extent.width, minSize);
    const height = Math.max(extent.height, minSize);
    markers.push({
      id: g.id,
      count: g.members.length,
      x: g.x + extent.x - (width - extent.width) / 2,
      y: g.y + extent.y - (height - extent.height) / 2,
      width,
      height,
    });
  }
  return markers;
}
