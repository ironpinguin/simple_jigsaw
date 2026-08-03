"use client";

import type { StageView } from "@/lib/puzzle/minimap";

/**
 * The stage transform, mirrored out of Konva for the overlays to render.
 *
 * Deliberately not React state: the wheel, pinch and pan handlers update it at
 * display refresh rate, and re-rendering the board that often would rebuild
 * every piece group's inline event handlers, which react-konva compares by
 * identity — so it would detach and reattach all of them on every frame of a
 * gesture, on boards of up to several hundred pieces. Only the overlays
 * subscribe here, so a gesture re-renders the zoom readout and the overview
 * instead of the tree.
 *
 * Konva owns the real transform; this is a copy of it. Anything that writes
 * `stage.scale()` or `stage.position()` must publish here too, or the readout,
 * the +/− limits and the overview's viewport indicator silently drift out of
 * sync with the board.
 */
export function createViewStore(initial: StageView = { x: 0, y: 0, scale: 1 }) {
  let view = initial;
  const listeners = new Set<() => void>();
  return {
    // `useSyncExternalStore` compares snapshots by identity and re-reads on
    // every render, so an unchanged view has to return the very same object —
    // hence the field-by-field comparison rather than replacing it each time.
    get: () => view,
    set(next: StageView) {
      if (next.x === view.x && next.y === view.y && next.scale === view.scale) return;
      view = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type ViewStore = ReturnType<typeof createViewStore>;
