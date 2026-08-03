"use client";

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import type { PieceGroup } from "@/lib/puzzle/groups";
import type { Rect } from "@/lib/puzzle/board";
import { groupMarkers, minimapSize, visibleRect } from "@/lib/puzzle/minimap";
import type { ViewStore } from "./viewStore";

/** Largest thumbnail, in CSS pixels; the CSS caps it again on narrow screens. */
const MAX_W = 190;
const MAX_H = 150;

/** Smallest marker on the thumbnail, in thumbnail pixels. */
const MIN_MARKER = 2.5;

/** How far one arrow key pans, as a fraction of the visible area. */
const PAN_STEP = 0.25;

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * The board overview: the whole stage as a thumbnail, every group on it, and the
 * part of it currently on screen. Clicking, dragging or arrowing inside it
 * centres the stage on that spot, so a solver can reach a corner of the board
 * without panning blindly.
 *
 * Plain SVG rather than a second Konva stage: there is no bitmap to draw, and a
 * `viewBox` of the stage rectangle means every coordinate here is a *stage*
 * coordinate — the browser does the scaling, and none of the drawing has to
 * repeat the geometry the board already owns.
 */
export default function BoardMinimap({
  store,
  stageW,
  stageH,
  groups,
  rectOf,
  onJump,
}: {
  store: ViewStore;
  stageW: number;
  stageH: number;
  /** Back to front, as the board draws them — largest groups first. */
  groups: PieceGroup[];
  rectOf: (id: string) => Rect | undefined;
  /** Centre the stage on this stage coordinate. */
  onJump: (centre: { x: number; y: number }) => void;
}) {
  const t = useTranslations("solve");
  const view = useSyncExternalStore(store.subscribe, store.get, store.get);
  const panning = useRef(false);

  const size = useMemo(() => minimapSize(stageW, stageH, MAX_W, MAX_H), [stageW, stageH]);

  // Memoised as elements, not just as data: panning re-renders this component
  // on every frame, and an unchanged element lets React skip the whole subtree
  // instead of diffing one rect per piece each time.
  const markers = useMemo(
    () => (
      <g>
        {groupMarkers(groups, rectOf, size.scale > 0 ? MIN_MARKER / size.scale : 0).map((m) => (
          <rect
            key={m.id}
            className={m.count > 1 ? "marker joined" : "marker"}
            x={m.x}
            y={m.y}
            width={m.width}
            height={m.height}
          />
        ))}
      </g>
    ),
    [groups, rectOf, size.scale],
  );

  const centre = useCallback(
    (point: { x: number; y: number }) => {
      // Clamped here as well as in `stagePositionFor`, so a drag that leaves the
      // thumbnail keeps sliding along its edge instead of jumping.
      onJump({
        x: Math.min(stageW, Math.max(0, point.x)),
        y: Math.min(stageH, Math.max(0, point.y)),
      });
    },
    [onJump, stageW, stageH],
  );

  /** Where a pointer is, in stage coordinates. */
  const jumpToPointer = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const box = e.currentTarget.getBoundingClientRect();
      if (!box.width || !box.height) return;
      centre({
        x: ((e.clientX - box.left) / box.width) * stageW,
        y: ((e.clientY - box.top) / box.height) * stageH,
      });
    },
    [centre, stageW, stageH],
  );

  function handleKeyDown(e: React.KeyboardEvent<SVGSVGElement>) {
    const step = ARROWS[e.key];
    if (!step) return;
    e.preventDefault();
    const visible = visibleRect(view, stageW, stageH);
    centre({
      x: visible.x + visible.width * (0.5 + step[0] * PAN_STEP),
      y: visible.y + visible.height * (0.5 + step[1] * PAN_STEP),
    });
  }

  if (size.scale === 0) return null;

  const visible = visibleRect(view, stageW, stageH);

  return (
    <svg
      className="minimap"
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${stageW} ${stageH}`}
      // Focusable and arrow-key pannable: the board has no other keyboard way to
      // move the view, so a pointer-only overview would make the corners of a
      // zoomed-in board unreachable without a mouse.
      tabIndex={0}
      role="img"
      aria-label={t("minimap")}
      onKeyDown={handleKeyDown}
      onPointerDown={(e) => {
        e.preventDefault();
        panning.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        jumpToPointer(e);
      }}
      onPointerMove={(e) => {
        if (panning.current) jumpToPointer(e);
      }}
      onPointerUp={(e) => {
        panning.current = false;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onPointerCancel={() => {
        panning.current = false;
      }}
      // Only reachable when the pointer was never captured; with capture the
      // element keeps receiving moves and this stays silent until release.
      onPointerLeave={() => {
        panning.current = false;
      }}
    >
      {markers}
      <rect
        className="viewport"
        x={visible.x}
        y={visible.y}
        width={visible.width}
        height={visible.height}
        // The viewBox scales the stage down by up to 6×; without this the
        // indicator's outline would be a fraction of a pixel wide.
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
