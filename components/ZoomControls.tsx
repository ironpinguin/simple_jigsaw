"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { canZoomIn, canZoomOut, zoomPercent } from "@/lib/puzzle/zoom";

/**
 * The stage scale, mirrored out of Konva for the zoom controls to render.
 *
 * Deliberately not React state: the wheel and pinch handlers update it at
 * display refresh rate, and re-rendering the board that often would rebuild
 * every piece group's inline event handlers, which react-konva compares by
 * identity — so it would detach and reattach all of them on every frame of a
 * gesture, on boards of up to several hundred pieces. Only `ZoomControls`
 * subscribes here, so zooming re-renders four elements instead of the tree.
 *
 * Konva owns the real transform; this is a copy of it. Anything that writes
 * `stage.scale()` must publish here too, or the readout and the +/− limits
 * silently drift out of sync with the board.
 */
export function createScaleStore(initial = 1) {
  let scale = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => scale,
    set(next: number) {
      if (next === scale) return;
      scale = next;
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

export type ScaleStore = ReturnType<typeof createScaleStore>;

/**
 * `aria-disabled` rather than `disabled`: the browser moves focus to `<body>`
 * when the control under it becomes disabled, which is exactly what a keyboard
 * user hits on the press that reaches a zoom limit. This keeps the button
 * focusable and announced as unavailable.
 */
function ZoomButton({
  label,
  enabled = true,
  onPress,
  children,
}: {
  label: string;
  enabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={!enabled}
      onClick={() => {
        if (enabled) onPress();
      }}
    >
      {children}
    </button>
  );
}

export default function ZoomControls({
  store,
  onZoomIn,
  onZoomOut,
  onReset,
}: {
  store: ScaleStore;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  const t = useTranslations("solve");
  const scale = useSyncExternalStore(store.subscribe, store.get, store.get);

  return (
    <div className="zoom-controls">
      {/*
        `aria-live="off"`: `<output>` is a polite live region by default, and one
        scroll gesture pushes dozens of percentages through it — a screen reader
        would still be reading them out seconds after the gesture ended. The
        value stays readable on demand.
      */}
      <output className="zoom-level" aria-live="off" aria-label={t("zoomLevel")}>
        {t("zoomPercent", { percent: zoomPercent(scale) })}
      </output>
      <ZoomButton label={t("zoomIn")} enabled={canZoomIn(scale)} onPress={onZoomIn}>
        +
      </ZoomButton>
      <ZoomButton label={t("zoomOut")} enabled={canZoomOut(scale)} onPress={onZoomOut}>
        −
      </ZoomButton>
      <ZoomButton label={t("resetView")} onPress={onReset}>
        ⟲
      </ZoomButton>
    </div>
  );
}
