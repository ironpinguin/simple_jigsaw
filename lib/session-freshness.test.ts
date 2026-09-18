import { describe, it, expect } from "vitest";
import { isSessionStale, SESSION_CUTOFF_MARGIN_MS } from "./session-freshness";

/** `iat` is whole seconds since the epoch; a DateTime is milliseconds. */
const at = (seconds: number, ms = 0) => new Date(seconds * 1000 + ms);

/** The first second a token can be issued in and still survive a change at t. */
const MARGIN_SECONDS = SESSION_CUTOFF_MARGIN_MS / 1000;

describe("isSessionStale", () => {
  it("keeps every session when the password has never changed", () => {
    expect(isSessionStale(1_000, null)).toBe(false);
    expect(isSessionStale(0, null)).toBe(false);
  });

  it("rejects a token issued before the change", () => {
    expect(isSessionStale(1_000, at(1_001))).toBe(true);
  });

  it("keeps a token issued past the margin", () => {
    expect(isSessionStale(1_002 + MARGIN_SECONDS, at(1_001))).toBe(false);
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

  it("reaches past the change by the commit margin", () => {
    // The stamp is taken before the row commits and Auth.js stamps `iat` after
    // the read that saw no stamp, so a cookie re-issued during the write can
    // carry an `iat` later than the change it survived. The cutoff covers that
    // window; without it that cookie never goes stale again.
    expect(isSessionStale(1_001 + MARGIN_SECONDS, at(1_001))).toBe(true);
    expect(isSessionStale(1_001 + MARGIN_SECONDS, at(1_001, 999))).toBe(true);
  });

  it("states the margin, so shortening it is a deliberate edit", () => {
    expect(SESSION_CUTOFF_MARGIN_MS).toBe(1_000);
  });

  it("treats a token with no issue time as stale", () => {
    // A token we cannot date is one we cannot vouch for.
    expect(isSessionStale(undefined, at(1_001))).toBe(true);
  });

  it("does not treat an undatable token as stale when nothing has changed", () => {
    expect(isSessionStale(undefined, null)).toBe(false);
  });
});
