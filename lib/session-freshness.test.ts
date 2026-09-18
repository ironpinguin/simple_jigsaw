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

  it("treats a token issued in the same second as the change as stale, because `iat` is re-stamped on every read", () => {
    // Auth.js re-stamps `iat` on every session read, so a token issued in the
    // same second as the change is not necessarily the pre-change cookie —
    // it could be a cookie re-issued *after* the change but still landing in
    // that second, which would otherwise carry that second forward and never
    // go stale. Do not relax this back to `<`: that was tried and reopens a
    // permanent escape for exactly the cookie this feature exists to kill.
    // The cost is a same-second re-login being bounced once, on purpose.
    expect(isSessionStale(1_001, at(1_001, 400))).toBe(true);
    expect(isSessionStale(1_001, at(1_001, 999))).toBe(true);
  });

  it("treats a token with no issue time as stale", () => {
    // A token we cannot date is one we cannot vouch for.
    expect(isSessionStale(undefined, at(1_001))).toBe(true);
  });

  it("does not treat an undatable token as stale when nothing has changed", () => {
    expect(isSessionStale(undefined, null)).toBe(false);
  });
});
