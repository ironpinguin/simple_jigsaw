import { describe, expect, it, vi } from "vitest";
import { NO_TIMING } from "@/lib/puzzle/solveState";
import { readClock } from "@/lib/puzzle/timer";
import { createSolveTimer } from "./solveTimer";

function elapsed(timer: ReturnType<typeof createSolveTimer>, now: number) {
  return readClock(timer.get().clock, now);
}

describe("createSolveTimer", () => {
  it("waits for the first piece to be picked up", () => {
    const timer = createSolveTimer();
    timer.reset(NO_TIMING, false);
    expect(elapsed(timer, 10_000)).toBe(0);

    timer.grab(10_000, true);
    expect(elapsed(timer, 13_000)).toBe(3_000);
  });

  it("counts a move per drop", () => {
    const timer = createSolveTimer();
    timer.reset(NO_TIMING, false);
    timer.grab(0, true);
    timer.drop();
    timer.drop();
    expect(timer.get().moves).toBe(2);
    expect(timer.timing(4_000)).toEqual({ elapsedMs: 4_000, moves: 2 });
  });

  it("pauses while the tab is hidden and carries on when it is shown", () => {
    const timer = createSolveTimer();
    timer.reset(NO_TIMING, false);
    timer.grab(0, true);

    expect(timer.hide(5_000)).toBe(true);
    expect(elapsed(timer, 60_000)).toBe(5_000);
    // Nothing more to save for a second hide.
    expect(timer.hide(61_000)).toBe(false);

    timer.show(60_000);
    expect(elapsed(timer, 62_000)).toBe(7_000);
  });

  it("does not start on a shown tab before anything was picked up", () => {
    const timer = createSolveTimer();
    timer.reset({ elapsedMs: 90_000, moves: 12 }, false);
    timer.show(1_000);
    expect(elapsed(timer, 50_000)).toBe(90_000);
  });

  it("does not start on a pick-up in a hidden tab, but once it is shown", () => {
    const timer = createSolveTimer();
    timer.reset(NO_TIMING, false);
    timer.grab(0, false);
    expect(elapsed(timer, 5_000)).toBe(0);
    timer.show(5_000);
    expect(elapsed(timer, 6_000)).toBe(1_000);
  });

  it("resumes a restored solve from its stored time and moves", () => {
    const timer = createSolveTimer();
    timer.reset({ elapsedMs: 90_000, moves: 12 }, false);
    timer.grab(1_000, true);
    timer.drop();
    expect(timer.timing(3_000)).toEqual({ elapsedMs: 92_000, moves: 13 });
  });

  it("stops for good once finished", () => {
    const timer = createSolveTimer();
    timer.reset(NO_TIMING, false);
    timer.grab(0, true);
    timer.drop();

    expect(timer.finish(42_000)).toEqual({ ms: 42_000, moves: 1 });

    // Moving the finished picture around changes nothing.
    timer.grab(50_000, true);
    timer.drop();
    timer.show(60_000);
    expect(timer.timing(99_000)).toEqual({ elapsedMs: 42_000, moves: 1 });
  });

  it("keeps a restored solved puzzle stopped", () => {
    const timer = createSolveTimer();
    timer.reset({ elapsedMs: 30_000, moves: 9 }, true);
    timer.grab(0, true);
    timer.drop();
    expect(timer.timing(10_000)).toEqual({ elapsedMs: 30_000, moves: 9 });
  });

  it("runs an untimed solve but gives nothing to save or record", () => {
    const timer = createSolveTimer();
    timer.reset(null, false);
    timer.grab(0, true);
    timer.drop();
    expect(elapsed(timer, 4_000)).toBe(4_000);
    expect(timer.timing(4_000)).toBeNull();
    expect(timer.finish(5_000)).toBeNull();

    // Starting over times it again.
    timer.reset(NO_TIMING, false);
    expect(timer.timing(0)).toEqual({ elapsedMs: 0, moves: 0 });
  });

  it("starts over from zero on a reset", () => {
    const timer = createSolveTimer();
    timer.reset(NO_TIMING, false);
    timer.grab(0, true);
    timer.drop();
    timer.reset(NO_TIMING, false);
    expect(timer.timing(10_000)).toEqual({ elapsedMs: 0, moves: 0 });
  });

  it("notifies subscribers on a change and not on a no-op", () => {
    const timer = createSolveTimer();
    const listener = vi.fn();
    timer.subscribe(listener);

    timer.hide(0); // paused already
    expect(listener).not.toHaveBeenCalled();

    timer.grab(0, true);
    expect(listener).toHaveBeenCalledTimes(1);
    const running = timer.get();
    timer.grab(5, true); // running already
    expect(listener).toHaveBeenCalledTimes(1);
    expect(timer.get()).toBe(running);
  });
});
