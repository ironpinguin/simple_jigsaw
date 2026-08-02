// View zoom: the limits the stage is kept within, how far one wheel notch
// scales it, and how the level reads out. Pure like the rest of ./puzzle, so
// PuzzleBoard only has to wire wheel events to it.

/** Smallest / largest stage scale the board can be zoomed to. */
export const MIN_SCALE = 0.35;
export const MAX_SCALE = 3;

/**
 * Scale change of one wheel notch. Deliberately small: at the previous 1.12 a
 * normal scroll gesture jumped several steps and overshot.
 */
export const WHEEL_STEP = 1.05;

/** One notch expressed in the unit of each `WheelEvent.deltaMode`. */
const NOTCH_PER_DELTA_MODE = [100, 3, 1]; // pixel, line, page

/**
 * Notches a single wheel event may be worth. Trackpads emit momentum deltas in
 * the thousands, which would otherwise cross the whole zoom range at once.
 */
const MAX_NOTCHES = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampScale(scale: number): number {
  return clamp(scale, MIN_SCALE, MAX_SCALE);
}

/**
 * The factor to multiply the stage scale by for one wheel event. Scrolling down
 * (positive `deltaY`) zooms out. The magnitude is honoured, so a light trackpad
 * nudge moves less than a full mouse notch.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const unit = NOTCH_PER_DELTA_MODE[deltaMode] ?? NOTCH_PER_DELTA_MODE[0];
  const notches = clamp(deltaY / unit, -MAX_NOTCHES, MAX_NOTCHES);
  return WHEEL_STEP ** -notches;
}

/** The zoom readout: stage scale as a whole percentage. */
export function zoomPercent(scale: number): number {
  return Math.round(scale * 100);
}
