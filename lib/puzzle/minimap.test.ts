import { describe, it, expect } from "vitest";
import { pieceId, type PieceGroup } from "./groups";
import type { Rect } from "./board";
import {
  groupMarkers,
  minimapSize,
  stagePositionFor,
  visibleRect,
  type StageView,
} from "./minimap";

const STAGE_W = 1200;
const STAGE_H = 800;

/** Every piece is a 20×20 bitmap whose corner sits on its cell corner. */
const PIECE = 20;
const rectOf = (id: string): Rect | undefined => {
  const [row, col] = id.split("-").map(Number);
  return { x: col * PIECE, y: row * PIECE, width: PIECE, height: PIECE };
};

const view = (partial: Partial<StageView> = {}): StageView => ({
  x: 0,
  y: 0,
  scale: 1,
  ...partial,
});

describe("minimapSize", () => {
  it("fits the box and keeps the stage's aspect ratio", () => {
    const size = minimapSize(STAGE_W, STAGE_H, 190, 150);
    expect(size.width).toBeLessThanOrEqual(190);
    expect(size.height).toBeLessThanOrEqual(150);
    expect(size.width / size.height).toBeCloseTo(STAGE_W / STAGE_H, 1);
  });

  it("is limited by whichever side runs out first", () => {
    // Wide stage: the width is the binding constraint, and vice versa.
    expect(minimapSize(2000, 500, 200, 200).width).toBe(200);
    expect(minimapSize(500, 2000, 200, 200).height).toBe(200);
  });

  it("reports the thumbnail pixels per stage pixel", () => {
    const size = minimapSize(1000, 1000, 200, 200);
    expect(size.scale).toBeCloseTo(0.2, 6);
  });

  it("collapses instead of dividing by an empty stage", () => {
    expect(minimapSize(0, 800, 190, 150)).toEqual({ width: 0, height: 0, scale: 0 });
    expect(minimapSize(1200, 0, 190, 150)).toEqual({ width: 0, height: 0, scale: 0 });
  });
});

describe("visibleRect", () => {
  it("is the whole stage when nothing is zoomed or panned", () => {
    expect(visibleRect(view(), STAGE_W, STAGE_H)).toEqual({
      x: 0,
      y: 0,
      width: STAGE_W,
      height: STAGE_H,
    });
  });

  it("shrinks as the board is zoomed in", () => {
    const r = visibleRect(view({ scale: 2 }), STAGE_W, STAGE_H);
    expect(r.width).toBe(STAGE_W / 2);
    expect(r.height).toBe(STAGE_H / 2);
  });

  it("moves the opposite way to the stage: panning right shows what is left", () => {
    const r = visibleRect(view({ x: 100, y: 50 }), STAGE_W, STAGE_H);
    expect(r).toMatchObject({ x: -100, y: -50 });
  });

  it("reports a view panned off the board rather than clamping it", () => {
    // Honest rather than tidy: the indicator leaving the thumbnail is what tells
    // the solver the board is no longer under the viewport.
    const r = visibleRect(view({ x: -5000, scale: 2 }), STAGE_W, STAGE_H);
    expect(r.x).toBe(2500);
    expect(r.x).toBeGreaterThan(STAGE_W);
  });
});

describe("stagePositionFor", () => {
  /** What `stagePositionFor` is specified in terms of: the resulting view. */
  const resulting = (centre: { x: number; y: number }, scale: number) =>
    visibleRect(
      { ...stagePositionFor(centre, scale, STAGE_W, STAGE_H), scale },
      STAGE_W,
      STAGE_H,
    );

  it("puts the requested point in the middle of the screen", () => {
    const r = resulting({ x: 600, y: 400 }, 2);
    expect(r.x + r.width / 2).toBeCloseTo(600, 6);
    expect(r.y + r.height / 2).toBeCloseTo(400, 6);
  });

  it("keeps the view on the board near a corner instead of showing emptiness", () => {
    for (const centre of [
      { x: 0, y: 0 },
      { x: STAGE_W, y: STAGE_H },
      { x: 0, y: STAGE_H },
    ]) {
      const r = resulting(centre, 2);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(STAGE_W);
      expect(r.y + r.height).toBeLessThanOrEqual(STAGE_H);
    }
  });

  it("centres the stage when it is zoomed out far enough to fit", () => {
    // Nothing to scroll to: every jump lands on the same centred view.
    const a = stagePositionFor({ x: 0, y: 0 }, 0.5, STAGE_W, STAGE_H);
    const b = stagePositionFor({ x: STAGE_W, y: STAGE_H }, 0.5, STAGE_W, STAGE_H);
    expect(a).toEqual(b);
    const r = resulting({ x: 0, y: 0 }, 0.5);
    expect(r.x + r.width / 2).toBeCloseTo(STAGE_W / 2, 6);
    expect(r.y + r.height / 2).toBeCloseTo(STAGE_H / 2, 6);
  });

  it("is a no-op at 100 %, where the stage exactly fills the screen", () => {
    expect(stagePositionFor({ x: 900, y: 100 }, 1, STAGE_W, STAGE_H)).toEqual({ x: 0, y: 0 });
  });
});

describe("groupMarkers", () => {
  const group = (id: number, x: number, y: number, members: string[]): PieceGroup => ({
    id,
    x,
    y,
    members,
  });

  it("places a lone piece at its position on the stage", () => {
    // Piece (1,2) sits at (40, 20) inside its group, so a group origin of
    // (300, 200) puts the bitmap at (340, 220).
    const [marker] = groupMarkers([group(1, 300, 200, [pieceId(1, 2)])], rectOf);
    expect(marker).toMatchObject({ id: 1, count: 1, x: 340, y: 220, width: 20, height: 20 });
  });

  it("grows a marker to the joined block's full footprint", () => {
    const members = [pieceId(0, 0), pieceId(0, 1), pieceId(1, 0), pieceId(1, 1)];
    const [marker] = groupMarkers([group(7, 0, 0, members)], rectOf);
    expect(marker).toMatchObject({ count: 4, x: 0, y: 0, width: 40, height: 40 });
  });

  it("keeps a sub-pixel marker visible without moving it", () => {
    const [marker] = groupMarkers([group(1, 100, 100, [pieceId(0, 0)])], rectOf, 50);
    expect(marker.width).toBe(50);
    expect(marker.height).toBe(50);
    // Widened around its centre, which stays where the piece is.
    expect(marker.x + marker.width / 2).toBe(110);
    expect(marker.y + marker.height / 2).toBe(110);
  });

  it("leaves a marker alone when it is already bigger than the minimum", () => {
    const [marker] = groupMarkers([group(1, 0, 0, [pieceId(0, 0)])], rectOf, 5);
    expect(marker).toMatchObject({ x: 0, y: 0, width: 20, height: 20 });
  });

  it("preserves the order it is given, so the board's draw order carries over", () => {
    const groups = [
      group(1, 0, 0, [pieceId(0, 0), pieceId(0, 1)]),
      group(2, 50, 50, [pieceId(1, 0)]),
    ];
    expect(groupMarkers(groups, rectOf).map((m) => m.id)).toEqual([1, 2]);
  });

  it("skips a group whose pieces the layout does not know", () => {
    // The one render between a layout rebuild and the group model being
    // reseeded, where a group still names pieces of the previous grid.
    const markers = groupMarkers([group(1, 0, 0, ["9-9"])], () => undefined);
    expect(markers).toEqual([]);
  });
});
