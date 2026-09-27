import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signAttemptStart, verifyAttemptStart } from "./attempt-token";
import { signCompetitionStart, verifyCompetitionStart } from "./competition-token";

beforeEach(() => vi.stubEnv("AUTH_SECRET", "test-secret"));
afterEach(() => vi.unstubAllEnvs());

describe("attempt start tokens", () => {
  it("hand back when the attempt started, for the puzzle and user they were issued for", () => {
    const token = signAttemptStart("best-time-start:v1", "p1", "u1", 1_000);
    expect(verifyAttemptStart("best-time-start:v1", token, "p1", "u1")).toBe(1_000);
  });

  it("are not accepted for another puzzle or another user", () => {
    const token = signAttemptStart("best-time-start:v1", "p1", "u1", 1_000);
    expect(verifyAttemptStart("best-time-start:v1", token, "p2", "u1")).toBeNull();
    expect(verifyAttemptStart("best-time-start:v1", token, "p1", "u2")).toBeNull();
  });

  it("never cross between a best time and a competition (#127)", () => {
    // A best-time start is handed out for any puzzle at any time; accepted as a
    // competition start, it would get an attempt begun before the competition
    // opened onto its leaderboard.
    const best = signAttemptStart("best-time-start:v1", "p1", "u1", 1_000);
    expect(verifyCompetitionStart(best, "p1", "u1")).toBeNull();
    const competition = signCompetitionStart("p1", "u1", 1_000);
    expect(verifyAttemptStart("best-time-start:v1", competition, "p1", "u1")).toBeNull();
  });

  it("keep competition starts issued before the split valid", () => {
    // Same purpose string as before lib/attempt-token.ts existed, so a start
    // held in a browser across the deploy still verifies.
    const token = signCompetitionStart("p1", "u1", 1_000);
    expect(verifyAttemptStart("competition-start:v1", token, "p1", "u1")).toBe(1_000);
  });

  it("reject a tampered start time", () => {
    const token = signAttemptStart("best-time-start:v1", "p1", "u1", 1_000);
    const forged = token.replace(/^\d+/, "2000");
    expect(verifyAttemptStart("best-time-start:v1", forged, "p1", "u1")).toBeNull();
  });

  it("refuse to sign without a secret", () => {
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => signAttemptStart("best-time-start:v1", "p1", "u1", 1_000)).toThrow(/AUTH_SECRET/);
  });
});
