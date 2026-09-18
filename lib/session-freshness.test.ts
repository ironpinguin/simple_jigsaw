import { describe, it, expect } from "vitest";
import { isSessionStale } from "./session-freshness";

/** `iat` is whole seconds since the epoch; a DateTime is milliseconds. */
const at = (seconds: number, ms = 0) => new Date(seconds * 1000 + ms);

describe("isSessionStale", () => {
  it("keeps every session when the password has never changed", () => {
    expect(isSessionStale(1_000, null)).toBe(false);
    expect(isSessionStale(0, null)).toBe(false);
  });

  it("rejects a token issued before the change", () => {
    expect(isSessionStale(1_000, at(1_001))).toBe(true);
  });

  it("keeps a token issued after the change", () => {
    expect(isSessionStale(1_002, at(1_001))).toBe(false);
  });

  it("keeps a token issued in the same second as the change", () => {
    // The deliberate sub-second window. `iat` has no sub-second precision, so
    // the alternative is rejecting the fresh session of someone who signs back
    // in within the same second as their own change. A token issued in that
    // second is not a threat worth that.
    expect(isSessionStale(1_001, at(1_001, 400))).toBe(false);
    expect(isSessionStale(1_001, at(1_001, 999))).toBe(false);
  });

  it("treats a token with no issue time as stale", () => {
    // A token we cannot date is one we cannot vouch for.
    expect(isSessionStale(undefined, at(1_001))).toBe(true);
  });

  it("does not treat an undatable token as stale when nothing has changed", () => {
    expect(isSessionStale(undefined, null)).toBe(false);
  });
});
