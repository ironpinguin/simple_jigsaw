// View zoom: the limits the stage is kept within, how far one wheel notch
// scales it, and how the level reads out. Pure like the rest of ./puzzle, so
// the board component wires wheel events, the readout and the button limits to
// it without owning any of the numbers.

/**
 * The stage transform, mirrored out of Konva.
 *
 * `x`/`y` are the stage's own position — the offset applied *after* scaling, so
 * a stage panned right has a positive `x` while the content shown starts at a
 * negative stage coordinate. `scale` is kept within the limits below by
 * `clampScale`, which is what lets every reader divide by it.
 *
 * Lives here rather than with the overview that draws it: this describes the
 * camera, which the zoom controls and the board share.
 */
export interface StageView {
  x: number;
  y: number;
  scale: number;
}

/** Smallest stage scale the board can be zoomed to (the readout's 35 %). */
export const MIN_SCALE = 0.35;

/** Largest stage scale the board can be zoomed to (the readout's 300 %). */
export const MAX_SCALE = 3;

/**
 * Scale change of one wheel notch.
 *
 * The old code applied a flat 1.12 to *every* wheel event, so a single gesture
 * — dozens of events on a trackpad — compounded into a huge jump. Scaling by
 * the reported delta is what fixes that; this smaller step is what makes one
 * discrete mouse notch land softly on top of it.
 */
export const WHEEL_STEP = 1.05;

/**
 * `deltaY` that one detent reports in each `WheelEvent.deltaMode`. The array
 * index *is* the spec's `DOM_DELTA_*` value, so the order is load-bearing:
 *
 * - `DOM_DELTA_PIXEL` (0) — Chrome/Firefox emit ~100px per detent.
 * - `DOM_DELTA_LINE` (1) — Firefox's default of three lines per detent.
 * - `DOM_DELTA_PAGE` (2) — one page per detent.
 *
 * Trackpads report many small pixel deltas instead of detents, which is why the
 * factor is proportional to the delta rather than applied per event.
 */
const NOTCH_PER_DELTA_MODE = [100, 3, 1];

/**
 * The unit for a `deltaMode` outside the spec's enum. Falling back to the
 * smallest unit over-reads such a delta, but `MAX_NOTCHES` bounds that; falling
 * back to pixels would divide a line-sized delta by 100 and make the wheel look
 * dead, which is the failure this module exists to avoid.
 */
const FALLBACK_UNIT = Math.min(...NOTCH_PER_DELTA_MODE);

/**
 * Notches a single wheel event may be worth. Trackpad momentum can report
 * several thousand pixels in one event, and crossing the whole 0.35–3 range
 * takes ~44 notches, so an uncapped event could jump most of it in one frame.
 * Two notches (~10 %) is the largest jump that still reads as a deliberate
 * step — and stays under the flat 1.12 the old code applied per event.
 */
const MAX_NOTCHES = 2;

/** The most a single wheel event can scale the stage, in either direction. */
export const MAX_WHEEL_FACTOR = WHEEL_STEP ** MAX_NOTCHES;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Keeps a stage scale within the board's limits. `NaN` has no sensible clamp
 * and would be absorbing — it would blank the canvas and survive every later
 * multiplication — so it recovers to 1 rather than propagating.
 */
export function clampScale(scale: number): number {
  if (Number.isNaN(scale)) return 1;
  return clamp(scale, MIN_SCALE, MAX_SCALE);
}

/**
 * The factor to multiply the stage scale by for one wheel event. Scrolling down
 * (positive `deltaY`) zooms out.
 *
 * The magnitude is honoured up to `MAX_NOTCHES`, past which the factor
 * saturates — the result is always within
 * `[1 / MAX_WHEEL_FACTOR, MAX_WHEEL_FACTOR]`, so a light trackpad nudge moves
 * less than a full mouse notch and a flung one cannot cross the range.
 *
 * Exponential rather than additive so the transform is symmetric: scrolling
 * back the same distance returns to the previous scale exactly. The notch clamp
 * is symmetric about zero too, so that holds past the cap as well.
 *
 * A non-finite `deltaY` is a no-op, so a bad event cannot poison the scale.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY)) return 1;
  const unit = NOTCH_PER_DELTA_MODE[deltaMode] ?? FALLBACK_UNIT;
  const notches = clamp(deltaY / unit, -MAX_NOTCHES, MAX_NOTCHES);
  return WHEEL_STEP ** -notches;
}

/** The zoom readout: stage scale as a whole percentage. */
export function zoomPercent(scale: number): number {
  return Math.round(scale * 100);
}

/**
 * Whether the zoom controls still have room to move. These live next to the
 * limits so the two mirrored comparisons are unit-tested rather than inlined
 * into JSX, where an inverted operator would disable a working control and
 * still pass lint, types and build.
 */
export function canZoomIn(scale: number): boolean {
  return scale < MAX_SCALE;
}

export function canZoomOut(scale: number): boolean {
  return scale > MIN_SCALE;
}
