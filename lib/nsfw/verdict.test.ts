import { describe, expect, it } from "vitest";
import { labelFor, requiresReview, toVerdictLabel } from "./verdict";

describe("labelFor", () => {
  it("calls a score below the threshold clean", () => {
    expect(labelFor(0.4, 0.85)).toBe("CLEAN");
  });

  it("flags a score above the threshold", () => {
    expect(labelFor(0.9, 0.85)).toBe("FLAGGED");
  });

  it("flags a score exactly at the threshold", () => {
    // The threshold is the point where review starts, not the point after it:
    // an off-by-one here is the difference between reviewing a borderline
    // image and publishing it.
    expect(labelFor(0.85, 0.85)).toBe("FLAGGED");
  });

  it("refuses a score outside 0..1 rather than guessing", () => {
    // A classifier returning a percentage instead of a probability would
    // otherwise read as permanently clean.
    expect(labelFor(-0.1, 0.85)).toBe("UNKNOWN");
    expect(labelFor(42, 0.85)).toBe("UNKNOWN");
    expect(labelFor(Number.NaN, 0.85)).toBe("UNKNOWN");
  });
});

describe("toVerdictLabel", () => {
  it("accepts the three stored values", () => {
    expect(toVerdictLabel("CLEAN")).toBe("CLEAN");
    expect(toVerdictLabel("FLAGGED")).toBe("FLAGGED");
    expect(toVerdictLabel("UNKNOWN")).toBe("UNKNOWN");
  });

  it("rejects anything else, so a bad column cannot reach a translation lookup", () => {
    expect(toVerdictLabel("clean")).toBeNull();
    expect(toVerdictLabel("")).toBeNull();
  });
});

describe("requiresReview", () => {
  it("holds back both a hit and an unusable answer", () => {
    expect(requiresReview("FLAGGED")).toBe(true);
    expect(requiresReview("UNKNOWN")).toBe(true);
  });

  it("lets a clean image through", () => {
    expect(requiresReview("CLEAN")).toBe(false);
  });
});
