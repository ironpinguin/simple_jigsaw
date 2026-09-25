// Persisting a solve in progress: turning the group model into something that
// can go into localStorage and back, and deciding which old entries to drop when
// writing a new one.
//
// Pure like the rest of lib/puzzle — the storage calls themselves live in the
// components. The only per-piece data stored is the group list: where each
// group's origin lies and which pieces belong to it. Pieces *inside* a group need
// nothing, they sit at solved offsets recomputed from the current piece size, so
// a joined block stays joined and aligned at any window width. Around that sits
// an envelope — `version`, `cols`, `rows`, `updatedAt` — every field of which is
// load-bearing: the first three decide whether an entry may be restored at all,
// the last orders the pruning. `elapsedMs` and `moves` ride along for the solve
// timer (#118); an entry written before they existed reads as zero for both,
// which is why adding them needed no version bump.

import { settleGroup, type Rect } from "./board";
import { pieceId, type PieceGroup } from "./groups";

/**
 * `Number.isFinite` takes `unknown` and narrows nothing, so every value it has
 * vetted still needs a cast. This narrows instead. Behaviour is identical —
 * `Number.isFinite("5")` is already `false`.
 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Bumped whenever the stored shape changes in a way older entries cannot satisfy.
 * A mismatch is rejected rather than migrated: the cost is one restarted puzzle,
 * against carrying a migration path for a throwaway browser cache.
 */
export const SOLVE_STATE_VERSION = 1;

/**
 * Must stay disjoint from the other namespaces on the origin — `pc:` in
 * particular. `PuzzleSolver` prunes by scanning every key with this prefix and
 * deleting what it finds, so an overlap would throw away remembered piece counts.
 */
export const SOLVE_KEY_PREFIX = "solve:";

/**
 * How many puzzles keep a stored solve; the least recently updated are dropped
 * past this. A 300-piece board is roughly 20 kB of JSON, so 20 of them sit well
 * inside the ~5 MB localStorage budget with room for everything else — the cap is
 * there to stop unbounded growth, not because 20 is near any limit.
 */
export const MAX_STORED_SOLVES = 20;

export function solveStateKey(puzzleId: string): string {
  return `${SOLVE_KEY_PREFIX}${puzzleId}`;
}

/**
 * The board a stored state is read against. The two pairs play different roles:
 * `cols`/`rows` are a compatibility key, compared for exact equality and
 * rejected on mismatch; `stageW`/`stageH` are the scale the stored fractions are
 * multiplied back by, and are never compared.
 */
export interface SolveBoard {
  cols: number;
  rows: number;
  stageW: number;
  stageH: number;
}

/** How far a solve has got on the clock: time spent and pieces dropped. */
export interface SolveTiming {
  elapsedMs: number;
  moves: number;
}

export const NO_TIMING: SolveTiming = { elapsedMs: 0, moves: 0 };

export interface SerialiseInput extends SolveBoard {
  groups: Iterable<PieceGroup>;
  /** `Date.now()` from the caller — this module stays free of the clock. */
  updatedAt: number;
  timing?: SolveTiming;
}

/**
 * The stored JSON for one puzzle.
 *
 * Group origins are stored as a fraction of the stage, not in pixels. The stage
 * is sized from the container width and the height left over around it
 * (`boardGeometry`), so a state saved in a maximised window would otherwise
 * restore off-screen in a narrow one.
 */
export function serialiseSolveState({
  groups,
  cols,
  rows,
  stageW,
  stageH,
  updatedAt,
  timing = NO_TIMING,
}: SerialiseInput): string {
  return JSON.stringify({
    version: SOLVE_STATE_VERSION,
    cols,
    rows,
    updatedAt,
    elapsedMs: timing.elapsedMs,
    moves: timing.moves,
    groups: [...groups].map((g) => ({
      x: g.x / stageW,
      y: g.y / stageH,
      members: g.members,
    })),
  });
}

/**
 * The group model held in `raw`, scaled to `board`, or `null` if it cannot be
 * used as-is — no entry, unreadable, a different format version, a different
 * grid, or a piece list that is not exactly this grid once.
 *
 * Rejecting rather than repairing is deliberate: a partially restored board
 * would lose or duplicate pieces, and a fresh scatter is always a valid puzzle.
 *
 * Ids are re-assigned 1..n. The stored ones belong to the finished session's
 * model, and the board seeds its own; `id` is only a key for that `Map`.
 *
 * Positions are returned unclamped, so nothing here guarantees a group is on the
 * board — `restoreSolveState` is what callers should use.
 */
export function deserialiseSolveState(
  raw: string | null,
  { cols, rows, stageW, stageH }: SolveBoard,
): PieceGroup[] | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const state = parsed as Record<string, unknown>;
  if (state.version !== SOLVE_STATE_VERSION) return null;
  if (state.cols !== cols || state.rows !== rows) return null;
  if (!Array.isArray(state.groups)) return null;

  const expected = new Set<string>();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) expected.add(pieceId(r, c));

  const seen = new Set<string>();
  const groups: PieceGroup[] = [];

  for (const entry of state.groups) {
    if (typeof entry !== "object" || entry === null) return null;
    const { x, y, members } = entry as Record<string, unknown>;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    if (!Array.isArray(members) || members.length === 0) return null;

    for (const m of members) {
      // Checking against the grid's own ids rejects every kind of bad member at
      // once — out of range, malformed, or claimed by another group.
      if (typeof m !== "string" || !expected.has(m) || seen.has(m)) return null;
      seen.add(m);
    }

    groups.push({
      id: groups.length + 1,
      x: x * stageW,
      y: y * stageH,
      members: members as string[],
    });
  }

  // Every piece exactly once: the members were checked for range and duplicates
  // above, so matching the count is what rules out a piece having gone missing.
  if (seen.size !== expected.size) return null;

  return groups;
}

/**
 * The group model to resume from, with every group pulled back onto the board, or
 * `null` if the stored state cannot be used (see `deserialiseSolveState`).
 *
 * The settling is not cosmetic. Origins are stored per axis — `x` against
 * `stageW`, `y` against `stageH` — but a piece's size follows the *width* alone
 * (`boardGeometry` gives the assembled picture 40% of `stageW`, then caps its
 * height). So any change to the stage's aspect ratio moves a group's origin
 * without moving its extent by the same amount, and a group that sat flush
 * against an edge can come back overhanging it.
 *
 * `rectOf` is why this takes a callback: the extents come from the rasterised
 * piece bitmaps, which only the board has.
 */
export function restoreSolveState(
  raw: string | null,
  board: SolveBoard,
  rectOf: (id: string) => Rect | undefined,
): PieceGroup[] | null {
  const groups = deserialiseSolveState(raw, board);
  if (!groups) return null;

  for (const g of groups) {
    const settled = settleGroup(g, rectOf, board.stageW, board.stageH);
    if (settled) {
      g.x = settled.x;
      g.y = settled.y;
    }
  }
  return groups;
}

/**
 * The timing stored with a solve state. Only meaningful for an entry the board
 * has just restored — this does not check the envelope, `restoreSolveState` does.
 * A missing or implausible field reads as zero rather than rejecting: the pieces
 * are the valuable part, and a lost time only restarts the clock.
 */
export function readSolveTiming(raw: string | null): SolveTiming {
  if (!raw) return NO_TIMING;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return NO_TIMING;
    const { elapsedMs, moves } = parsed as Record<string, unknown>;
    return {
      elapsedMs: isFiniteNumber(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0,
      moves: Number.isInteger(moves) && (moves as number) >= 0 ? (moves as number) : 0,
    };
  } catch {
    return NO_TIMING;
  }
}

/**
 * Which stored solves to delete before writing `keepKey`, so opening puzzle after
 * puzzle cannot grow localStorage without bound. The least recently updated are
 * dropped first, and entries that could never be restored anyway — unreadable, or
 * written by a different format version — are dropped before any that could.
 *
 * `keepKey` is never returned and always counts against `keep`, whether or not it
 * is among `entries` — it is the one being written.
 *
 * The order of the returned keys carries no meaning; only membership does.
 */
export function solveKeysToPrune(
  entries: Iterable<{ key: string; raw: string | null }>,
  keepKey: string,
  keep: number,
): string[] {
  const others = [...entries]
    .filter((e) => e.key !== keepKey)
    .map((e) => ({ key: e.key, rank: prunePriority(e.raw) }));

  // Most worth keeping first, so the tail past `keep` is what gets dropped.
  // Compared rather than subtracted so the WORTHLESS sentinel cannot produce a
  // NaN; Array.prototype.sort is stable, so entries that tie keep the order they
  // were found in.
  others.sort((a, b) => (a.rank === b.rank ? 0 : a.rank > b.rank ? -1 : 1));

  return others.slice(Math.max(0, keep - 1)).map((e) => e.key);
}

/**
 * Ranks below every real timestamp, so entries that can never be restored are
 * pruned ahead of ones that can. `updatedAt` is `Date.now()`, hence positive.
 */
const WORTHLESS = -1;

/**
 * How worth keeping a stored entry is: when it was last written, or `WORTHLESS`
 * if it cannot be read or names a format version this build would reject on load.
 * Ranking a doomed entry by its recency would let it evict one that still works.
 */
function prunePriority(raw: string | null): number {
  if (!raw) return WORTHLESS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return WORTHLESS;
    const { version, updatedAt } = parsed as Record<string, unknown>;
    if (version !== SOLVE_STATE_VERSION) return WORTHLESS;
    return isFiniteNumber(updatedAt) ? updatedAt : WORTHLESS;
  } catch {
    return WORTHLESS;
  }
}
