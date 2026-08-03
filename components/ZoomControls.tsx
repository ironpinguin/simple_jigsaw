"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { canZoomIn, canZoomOut, zoomPercent } from "@/lib/puzzle/zoom";
import type { ViewStore } from "./viewStore";

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
  store: ViewStore;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  const t = useTranslations("solve");
  const { scale } = useSyncExternalStore(store.subscribe, store.get, store.get);

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
