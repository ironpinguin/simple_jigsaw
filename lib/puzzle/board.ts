// Board geometry: how big the stage and the assembled picture are, where a
// piece's bitmap sits inside its group, where the loose pieces start out, and
// where a group must end up after a drag. Kept free of canvas and Konva calls
// (like ./groups) so all of it is unit-testable in plain node — PuzzleBoard adds
// only the rasterising and the event wiring on top.

import type { EdgeGrid } from "./edges";
import { pieceOutlinePoints } from "./outline";
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
  /**
   * Height the stage may take without pushing the page into a scrollbar, i.e.
   * the window minus the chrome above and below the board. The caller measures
   * it — a constant here went stale the moment a footer was added below the
   * board, and only this module's caller can see the real layout.
   */
  availableH: number;
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
  availableH,
  aspect,
  cols,
  rows,
}: GeometryInput): BoardGeometry {
  const stageW = Math.max(360, containerW);
  // The floor wins on a short window: a stage below this is unplayable, and a
  // scrollbar is the better trade.
  const stageH = Math.max(520, Math.floor(availableH));

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
  stageW: number;
  stageH: number;
  /** A piece's bitmap rect in group coordinates — `pieceBox(...).rect`. */
  rectOf: (id: string) => Rect;
}

/**
 * The starting position of every piece: one single-piece group per cell,
 * spread over the stage so that no piece hides another.
 *
 * The stage is divided into a grid of at least `cols * rows` equal slots, the
 * pieces are dealt onto a seeded shuffle of those slots, and each bitmap is
 * jittered within whatever room its slot leaves. Where a slot is at least as
 * big as the bitmap (any desktop-sized window) no two bitmaps overlap at all; on
 * a stage too small for that they overlap only by the shortfall, centred on the
 * slot, so each still keeps most of its hit area. Uniform random placement put
 * a few pieces entirely under others at 300 pieces (issue #3).
 *
 * Positions come from the exact bitmap rect and are clamped like a drop, so a
 * piece starts wholly inside the stage — `settleGroup` would leave it alone.
 * The group origin is the placed rect minus the piece's own rect offset, which
 * keeps the shared puzzle coordinate frame intact.
 *
 * Deterministic in its inputs, and the random stream depends only on `seed`, so
 * the same link produces the same relative arrangement for everyone. Absolute
 * positions still scale with the viewport, because `stageW`/`stageH` are
 * viewport-derived.
 */
export function scatterGroups({
  cols,
  rows,
  seed,
  stageW,
  stageH,
  rectOf,
}: ScatterInput): PieceGroup[] {
  const count = cols * rows;
  const rng = mulberry32(seed ^ 0x9e3779b9);

  // Slots as close to square as the stage allows, enough for every piece.
  const slotCols = Math.max(1, Math.round(Math.sqrt((count * stageW) / stageH)));
  const slotRows = Math.ceil(count / slotCols);
  const slotW = stageW / slotCols;
  const slotH = stageH / slotRows;

  const slots = Array.from({ length: slotCols * slotRows }, (_, i) => i);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }

  /** Near edge of the bitmap along one axis: jittered if it fits, else centred. */
  function place(slotStart: number, slotSize: number, size: number): number {
    const slack = slotSize - size;
    const t = rng(); // drawn either way, so the stream does not depend on sizes
    return slotStart + (slack >= 0 ? t * slack : slack / 2);
  }

  const groups: PieceGroup[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = pieceId(r, c);
      const slot = slots[groups.length];
      const rect = rectOf(id);
      const x = place((slot % slotCols) * slotW, slotW, rect.width);
      const y = place(Math.floor(slot / slotCols) * slotH, slotH, rect.height);
      const pos = clampGroupPosition({ x: x - rect.x, y: y - rect.y }, rect, stageW, stageH);
      groups.push({ id: groups.length + 1, x: pos.x, y: pos.y, members: [id] });
    }
  }
  return groups;
}

export interface GatherInput {
  groups: Iterable<PieceGroup>;
  stageW: number;
  stageH: number;
  rectOf: (id: string) => Rect | undefined;
}

/** Scales tried, largest first, when slots of bitmap size do not all fit. */
const GATHER_SCALES = [1, 0.9, 0.8, 0.7, 0.6, 0.5];

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * New positions for every loose (single-piece) group, collected into the area
 * no assembly covers so the leftovers are in one predictable place instead of
 * strewn among the assemblies (issue #4). Assemblies stay where they are.
 *
 * The stage is cut into slots the size of the largest loose bitmap; a slot
 * touching an assembly's extent is taken. Loose pieces fill the free slots in
 * reading order from the top-left, keeping their own reading order by current
 * position — so gathering again changes nothing, and nothing is hinted about
 * where a piece belongs. If the free slots are too few the slots shrink, down
 * to half a bitmap, letting neighbours overlap a little; if even that is not
 * enough the rest spill onto slots over assemblies, where `renderOrder` still
 * draws them on top. Every position is clamped like a drop.
 *
 * Returns the moved groups only, as copies; an empty array when there is
 * nothing loose to gather.
 */
export function gatherLoose({ groups, stageW, stageH, rectOf }: GatherInput): PieceGroup[] {
  const loose: { g: PieceGroup; rect: Rect }[] = [];
  const taken: Rect[] = [];
  for (const g of groups) {
    const extent = groupExtent(g.members, rectOf);
    if (!extent) continue;
    if (g.members.length === 1) loose.push({ g, rect: extent });
    else taken.push({ ...extent, x: g.x + extent.x, y: g.y + extent.y });
  }
  if (loose.length === 0) return [];

  // By centre, not corner: a gathered bitmap is centred in its slot, so centres
  // in one slot row line up whatever each piece's tabs add. Rounded to the pixel
  // so float noise cannot split a row.
  const at = ({ g, rect }: (typeof loose)[number]) => ({
    x: Math.round(g.x + rect.x + rect.width / 2),
    y: Math.round(g.y + rect.y + rect.height / 2),
  });
  loose.sort((a, b) => at(a).y - at(b).y || at(a).x - at(b).x || a.g.id - b.g.id);

  const cellW = Math.max(...loose.map((l) => l.rect.width));
  const cellH = Math.max(...loose.map((l) => l.rect.height));

  /** Slots at `scale`, free ones first (each list in reading order). */
  function slotsAt(scale: number): { free: Rect[]; all: Rect[] } {
    const w = cellW * scale;
    const h = cellH * scale;
    const cols = Math.max(1, Math.floor(stageW / w));
    const rows = Math.max(1, Math.floor(stageH / h));
    const free: Rect[] = [];
    const over: Rect[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const slot = { x: c * w, y: r * h, width: w, height: h };
        (taken.some((t) => overlaps(slot, t)) ? over : free).push(slot);
      }
    }
    return { free, all: [...free, ...over] };
  }

  function pickSlots(): Rect[] {
    for (const scale of GATHER_SCALES) {
      const { free } = slotsAt(scale);
      if (free.length >= loose.length) return free;
    }
    // Keep shrinking past the floor only as far as the stage itself demands.
    let scale = GATHER_SCALES[GATHER_SCALES.length - 1];
    let all = slotsAt(scale).all;
    while (all.length < loose.length) {
      scale *= 0.9;
      all = slotsAt(scale).all;
    }
    return all;
  }
  const slots = pickSlots();

  return loose.map(({ g, rect }, i) => {
    const slot = slots[i];
    const x = slot.x + (slot.width - rect.width) / 2 - rect.x;
    const y = slot.y + (slot.height - rect.height) / 2 - rect.y;
    const pos = clampGroupPosition({ x, y }, rect, stageW, stageH);
    return { ...g, members: [...g.members], x: pos.x, y: pos.y };
  });
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
