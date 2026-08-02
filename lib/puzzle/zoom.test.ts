import { describe, it, expect } from "vitest";
import {
  clampScale,
  MAX_SCALE,
  MIN_SCALE,
  WHEEL_STEP,
  wheelZoomFactor,
  zoomPercent,
} from "./zoom";

/** `WheelEvent.deltaMode` values, named. */
const PIXEL = 0;
const LINE = 1;
const PAGE = 2;

describe("clampScale", () => {
  it("keeps the scale within the board's limits", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(42)).toBe(MAX_SCALE);
    expect(clampScale(1.4)).toBe(1.4);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms out when scrolling down and in when scrolling up", () => {
    expect(wheelZoomFactor(100, PIXEL)).toBeLessThan(1);
    expect(wheelZoomFactor(-100, PIXEL)).toBeGreaterThan(1);
  });

  it("moves one step per notch, whatever unit the browser reports in", () => {
    expect(wheelZoomFactor(-100, PIXEL)).toBeCloseTo(WHEEL_STEP, 10);
    expect(wheelZoomFactor(-3, LINE)).toBeCloseTo(WHEEL_STEP, 10);
    expect(wheelZoomFactor(-1, PAGE)).toBeCloseTo(WHEEL_STEP, 10);
  });

  it("stays gentle: a notch is far short of the old 1.12 jump", () => {
    expect(wheelZoomFactor(-100, PIXEL)).toBeLessThan(1.12);
  });

  it("scales with the delta, so a small trackpad nudge zooms less", () => {
    expect(wheelZoomFactor(-20, PIXEL)).toBeLessThan(wheelZoomFactor(-100, PIXEL));
    expect(wheelZoomFactor(-20, PIXEL)).toBeGreaterThan(1);
  });

  it("is symmetric: scrolling back undoes the zoom exactly", () => {
    for (const delta of [7, 20, 100, 240]) {
      const there = wheelZoomFactor(-delta, PIXEL);
      const back = wheelZoomFactor(delta, PIXEL);
      expect(there * back).toBeCloseTo(1, 10);
    }
  });

  it("caps a flung trackpad gesture so one event cannot jump the whole range", () => {
    const capped = wheelZoomFactor(-100_000, PIXEL);
    expect(capped).toBe(wheelZoomFactor(-1000, PIXEL));
    expect(capped).toBeLessThan(MAX_SCALE / MIN_SCALE);
  });

  it("does nothing for a horizontal-only or empty wheel event", () => {
    expect(wheelZoomFactor(0, PIXEL)).toBe(1);
  });

  it("falls back to pixels for an unknown delta mode", () => {
    expect(wheelZoomFactor(-100, 99)).toBeCloseTo(wheelZoomFactor(-100, PIXEL), 10);
  });
});

describe("zoomPercent", () => {
  it("reads out the scale as a whole percentage", () => {
    expect(zoomPercent(1)).toBe(100);
    expect(zoomPercent(0.35)).toBe(35);
    expect(zoomPercent(1.234)).toBe(123);
  });
});
