import { describe, expect, it, vi } from "vitest";
import { createGroupStore } from "./groupStore";

const seed = [
  { id: 1, x: 0, y: 0, members: ["0-0"] },
  { id: 2, x: 50, y: 0, members: ["0-1", "0-2"] },
];

describe("createGroupStore", () => {
  it("hands a change an index of every member", () => {
    const store = createGroupStore();
    store.replace(seed);
    expect(store.update((_groups, pieceToGroup) => [...pieceToGroup])).toEqual([
      ["0-0", 1],
      ["0-1", 2],
      ["0-2", 2],
    ]);
  });

  it("does not hold on to the caller's groups", () => {
    const store = createGroupStore();
    const input = seed.map((g) => ({ ...g, members: [...g.members] }));
    store.replace(input);
    input[0].x = 999;
    input[0].members.push("9-9");
    expect(store.get().groups.get(1)).toEqual(seed[0]);
  });

  it("publishes a new snapshot per change and never touches a published one", () => {
    const store = createGroupStore();
    store.replace(seed);
    const before = store.get();
    const beforeGroup = structuredClone(before.groups.get(1));

    store.update((groups) => {
      groups.get(1)!.x = 10;
      groups.get(1)!.members.push("1-0");
    });

    expect(store.get()).not.toBe(before);
    expect(store.get().groups.get(1)).toMatchObject({ x: 10, members: ["0-0", "1-0"] });
    expect(before.groups.get(1)).toEqual(beforeGroup);
  });

  it("indexes the groups the previous change left behind", () => {
    const store = createGroupStore();
    store.replace(seed);
    // Membership edited through `groups` alone, index left untouched.
    store.update((groups) => {
      groups.get(2)!.members.push(...groups.get(1)!.members);
      groups.delete(1);
    });
    expect(store.update((_groups, pieceToGroup) => [...pieceToGroup])).toEqual([
      ["0-1", 2],
      ["0-2", 2],
      ["0-0", 2],
    ]);
  });

  it("builds each change's index afresh, whatever the last one wrote into it", () => {
    const store = createGroupStore();
    store.replace(seed);
    store.update((_groups, pieceToGroup) => {
      pieceToGroup.set("0-0", 99);
    });
    expect(store.update((_groups, pieceToGroup) => pieceToGroup.get("0-0"))).toBe(1);
  });

  it("returns what the change returns", () => {
    const store = createGroupStore();
    store.replace(seed);
    expect(store.update((groups) => groups.size)).toBe(2);
  });

  it("tells subscribers about every change until they unsubscribe", () => {
    const store = createGroupStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.replace(seed);
    store.update(() => {});
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.update(() => {});
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the same snapshot between changes", () => {
    // useSyncExternalStore re-reads get() on every render and compares by
    // identity; a fresh object per call would re-render forever.
    const store = createGroupStore();
    store.replace(seed);
    expect(store.get()).toBe(store.get());
  });
});
