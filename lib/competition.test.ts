import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTEMPT_MAX_MS,
  CLOCK_SLACK_MS,
  CompetitionSettingsSchema,
  DisplayNameSchema,
  competitionPhase,
  isBetterResult,
  judgeSubmission,
  minimumSolveMs,
} from "./competition";
import { signCompetitionStart, verifyCompetitionStart } from "./competition-token";

const at = (iso: string) => new Date(iso);

describe("competitionPhase", () => {
  const window = { startsAt: at("2026-10-01T10:00:00Z"), endsAt: at("2026-10-08T10:00:00Z") };

  it("is upcoming before the start, open from it, closed from the end", () => {
    expect(competitionPhase(window, at("2026-10-01T09:59:59Z"))).toBe("UPCOMING");
    expect(competitionPhase(window, at("2026-10-01T10:00:00Z"))).toBe("OPEN");
    expect(competitionPhase(window, at("2026-10-08T09:59:59Z"))).toBe("OPEN");
    expect(competitionPhase(window, at("2026-10-08T10:00:00Z"))).toBe("CLOSED");
  });

  it("treats a missing bound as open on that side", () => {
    expect(competitionPhase({ startsAt: null, endsAt: null }, at("2000-01-01T00:00:00Z"))).toBe(
      "OPEN",
    );
    expect(
      competitionPhase({ startsAt: null, endsAt: window.endsAt }, at("2026-10-09T00:00:00Z")),
    ).toBe("CLOSED");
  });
});

describe("judgeSubmission", () => {
  const start = 1_000_000;
  const base = { pieceCount: 12, startedAt: start };

  it("accepts a time that fits the attempt", () => {
    expect(judgeSubmission({ ...base, ms: 60_000, now: start + 65_000 })).toBe("OK");
  });

  it("refuses a time faster than the floor for the piece count", () => {
    expect(minimumSolveMs(12)).toBe(6_000);
    expect(judgeSubmission({ ...base, ms: 5_999, now: start + 60_000 })).toBe("TOO_FAST");
    expect(judgeSubmission({ ...base, ms: 6_000, now: start + 60_000 })).toBe("OK");
  });

  it("refuses more time than has passed since the start, beyond the slack", () => {
    const now = start + 60_000;
    expect(judgeSubmission({ ...base, ms: 60_000 + CLOCK_SLACK_MS, now })).toBe("OK");
    expect(judgeSubmission({ ...base, ms: 60_001 + CLOCK_SLACK_MS, now })).toBe(
      "LONGER_THAN_ATTEMPT",
    );
  });

  it("refuses an attempt older than a start token lives", () => {
    expect(judgeSubmission({ ...base, ms: 60_000, now: start + ATTEMPT_MAX_MS + 1 })).toBe(
      "EXPIRED",
    );
  });

  it("refuses a start in the future", () => {
    expect(judgeSubmission({ ...base, ms: 60_000, now: start - 1 })).toBe("BAD_START");
  });
});

describe("isBetterResult", () => {
  it("prefers the faster time and lets fewer moves break a tie", () => {
    expect(isBetterResult({ ms: 10, moves: 5 }, null)).toBe(true);
    expect(isBetterResult({ ms: 9, moves: 99 }, { ms: 10, moves: 5 })).toBe(true);
    expect(isBetterResult({ ms: 10, moves: 4 }, { ms: 10, moves: 5 })).toBe(true);
    expect(isBetterResult({ ms: 10, moves: 5 }, { ms: 10, moves: 5 })).toBe(false);
    expect(isBetterResult({ ms: 11, moves: 1 }, { ms: 10, moves: 5 })).toBe(false);
  });
});

describe("DisplayNameSchema", () => {
  it("normalises whitespace", () => {
    expect(DisplayNameSchema.parse("  Puzzle   Fan ")).toBe("Puzzle Fan");
  });

  it.each([
    ["too short", "a"],
    ["blank", "     "],
    ["too long", "x".repeat(31)],
    ["a control character", "ab\u0007cd"],
    ["an invisible formatting character", "ab​cd"],
    ["a bidi override", "ab‮cd"],
    ["only Hangul fillers", "\u3164\u3164\u3164"],
    ["only blank Braille patterns", "\u2800\u2800"],
    ["a private-use character", "ab\ue000cd"],
  ])("refuses a name that is %s", (_, name) => {
    expect(DisplayNameSchema.safeParse(name).success).toBe(false);
  });

  it("accepts letters beyond ASCII", () => {
    expect(DisplayNameSchema.parse("Jürgen Ölçer")).toBe("Jürgen Ölçer");
  });
});

describe("CompetitionSettingsSchema", () => {
  it("accepts a preset piece count and an ordered window", () => {
    const parsed = CompetitionSettingsSchema.safeParse({
      pieceCount: 48,
      startsAt: "2026-10-01T10:00:00Z",
      endsAt: "2026-10-08T10:00:00+02:00",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an open-ended window", () => {
    expect(
      CompetitionSettingsSchema.safeParse({ pieceCount: 12, startsAt: null, endsAt: null }).success,
    ).toBe(true);
  });

  it.each([
    ["a piece count that is not a preset", { pieceCount: 50, startsAt: null, endsAt: null }],
    [
      "an end before the start",
      { pieceCount: 12, startsAt: "2026-10-08T10:00:00Z", endsAt: "2026-10-01T10:00:00Z" },
    ],
    ["a date that is not ISO", { pieceCount: 12, startsAt: "tomorrow", endsAt: null }],
  ])("refuses %s", (_, input) => {
    expect(CompetitionSettingsSchema.safeParse(input).success).toBe(false);
  });
});

describe("the competition start token", () => {
  beforeEach(() => vi.stubEnv("AUTH_SECRET", "test-secret"));
  afterEach(() => vi.unstubAllEnvs());

  it("verifies for the puzzle and user it was issued to", () => {
    const token = signCompetitionStart("p1", "u1", 1_700_000_000_000);
    expect(verifyCompetitionStart(token, "p1", "u1")).toBe(1_700_000_000_000);
  });

  it("does not verify for another puzzle or another user", () => {
    const token = signCompetitionStart("p1", "u1", 1_700_000_000_000);
    expect(verifyCompetitionStart(token, "p2", "u1")).toBeNull();
    expect(verifyCompetitionStart(token, "p1", "u2")).toBeNull();
  });

  it("does not verify with a moved start time", () => {
    const token = signCompetitionStart("p1", "u1", 1_700_000_000_000);
    const [, sig] = token.split(".");
    expect(verifyCompetitionStart(`1700000999000.${sig}`, "p1", "u1")).toBeNull();
  });

  it("does not verify under another secret", () => {
    const token = signCompetitionStart("p1", "u1", 1_700_000_000_000);
    vi.stubEnv("AUTH_SECRET", "other-secret");
    expect(verifyCompetitionStart(token, "p1", "u1")).toBeNull();
  });

  it.each(["", "nope", "123.", ".abc", "12.34.56", `1.${"a".repeat(44)}`])(
    "rejects the malformed token %j",
    (token) => {
      expect(verifyCompetitionStart(token, "p1", "u1")).toBeNull();
    },
  );

  it("refuses to sign without a secret", () => {
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => signCompetitionStart("p1", "u1", 1)).toThrow(/AUTH_SECRET/);
  });
});
