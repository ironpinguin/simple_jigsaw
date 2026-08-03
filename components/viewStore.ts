"use client";

import type { StageView } from "@/lib/puzzle/zoom";

/**
 * Read side of the mirrored stage transform — what the overlays are given.
 *
 * `get` returns the same object until the view really changes:
 * `useSyncExternalStore` re-reads it on every render and compares with
 * `Object.is`, so a fresh object per call is an infinite re-render, not merely a
 * redundant one. That is why `set` compares field by field before swapping.
 */
export interface ViewSource {
  get(): Readonly<StageView>;
  subscribe(listener: () => void): () => void;
}

/** Write side: only the board holds this, because only it owns the stage. */
export interface ViewStore extends ViewSource {
  set(next: StageView): void;
}

/**
 * The stage transform, mirrored out of Konva for the overlays to render.
 *
 * Deliberately not React state: the wheel, pinch and pan handlers update it at
 * display refresh rate, and re-rendering the board that often would rebuild
 * every piece group's inline event handlers, which react-konva compares by
 * identity — so it would detach and reattach all of them on every frame of a
 * gesture, on boards of up to several hundred pieces. Only the overlays
 * subscribe here, so a gesture re-renders the zoom readout and the overview —
 * the latter cheaply only because of the marker memo in `BoardMinimap`.
 *
 * Konva owns the real transform; this is a copy of it. Anything that writes
 * `stage.scale()` or `stage.position()` — or lets Konva move the stage itself,
 * as the Stage's own `draggable` does — must publish here too, or the readout,
 * the +/− limits and the overview's viewport indicator silently drift out of
 * sync with the board.
 */
export function createViewStore(initial: StageView = { x: 0, y: 0, scale: 1 }): ViewStore {
  // Copied in and copied on write: the snapshot `useSyncExternalStore` holds
  // must not be something a caller still has a reference to and can mutate.
  let view: Readonly<StageView> = { x: initial.x, y: initial.y, scale: initial.scale };
  const listeners = new Set<() => void>();
  return {
    get: () => view,
    set(next: StageView) {
      if (next.x === view.x && next.y === view.y && next.scale === view.scale) return;
      view = { x: next.x, y: next.y, scale: next.scale };
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
