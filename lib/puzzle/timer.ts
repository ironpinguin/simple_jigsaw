// How long a solve takes, and the best time per puzzle (issue #118).
//
// Pure like the rest of lib/puzzle: every function takes `now` from the caller,
// so the clock can be driven by hand in tests. The components own the real clock,
// the `visibilitychange` wiring and the storage calls.

/**
 * A stopwatch as data. `elapsedMs` is the time banked by earlier runs;
 * `runningSince` is when the current run began, or `null` while paused. Reading
 * it adds the two, so a running clock never has to be written per tick.
 */
export interface SolveClock {
  elapsedMs: number;
  runningSince: number | null;
}

export function clockAt(elapsedMs: number): SolveClock {
  return { elapsedMs, runningSince: null };
}

/** Starts a paused clock; a running one is returned unchanged. */
export function startClock(clock: SolveClock, now: number): SolveClock {
  return clock.runningSince === null ? { ...clock, runningSince: now } : clock;
}

/** Banks the current run and pauses; a paused clock is returned unchanged. */
export function pauseClock(clock: SolveClock, now: number): SolveClock {
  return clock.runningSince === null ? clock : clockAt(readClock(clock, now));
}

/**
 * The total time on the clock. A `now` before the run began — a clock set back
 * while the tab was open — counts that run as zero rather than subtracting.
 */
export function readClock(clock: SolveClock, now: number): number {
  if (clock.runningSince === null) return clock.elapsedMs;
  return clock.elapsedMs + Math.max(0, now - clock.runningSince);
}

/** `m:ss` below an hour, `h:mm:ss` from there. Rounds down to whole seconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// --- Best times -------------------------------------------------------------

/**
 * Disjoint from `solve:` and `pc:`. Not pruned like the solve states: an entry
 * is a few dozen bytes and only written when a puzzle is finished, and a best
 * time that silently disappears would be the one thing worth complaining about.
 */
export const BEST_KEY_PREFIX = "best:";

export function bestTimesKey(puzzleId: string): string {
  return `${BEST_KEY_PREFIX}${puzzleId}`;
}

export interface SolveResult {
  ms: number;
  moves: number;
}

/** Best result per piece count — the solver can pick another count, and the
    times of a 12- and a 300-piece solve are not comparable. */
export type BestTimes = Record<string, SolveResult>;

/** A plausible stored time: finite and not negative. */
export function isDuration(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** A plausible stored move count: a whole number, not negative. */
export function isMoveCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isResult(v: unknown): v is SolveResult {
  if (typeof v !== "object" || v === null) return false;
  const { ms, moves } = v as Record<string, unknown>;
  return isDuration(ms) && isMoveCount(moves);
}

/** The stored best times, dropping any entry that is not a valid result. */
export function parseBestTimes(raw: string | null): BestTimes {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: BestTimes = {};
  for (const [count, result] of Object.entries(parsed)) {
    if (isResult(result)) out[count] = result;
  }
  return out;
}

/**
 * Enters `result` for `pieceCount`. The faster time wins; fewer moves only break
 * a tie. `previous` is what stood before, for the "new best time" message.
 */
export function recordBestTime(
  raw: string | null,
  pieceCount: number,
  result: SolveResult,
): { raw: string; best: SolveResult; previous: SolveResult | null; isNew: boolean } {
  const times = parseBestTimes(raw);
  const previous = times[pieceCount] ?? null;
  const isNew =
    previous === null ||
    result.ms < previous.ms ||
    (result.ms === previous.ms && result.moves < previous.moves);
  if (isNew) times[pieceCount] = result;
  return { raw: JSON.stringify(times), best: times[pieceCount], previous, isNew };
}
