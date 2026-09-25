"use client";

import type { SolveTiming } from "@/lib/puzzle/solveState";
import {
  clockAt,
  pauseClock,
  readClock,
  startClock,
  type SolveClock,
  type SolveResult,
} from "@/lib/puzzle/timer";

/**
 * The solve timer (#118) as an external store. A store rather than state in
 * `PuzzleSolver`: the solver renders the board, and a clock ticking in its state
 * would re-render the Konva stage every second. Only `SolveTimerDisplay`
 * subscribes, and only it ticks.
 *
 * The clock runs from the first piece picked up until the puzzle is finished,
 * and is paused while the tab is hidden. After a reload it waits, paused at the
 * restored time, for the next piece to be picked up. Every `now` comes from the
 * caller, and `visible` too, so this runs in plain node.
 */
export interface SolveTimerSnapshot {
  clock: SolveClock;
  moves: number;
}

export interface SolveTimer {
  get(): SolveTimerSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Start from what the board seeded: zero for a fresh scatter, or the timing
   * stored with a restored state — `null` if it has none, which leaves the solve
   * untimed: the clock runs from zero, but `timing` and `finish` give `null`, so
   * nothing it shows is saved or recorded as a result. `finished` for a restored
   * solved puzzle — its clock stays stopped and moving the finished picture
   * counts nothing.
   */
  reset(timing: SolveTiming | null, finished: boolean): void;
  /** A piece was picked up. */
  grab(now: number, visible: boolean): void;
  /** A piece was put down. */
  drop(): void;
  /** Pauses; `true` if the clock was running, i.e. there is new time to save. */
  hide(now: number): boolean;
  show(now: number): void;
  /** Stops the clock for good and returns the result, `null` if untimed; see `reset`. */
  finish(now: number): SolveResult | null;
  /** What to save with the solve state, `null` if untimed; see `reset`. */
  timing(now: number): SolveTiming | null;
}

export function createSolveTimer(): SolveTimer {
  let snapshot: SolveTimerSnapshot = { clock: clockAt(0), moves: 0 };
  // Whether a piece has been picked up since the last reset, so a shown tab knows
  // to carry on — as opposed to a restored solve still waiting for its first move.
  let active = false;
  let finished = false;
  let timed = true;
  const listeners = new Set<() => void>();

  function publish(next: SolveTimerSnapshot) {
    if (next.clock === snapshot.clock && next.moves === snapshot.moves) return;
    snapshot = next;
    for (const l of listeners) l();
  }

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset(timing, isFinished) {
      active = false;
      finished = isFinished;
      timed = timing !== null;
      publish({ clock: clockAt(timing?.elapsedMs ?? 0), moves: timing?.moves ?? 0 });
    },
    grab(now, visible) {
      if (finished) return;
      active = true;
      if (visible) publish({ ...snapshot, clock: startClock(snapshot.clock, now) });
    },
    drop() {
      if (finished) return;
      publish({ ...snapshot, moves: snapshot.moves + 1 });
    },
    hide(now) {
      const running = snapshot.clock.runningSince !== null;
      publish({ ...snapshot, clock: pauseClock(snapshot.clock, now) });
      return running;
    },
    show(now) {
      if (active && !finished) publish({ ...snapshot, clock: startClock(snapshot.clock, now) });
    },
    finish(now) {
      finished = true;
      publish({ ...snapshot, clock: pauseClock(snapshot.clock, now) });
      return timed ? { ms: snapshot.clock.elapsedMs, moves: snapshot.moves } : null;
    },
    timing: (now) =>
      timed ? { elapsedMs: readClock(snapshot.clock, now), moves: snapshot.moves } : null,
  };
}
