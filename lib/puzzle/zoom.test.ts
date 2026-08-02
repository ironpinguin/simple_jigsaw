import { describe, it, expect } from "vitest";
import {
  canZoomIn,
  canZoomOut,
  clampScale,
  MAX_SCALE,
  MAX_WHEEL_FACTOR,
  MIN_SCALE,
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

  it("clamps infinities to the limits", () => {
    expect(clampScale(Infinity)).toBe(MAX_SCALE);
    expect(clampScale(-Infinity)).toBe(MIN_SCALE);
  });

  it("recovers from NaN instead of absorbing it", () => {
    // NaN would survive every later multiplication, blanking the board with no
    // way back except the reset button.
    expect(clampScale(NaN)).toBe(1);
  });
});

describe("the zoom limits", () => {
  it("read out as the advertised 35 %–300 %", () => {
    expect(zoomPercent(MIN_SCALE)).toBe(35);
    expect(zoomPercent(MAX_SCALE)).toBe(300);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms out when scrolling down and in when scrolling up", () => {
    expect(wheelZoomFactor(100, PIXEL)).toBeLessThan(1);
    expect(wheelZoomFactor(-100, PIXEL)).toBeGreaterThan(1);
  });

  it("moves one step per notch, whatever unit the browser reports in", () => {
    const perNotch = wheelZoomFactor(-100, PIXEL);
    expect(wheelZoomFactor(-3, LINE)).toBeCloseTo(perNotch, 10);
    expect(wheelZoomFactor(-1, PAGE)).toBeCloseTo(perNotch, 10);
  });

  it("keeps one notch to a gentle few percent", () => {
    // An absolute bound on purpose: every other assertion here is relative, so
    // without one the step could be retuned freely and the suite stay green.
    expect(wheelZoomFactor(-100, PIXEL)).toBeGreaterThan(1.04);
    expect(wheelZoomFactor(-100, PIXEL)).toBeLessThan(1.06);
  });

  it("scales with the delta, so a small trackpad nudge zooms less", () => {
    expect(wheelZoomFactor(-20, PIXEL)).toBeLessThan(wheelZoomFactor(-100, PIXEL));
    expect(wheelZoomFactor(-20, PIXEL)).toBeGreaterThan(1);
  });

  it("returns to the same scale when scrolled back, to floating-point precision", () => {
    for (const delta of [7, 20, 100, 240]) {
      const there = wheelZoomFactor(-delta, PIXEL);
      const back = wheelZoomFactor(delta, PIXEL);
      expect(there * back).toBeCloseTo(1, 10);
    }
  });

  it("saturates past the notch cap, so momentum deltas stop mattering", () => {
    expect(wheelZoomFactor(-100_000, PIXEL)).toBeCloseTo(MAX_WHEEL_FACTOR, 10);
    expect(wheelZoomFactor(100_000, PIXEL)).toBeCloseTo(1 / MAX_WHEEL_FACTOR, 10);
  });

  it("keeps even a capped event to about a tenth of the scale", () => {
    expect(MAX_WHEEL_FACTOR).toBeGreaterThan(1);
    expect(MAX_WHEEL_FACTOR).toBeLessThan(1.11);
  });

  it("needs a couple of dozen events to cross the whole zoom range", () => {
    // The property the cap exists for: no gesture, however flung, walks the
    // board from one limit to the other in a handful of frames.
    const events = Math.log(MAX_SCALE / MIN_SCALE) / Math.log(MAX_WHEEL_FACTOR);
    expect(events).toBeGreaterThan(20);
  });

  it("does nothing for a zero delta", () => {
    expect(wheelZoomFactor(0, PIXEL)).toBe(1);
  });

  it("ignores a non-finite delta instead of poisoning the scale", () => {
    expect(wheelZoomFactor(NaN, PIXEL)).toBe(1);
    expect(wheelZoomFactor(Infinity, PIXEL)).toBe(1);
  });

  it("stays responsive for an unknown delta mode, and still bounded", () => {
    // Reading such a delta as pixels would divide it by 100 and make the wheel
    // look dead; over-reading it is bounded by the notch cap.
    const unknown = wheelZoomFactor(-3, 99);
    expect(unknown).toBeGreaterThan(wheelZoomFactor(-3, PIXEL));
    expect(unknown).toBeLessThanOrEqual(MAX_WHEEL_FACTOR);
  });
});

describe("zoomPercent", () => {
  it("reads out the scale as a whole percentage", () => {
    expect(zoomPercent(1)).toBe(100);
    expect(zoomPercent(0.35)).toBe(35);
    expect(zoomPercent(1.234)).toBe(123);
  });
});

describe("canZoomIn / canZoomOut", () => {
  it("both have room at the default scale", () => {
    expect(canZoomIn(1)).toBe(true);
    expect(canZoomOut(1)).toBe(true);
  });

  it("stops zooming in at the top limit, but can still zoom out", () => {
    expect(canZoomIn(MAX_SCALE)).toBe(false);
    expect(canZoomOut(MAX_SCALE)).toBe(true);
  });

  it("stops zooming out at the bottom limit, but can still zoom in", () => {
    expect(canZoomOut(MIN_SCALE)).toBe(false);
    expect(canZoomIn(MIN_SCALE)).toBe(true);
  });

  it("still has room just inside each limit", () => {
    expect(canZoomIn(MAX_SCALE - 0.01)).toBe(true);
    expect(canZoomOut(MIN_SCALE + 0.01)).toBe(true);
  });
});
