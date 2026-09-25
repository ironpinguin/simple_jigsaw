import { describe, expect, it } from "vitest";
import {
  bestTimesKey,
  clockAt,
  formatDuration,
  parseBestTimes,
  pauseClock,
  readClock,
  recordBestTime,
  startClock,
} from "./timer";

describe("the solve clock", () => {
  it("counts only the time it runs", () => {
    let clock = startClock(clockAt(0), 1_000);
    expect(readClock(clock, 4_000)).toBe(3_000);

    clock = pauseClock(clock, 4_000);
    // A hidden tab: nothing is added while paused.
    expect(readClock(clock, 60_000)).toBe(3_000);

    clock = startClock(clock, 60_000);
    expect(readClock(clock, 62_500)).toBe(5_500);
  });

  it("resumes from a restored elapsed time", () => {
    const clock = startClock(clockAt(90_000), 10);
    expect(readClock(clock, 1_010)).toBe(91_000);
  });

  it("ignores a second start, so a run is not restarted from the later time", () => {
    const clock = startClock(startClock(clockAt(0), 1_000), 5_000);
    expect(readClock(clock, 6_000)).toBe(5_000);
  });

  it("ignores a second pause", () => {
    const paused = pauseClock(startClock(clockAt(0), 0), 2_000);
    expect(pauseClock(paused, 9_000)).toEqual(paused);
  });

  it("never runs backwards when the system clock is set back", () => {
    const clock = startClock(clockAt(4_000), 10_000);
    expect(readClock(clock, 5_000)).toBe(4_000);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [7_000, "0:07"],
    [754_000, "12:34"],
    [3_599_999, "59:59"],
    [3_600_000, "1:00:00"],
    [3_723_000, "1:02:03"],
    [-5, "0:00"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("best times", () => {
  it("keys by puzzle, disjoint from the solve states", () => {
    expect(bestTimesKey("abc")).toBe("best:abc");
  });

  it("records the first result as the best", () => {
    const r = recordBestTime(null, 48, { ms: 90_000, moves: 60 });
    expect(r).toMatchObject({ isNew: true, previous: null, best: { ms: 90_000, moves: 60 } });
    expect(parseBestTimes(r.raw)).toEqual({ 48: { ms: 90_000, moves: 60 } });
  });

  it("keeps the faster time", () => {
    const first = recordBestTime(null, 48, { ms: 90_000, moves: 60 }).raw;

    const slower = recordBestTime(first, 48, { ms: 95_000, moves: 40 });
    expect(slower.isNew).toBe(false);
    expect(slower.best).toEqual({ ms: 90_000, moves: 60 });

    const faster = recordBestTime(first, 48, { ms: 80_000, moves: 70 });
    expect(faster.isNew).toBe(true);
    expect(faster.previous).toEqual({ ms: 90_000, moves: 60 });
    expect(faster.best).toEqual({ ms: 80_000, moves: 70 });
  });

  it("lets fewer moves break a tie on time", () => {
    const first = recordBestTime(null, 12, { ms: 30_000, moves: 20 }).raw;
    expect(recordBestTime(first, 12, { ms: 30_000, moves: 15 }).isNew).toBe(true);
    expect(recordBestTime(first, 12, { ms: 30_000, moves: 20 }).isNew).toBe(false);
  });

  it("keeps one best per piece count", () => {
    const raw = recordBestTime(null, 12, { ms: 30_000, moves: 20 }).raw;
    const r = recordBestTime(raw, 108, { ms: 900_000, moves: 300 });
    expect(r.isNew).toBe(true);
    expect(parseBestTimes(r.raw)).toEqual({
      12: { ms: 30_000, moves: 20 },
      108: { ms: 900_000, moves: 300 },
    });
  });

  it.each([
    ["unreadable", "{nope"],
    ["not an object", "[1,2]"],
    ["null", "null"],
  ])("starts afresh from an %s entry", (_, raw) => {
    expect(parseBestTimes(raw)).toEqual({});
    expect(recordBestTime(raw, 12, { ms: 1, moves: 1 }).isNew).toBe(true);
  });

  it("drops entries that are not valid results but keeps the rest", () => {
    const raw = JSON.stringify({
      12: { ms: 30_000, moves: 20 },
      48: { ms: -1, moves: 3 },
      108: { ms: "fast", moves: 3 },
      300: { ms: 5, moves: 2.5 },
    });
    expect(parseBestTimes(raw)).toEqual({ 12: { ms: 30_000, moves: 20 } });
  });
});
