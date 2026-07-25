import { describe, it, expect } from "vitest";
import {
  neighbourIds,
  resolveConnections,
  pieceId,
  type PieceGroup,
} from "./groups";

function setup(defs: Array<{ id: number; x: number; y: number; members: string[] }>) {
  const groups = new Map<number, PieceGroup>();
  const p2g = new Map<string, number>();
  for (const d of defs) {
    groups.set(d.id, { ...d, members: [...d.members] });
    for (const m of d.members) p2g.set(m, d.id);
  }
  return { groups, p2g };
}

describe("neighbourIds", () => {
  it("returns in-bounds orthogonal neighbours", () => {
    expect(neighbourIds(pieceId(0, 0), 3, 3).sort()).toEqual(["0-1", "1-0"]);
    expect(neighbourIds(pieceId(1, 1), 3, 3).sort()).toEqual(["0-1", "1-0", "1-2", "2-1"]);
  });
});

describe("resolveConnections", () => {
  it("merges two adjacent groups whose origins coincide", () => {
    const { groups, p2g } = setup([
      { id: 1, x: 100, y: 100, members: ["0-0"] },
      { id: 2, x: 103, y: 98, members: ["0-1"] }, // within snapDist of group 1
    ]);
    const res = resolveConnections(groups, p2g, 1, 2, 2, 20);
    expect(res.changed).toBe(true);
    expect(groups.size).toBe(1);
    const survivor = groups.get(res.survivorId)!;
    expect(survivor.members.sort()).toEqual(["0-0", "0-1"]);
    // origins snapped exactly together
    expect(survivor.x).toBe(103);
    expect(survivor.y).toBe(98);
  });

  it("does not merge when origins are too far apart", () => {
    const { groups, p2g } = setup([
      { id: 1, x: 100, y: 100, members: ["0-0"] },
      { id: 2, x: 200, y: 100, members: ["0-1"] },
    ]);
    const res = resolveConnections(groups, p2g, 1, 2, 2, 20);
    expect(res.changed).toBe(false);
    expect(groups.size).toBe(2);
  });

  it("does not merge non-adjacent pieces even at the same origin", () => {
    // (0,0) and (1,1) are diagonal — not grid neighbours.
    const { groups, p2g } = setup([
      { id: 1, x: 50, y: 50, members: ["0-0"] },
      { id: 2, x: 50, y: 50, members: ["1-1"] },
    ]);
    const res = resolveConnections(groups, p2g, 1, 2, 2, 20);
    expect(res.changed).toBe(false);
    expect(groups.size).toBe(2);
  });

  it("cascades: one drop can close several seams at once", () => {
    // Groups for (0,0), (0,1) already joined; (1,0) sits at the same origin and
    // is a neighbour of (0,0). Dragging a fourth piece (1,1) onto the origin
    // should absorb everything into a single group.
    const { groups, p2g } = setup([
      { id: 1, x: 0, y: 0, members: ["0-0", "0-1"] },
      { id: 2, x: 0, y: 0, members: ["1-0"] },
      { id: 3, x: 2, y: 1, members: ["1-1"] }, // dragged, within snapDist
    ]);
    const res = resolveConnections(groups, p2g, 3, 2, 2, 20);
    expect(res.changed).toBe(true);
    expect(groups.size).toBe(1);
    const survivor = groups.get(res.survivorId)!;
    expect(survivor.members.sort()).toEqual(["0-0", "0-1", "1-0", "1-1"]);
  });
});
