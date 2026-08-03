// Persisting a solve in progress: turning the group model into something that
// can go into localStorage and back, and deciding which old entries to drop when
// writing a new one.
//
// Pure like the rest of lib/puzzle — the storage calls themselves live in the
// components. What is stored is only the group list: where each group's origin
// lies and which pieces belong to it. Pieces *inside* a group need nothing, they
// sit at solved offsets recomputed from the current piece size, so a joined block
// stays joined and aligned at any window width.

import { pieceId, type PieceGroup } from "./groups";

/**
 * Bumped whenever the stored shape changes in a way older entries cannot satisfy.
 * A mismatch is rejected rather than migrated: the cost is one restarted puzzle,
 * against carrying a migration path for a throwaway browser cache.
 */
export const SOLVE_STATE_VERSION = 1;

export const SOLVE_KEY_PREFIX = "solve:";

/** How many puzzles keep a stored solve; the oldest are dropped past this. */
export const MAX_STORED_SOLVES = 20;

export function solveStateKey(puzzleId: string): string {
  return `${SOLVE_KEY_PREFIX}${puzzleId}`;
}

/** The board a stored state has to match to be usable. */
export interface SolveBoard {
  cols: number;
  rows: number;
  stageW: number;
  stageH: number;
}

export interface SerialiseInput extends SolveBoard {
  groups: Iterable<PieceGroup>;
  /** `Date.now()` from the caller — this module stays free of the clock. */
  updatedAt: number;
}

/**
 * The stored JSON for one puzzle.
 *
 * Group origins are stored as a fraction of the stage, not in pixels. The stage
 * is sized from the container width and the window height (`boardGeometry`), so a
 * state saved in a maximised window would otherwise restore off-screen in a
 * narrow one.
 */
export function serialiseSolveState({
  groups,
  cols,
  rows,
  stageW,
  stageH,
  updatedAt,
}: SerialiseInput): string {
  return JSON.stringify({
    version: SOLVE_STATE_VERSION,
    cols,
    rows,
    updatedAt,
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
 * model, and the board seeds its own.
 *
 * Positions are returned unclamped — the caller settles them, because only it
 * knows the pieces' bitmap extents.
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
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (!Array.isArray(members) || members.length === 0) return null;

    for (const m of members) {
      // Checking against the grid's own ids rejects every kind of bad member at
      // once — out of range, malformed, or claimed by another group.
      if (typeof m !== "string" || !expected.has(m) || seen.has(m)) return null;
      seen.add(m);
    }

    groups.push({
      id: groups.length + 1,
      x: (x as number) * stageW,
      y: (y as number) * stageH,
      members: members as string[],
    });
  }

  // Every piece exactly once: the members were checked for range and duplicates
  // above, so matching the count is what rules out a piece having gone missing.
  if (seen.size !== expected.size) return null;

  return groups;
}

/**
 * Which stored solves to delete before writing `keepKey`, so opening puzzle after
 * puzzle cannot grow localStorage without bound. The least recently updated go
 * first, and entries that cannot be read at all go before any that can.
 *
 * `keepKey` is never returned and always counts against `keep`, whether or not it
 * is among `entries` — it is the one being written.
 */
export function solveKeysToPrune(
  entries: Iterable<{ key: string; raw: string | null }>,
  keepKey: string,
  keep: number,
): string[] {
  const others = [...entries]
    .filter((e) => e.key !== keepKey)
    .map((e) => ({ key: e.key, updatedAt: storedUpdatedAt(e.raw) }));

  // Newest first, unreadable last; Array.prototype.sort is stable, so entries
  // that tie keep the order they were found in.
  others.sort((a, b) => b.updatedAt - a.updatedAt);

  return others.slice(Math.max(0, keep - 1)).map((e) => e.key);
}

/** When an entry was last written, or `-Infinity` if that cannot be read. */
function storedUpdatedAt(raw: string | null): number {
  if (!raw) return -Infinity;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return -Infinity;
    const { updatedAt } = parsed as Record<string, unknown>;
    return Number.isFinite(updatedAt) ? (updatedAt as number) : -Infinity;
  } catch {
    return -Infinity;
  }
}
