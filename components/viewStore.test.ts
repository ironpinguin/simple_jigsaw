import { describe, expect, it, vi } from "vitest";
import { createViewStore } from "./viewStore";

const view = (x: number, y: number, scale = 1) => ({ x, y, scale });

describe("the mirrored stage transform", () => {
  it("hands out the same snapshot until the view really changes", () => {
    // `useSyncExternalStore` re-reads the snapshot on every render and compares
    // it with Object.is: a fresh object per call is an infinite re-render.
    const store = createViewStore();
    const first = store.get();
    expect(store.get()).toBe(first);
    store.set(view(0, 0, 1));
    expect(store.get()).toBe(first);
    store.set(view(0, 0, 2));
    expect(store.get()).not.toBe(first);
  });

  it("keeps no reference a caller could mutate behind its back", () => {
    const initial = view(1, 2, 3);
    const store = createViewStore(initial);
    initial.x = 99;
    expect(store.get().x).toBe(1);

    const next = view(4, 5, 6);
    store.set(next);
    next.x = 99;
    expect(store.get().x).toBe(4);
  });

  it("says nothing when the view is unchanged", () => {
    // Every frame of a piece drag republishes the same transform; without this
    // the overview would re-render at refresh rate for no visible change.
    const store = createViewStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(view(0, 0, 1));
    expect(listener).not.toHaveBeenCalled();
    store.set(view(10, 0, 1));
    expect(listener).toHaveBeenCalledOnce();
  });

  it("notifies every subscriber, not just the first", () => {
    // The board hands one store to both the zoom controls and the overview.
    const store = createViewStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.set(view(5, 5));
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("unsubscribes one subscriber without silencing the others", () => {
    // Hiding the overview unmounts it. If that tore down the zoom controls'
    // subscription too, the readout would freeze and the +/− buttons would keep
    // stale limits — at maximum zoom, unable to zoom out ever again.
    const store = createViewStore();
    const stays = vi.fn();
    const goes = vi.fn();
    store.subscribe(stays);
    const unsubscribe = store.subscribe(goes);

    unsubscribe();
    store.set(view(5, 5));

    expect(goes).not.toHaveBeenCalled();
    expect(stays).toHaveBeenCalledOnce();
  });

  it("survives the same subscriber leaving twice", () => {
    const store = createViewStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    unsubscribe();
    store.set(view(1, 1));
    expect(listener).not.toHaveBeenCalled();
  });
});
