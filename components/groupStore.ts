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
}

export interface GroupStore {
  get(): GroupModel;
  subscribe(listener: () => void): () => void;
  /** Start over from `groups` — a scatter or a restored solve. */
  replace(groups: Iterable<PieceGroup>): void;
  /**
   * Apply one change. `change` gets private copies it may mutate freely — the
   * `lib/puzzle` helpers work in place — and those copies are then published as
   * the next snapshot. So `change` must be synchronous and must not write to the
   * store itself, and nothing may write through a reference to the copies, or to
   * groups it put in, once it has returned: from then on they are the published
   * snapshot. Return plain values. The member index handed in is scratch space
   * for those helpers, built from the copies and never published, so a change
   * that only edits `groups` cannot leave a stale one behind. Returns whatever
   * `change` returns.
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
 * The group model as an external store, read through `useSyncExternalStore`.
 *
 * Every write happens outside a render — in the drop and gather handlers and in
 * the seeding effect — and the writer reads the result straight back: the group
 * count to report, the model to save. A store hands it the latest model
 * synchronously, whichever render its closure came from. As React state,
 * seeding would set state from an effect, which `react-hooks/set-state-in-effect`
 * rejects; as refs (what this replaced, #87), React would not see a change at
 * all — every write had to force a re-render by hand, and rendering read mutable
 * refs, which `react-hooks/refs` rejects.
 *
 * Unlike `viewStore`, this is not about render cost: the board itself
 * subscribes. Nothing here changes per drag frame — Konva moves the node itself
 * and the model is written once, on drop — so a drop, a gather or a reseed costs
 * one render, as it would with state.
 */
export function createGroupStore(): GroupStore {
  let model: GroupModel = { groups: new Map() };
  const listeners = new Set<() => void>();
  const publish = (groups: Map<number, PieceGroup>) => {
    model = { groups };
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
      const result = change(groups, indexMembers(groups));
      publish(groups);
      return result;
    },
  };
}
