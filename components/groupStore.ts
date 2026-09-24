"use client";

import type { PieceGroup } from "@/lib/puzzle/groups";

/**
 * Which pieces are joined and where each group lies — the board's model.
 *
 * Every change yields a new snapshot, and a snapshot is never modified once
 * published: `useSyncExternalStore` compares snapshots by identity and may hold
 * on to an old one while a render is in flight, so writing into a published
 * map would show a half-applied drop.
 */
export interface GroupModel {
  groups: ReadonlyMap<number, Readonly<PieceGroup>>;
  pieceToGroup: ReadonlyMap<string, number>;
}

export interface GroupStore {
  get(): GroupModel;
  subscribe(listener: () => void): () => void;
  /** Start over from `groups` — a scatter or a restored solve. */
  replace(groups: Iterable<PieceGroup>): void;
  /**
   * Apply one change. `change` gets private copies it may mutate freely — the
   * `lib/puzzle` helpers work in place — and the groups are published afterwards
   * as the next snapshot. The member index handed in is scratch space for those
   * helpers: the published one is rebuilt from the groups, so a change that only
   * edits `groups` cannot leave the two disagreeing. Returns whatever `change`
   * returns.
   */
  update<T>(change: (groups: Map<number, PieceGroup>, pieceToGroup: Map<string, number>) => T): T;
}

function copyGroups(groups: Iterable<Readonly<PieceGroup>>): Map<number, PieceGroup> {
  const out = new Map<number, PieceGroup>();
  for (const g of groups) out.set(g.id, { ...g, members: [...g.members] });
  return out;
}

function indexMembers(groups: ReadonlyMap<number, PieceGroup>): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of groups.values()) for (const m of g.members) out.set(m, g.id);
  return out;
}

/**
 * The group model as an external store, the way `viewStore` holds the stage
 * transform. It used to live in refs that the drag handlers mutated, with a
 * version counter bumped to make React read them back (#87). That hid the model
 * from React: a render read the refs whenever it happened to run, and a drop
 * only showed up because an unrelated state update landed in the same handler.
 *
 * Nothing here changes per drag frame — Konva moves the node itself and the
 * model is written once, on drop — so subscribing costs no more renders than
 * the old bump did.
 */
export function createGroupStore(): GroupStore {
  let model: GroupModel = { groups: new Map(), pieceToGroup: new Map() };
  const listeners = new Set<() => void>();
  const publish = (groups: Map<number, PieceGroup>) => {
    model = { groups, pieceToGroup: indexMembers(groups) };
    for (const listener of listeners) listener();
  };
  return {
    get: () => model,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    replace(groups) {
      publish(copyGroups(groups));
    },
    update(change) {
      const groups = copyGroups(model.groups.values());
      const result = change(groups, new Map(model.pieceToGroup));
      publish(groups);
      return result;
    },
  };
}
