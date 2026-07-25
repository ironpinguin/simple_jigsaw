// Group/connection logic for free-form solving. Pieces live in a shared "puzzle
// coordinate" frame: piece (row,col) always sits at (col*pieceW, row*pieceH)
// relative to its group's origin. Therefore two pieces are correctly adjacent in
// stage space exactly when their groups' origins coincide. Connecting is thus:
// after a drag, if any member's real grid-neighbour belongs to a different group
// whose origin is within snapDist, snap the origins together and merge — then
// cascade so a single drop can close multiple seams at once.
//
// This module is pure (operates on plain Maps) so it can be unit-tested without
// a browser or Konva.

export interface PieceGroup {
  id: number;
  x: number;
  y: number;
  members: string[];
}

/** Piece id used throughout: `${row}-${col}`. */
export function pieceId(row: number, col: number): string {
  return `${row}-${col}`;
}

export function parsePieceId(id: string): { row: number; col: number } {
  const [row, col] = id.split("-").map(Number);
  return { row, col };
}

/** The in-bounds grid neighbours (up/down/left/right) of a piece. */
export function neighbourIds(id: string, rows: number, cols: number): string[] {
  const { row, col } = parsePieceId(id);
  const candidates: Array<[number, number]> = [
    [row - 1, col],
    [row + 1, col],
    [row, col - 1],
    [row, col + 1],
  ];
  return candidates
    .filter(([r, c]) => r >= 0 && c >= 0 && r < rows && c < cols)
    .map(([r, c]) => pieceId(r, c));
}

/**
 * After the group `draggedId` has been repositioned, merge it with any adjacent
 * neighbouring groups whose origin is now within `snapDist`, cascading through
 * chains. Mutates `groups` and `pieceToGroup` in place. Returns the surviving
 * group id and whether anything merged.
 */
export function resolveConnections(
  groups: Map<number, PieceGroup>,
  pieceToGroup: Map<string, number>,
  draggedId: number,
  rows: number,
  cols: number,
  snapDist: number,
): { survivorId: number; changed: boolean } {
  let current = groups.get(draggedId);
  if (!current) return { survivorId: draggedId, changed: false };

  let changed = false;
  let merged = true;
  while (merged) {
    merged = false;

    let best: { otherId: number; d: number; ox: number; oy: number } | null = null;
    for (const pid of current.members) {
      for (const nid of neighbourIds(pid, rows, cols)) {
        const otherId = pieceToGroup.get(nid);
        if (otherId === undefined || otherId === current.id) continue;
        const other = groups.get(otherId)!;
        const d = Math.hypot(current.x - other.x, current.y - other.y);
        if (d <= snapDist && (best === null || d < best.d)) {
          best = { otherId, d, ox: other.x, oy: other.y };
        }
      }
    }

    if (best) {
      current.x = best.ox;
      current.y = best.oy;
      const other = groups.get(best.otherId)!;
      const survivor: PieceGroup =
        current.members.length >= other.members.length ? current : other;
      const absorbed: PieceGroup = survivor === current ? other : current;
      survivor.x = best.ox;
      survivor.y = best.oy;
      for (const m of absorbed.members) {
        survivor.members.push(m);
        pieceToGroup.set(m, survivor.id);
      }
      groups.delete(absorbed.id);
      current = survivor;
      changed = true;
      merged = true;
    }
  }

  return { survivorId: current.id, changed };
}
